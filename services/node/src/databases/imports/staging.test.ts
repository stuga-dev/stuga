import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({
  getDoc: vi.fn(),
  touchDoc: vi.fn(async () => {}),
  createDoc: vi.fn(),
  deleteDoc: vi.fn(async () => {}),
  getWorkspace: vi.fn(async () => ({ default_doc_access: "workspace_edit" })),
  getMemberRole: vi.fn(async () => "member"),
  getFolderAncestors: vi.fn(async () => []),
}));
vi.mock("@stuga/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/auth")>()),
  materializeAcl: vi.fn(() => ({
    principals: ["user:owner-1", "org:ws1"],
    writers: ["user:owner-1", "org:ws1"],
    commenters: [],
  })),
}));

const { getDoc, createDoc } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
const { handleDatabaseImportUpload, importPageUrl, sweepExpiredImports } = await import("./staging.js");
import type { Ctx } from "../../auth/context.js";
import type { BlobHead, BlobObject, BlobStore } from "@stuga/runtime";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockCreateDoc = createDoc as unknown as ReturnType<typeof vi.fn>;

const DB_DOC = {
  doc_id: "db1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Bookings",
  doc_type: "database",
  trashed: false,
  locked: false,
  acl_principals: ["user:owner-1", "user:bob", "user:viv", "agent:agent-1", "org:ws1"],
  acl_writers: ["user:owner-1", "user:bob", "agent:agent-1"],
};

const SCHEMA = {
  database_id: "db1",
  tables: [
    {
      table_id: "tbl_1",
      name: "bookings",
      display: "Bookings",
      position: 0,
      row_count: 0,
      columns: [
        { column_id: "col_ref", name: "booking_ref", display: "Booking Ref", type: "text", position: 0, options: null },
        { column_id: "col_rate", name: "nightly_rate", display: "Nightly Rate", type: "number", position: 1, options: null },
        { column_id: "col_status", name: "status", display: "Status", type: "single_select", position: 2, options: { choices: ["Confirmed", "Cancelled"] } },
      ],
    },
  ],
};

const RUN = { id: "run_1", database_id: "db1", ops: [{ id: "o1", kind: "rows.insert", summary: "x", status: "pending" }] };

/** An in-memory BlobStore: the snapshots store the import keys live in. */
function memoryBlobs(): BlobStore & { keys: () => string[] } {
  const store = new Map<string, Uint8Array>();
  const head = (key: string): BlobHead => ({ key, size: store.get(key)!.byteLength, uploaded: new Date() });
  return {
    keys: () => [...store.keys()].sort(),
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      const obj: BlobObject = {
        ...head(key),
        body: new Blob([v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer]).stream() as ReadableStream<Uint8Array>,
        arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
        text: async () => new TextDecoder().decode(v),
      };
      return obj;
    },
    async head(key) {
      return store.has(key) ? head(key) : null;
    },
    async put(key, value) {
      store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer));
    },
    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
    async list(opts) {
      const keys = [...store.keys()]
        .filter((k) => (!opts?.prefix || k.startsWith(opts.prefix)) && (!opts?.cursor || k > opts.cursor))
        .sort();
      const page = keys.slice(0, opts?.limit ?? keys.length);
      const objects = page.map(head);
      return page.length < keys.length ? { objects, truncated: true, cursor: page[page.length - 1]! } : { objects, truncated: false };
    },
  };
}

let blobs = memoryBlobs();
const actorCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
let actorOverride: { path: string; status: number; body: unknown } | null = null;
const actorFetch = vi.fn(async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  actorCalls.push({ path, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {} });
  if (actorOverride && path === actorOverride.path) {
    return new Response(JSON.stringify(actorOverride.body), { status: actorOverride.status });
  }
  const canned: Record<string, unknown> = {
    "/schema": SCHEMA,
    "/schema/init": { initialized: true, schema: SCHEMA },
    "/rows/insert": { inserted: 2, row_ids: ["row_a", "row_b"] },
    "/tables/create": { table: SCHEMA.tables[0] },
    "/runs/propose": { mode: "proposed", run: RUN, pending: 1, minted: { table_id: "tbl_new", column_id: "col_new", row_ids: ["row_a", "row_b"] } },
  };
  return new Response(JSON.stringify(canned[path] ?? {}), { status: 200 });
});

const env = () => ({
  databases: { get: () => ({ fetch: actorFetch }) },
  docs: { get: () => ({ fetch: actorFetch }) },
  settings: { current: () => ({ databaseOpsKeep: 500, maxBodyBytes: 10 * 1024 * 1024 }) },
  snapshots: blobs,
  internalSecret: "top-secret",
  publicOrigin: "https://stuga.test",
  jobs: { send: vi.fn(async () => {}) },
});

function ctxOf(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "bob",
    displayName: "Bob",
    isAgent: false,
    principals: ["user:bob"],
    workspaceId: "ws1",
    role: "member",
    env: env(),
    ...overrides,
  } as unknown as Ctx;
}
const viewer = () => ctxOf({ alias: "viv", principals: ["user:viv"] });
const agent = () => ctxOf({ alias: "agent-1", displayName: "Codey", isAgent: true, onBehalfOf: "owner-1", principals: ["agent:agent-1"] });

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

async function stage(ctx: Ctx, format = "csv") {
  const res = await call(ctx, "POST", "/api/databases/db1/imports", { table_id: "tbl_1", format });
  expect(res.status).toBe(201);
  return (await res.json()) as { import_id: string; upload_path: string; upload_url: string; review: string; max_bytes: number; import_page_url: string };
}

async function upload(path: string, text: string): Promise<Response> {
  const url = new URL(`https://node.test${path}`);
  const [, docId, importId] = /\/api\/databases\/([^/]+)\/imports\/([^/]+)\/upload/.exec(url.pathname)!;
  return handleDatabaseImportUpload(
    env() as never,
    new Request(url, { method: "PUT", body: text }),
    docId!,
    importId!,
    url.searchParams.get("sig"),
  );
}

const CSV = "Booking Ref,nightly_rate,Status,_id\nB1,120,Confirmed,x\nB2,\"1,050\",cancelled,y\n";

beforeEach(() => {
  blobs = memoryBlobs();
  actorCalls.length = 0;
  actorOverride = null;
  actorFetch.mockClear();
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DB_DOC });
  mockCreateDoc.mockReset();
});

describe("the import page link", () => {
  it("always names the table, so the link cannot change meaning when a second one appears", () => {
    expect(importPageUrl("https://stuga.test", "db1", "tbl_1")).toBe("https://stuga.test/doc/db1?table=tbl_1&import");
    expect(importPageUrl("https://stuga.test", "db1", "tbl 2")).toBe("https://stuga.test/doc/db1?table=tbl%202&import");
  });
});

describe("staging", () => {
  it("is write-gated, names the table, and signs a same-origin upload URL", async () => {
    expect((await call(viewer(), "POST", "/api/databases/db1/imports", { table_id: "tbl_1" })).status).toBe(403);
    expect((await call(ctxOf(), "POST", "/api/databases/db1/imports", { table_id: "nope" })).status).toBe(404);
    expect((await call(ctxOf(), "POST", "/api/databases/db1/imports", { table_id: "tbl_1", format: "xlsx" })).status).toBe(400);
    const t = await stage(ctxOf());
    expect(t.import_id).toMatch(/^imp_/);
    expect(t.upload_url).toBe(`https://stuga.test${t.upload_path}`);
    expect(t.upload_path).toMatch(new RegExp(`^/api/databases/db1/imports/${t.import_id}/upload\\?sig=[0-9a-f]{64}$`));
    expect(t.review).toBe("direct");
    expect(t.max_bytes).toBe(10 * 1024 * 1024);
    expect(t.import_page_url).toBe("https://stuga.test/doc/db1?table=tbl_1&import");
    expect(blobs.keys()).toEqual([`db-imports/db1/${t.import_id}.meta`]);
  });

  it("tells an agent how its commit will land", async () => {
    expect((await stage(agent())).review).toBe("review");
  });
});

describe("the upload", () => {
  it("accepts exactly one PUT with a valid signature, and nothing else", async () => {
    const t = await stage(ctxOf());
    const forged = t.upload_path.replace(/sig=.*/, `sig=${"0".repeat(64)}`);
    expect((await upload(forged, CSV)).status).toBe(403);
    expect((await upload(t.upload_path.replace("db1", "db2"), CSV)).status).toBe(403);
    expect((await upload(t.upload_path, "")).status).toBe(400);
    const ok = await upload(t.upload_path, CSV);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ import_id: t.import_id, bytes: CSV.length });
    expect((await upload(t.upload_path, CSV)).status).toBe(409);
  });
});

describe("housekeeping", () => {
  it("sweeps expired stagings of every database in one pass, across listing pages, and keeps live ones", async () => {
    const t = await stage(ctxOf());
    const dead = "imp_1_000000000000000000"; // expiry epoch 1
    for (const db of ["db1", "db2"]) {
      for (const part of ["meta", "body", "done"]) await blobs.put(`db-imports/${db}/${dead}.${part}`, "x");
    }
    for (let i = 0; i < 1500; i++) await blobs.put(`db-imports/db3/imp_1_${String(i).padStart(18, "0")}.meta`, "x");
    await blobs.put("db1/7.bin", "snapshot");
    expect(await sweepExpiredImports({ snapshots: blobs }, Date.now())).toBe(1506);
    expect(blobs.keys()).toEqual(["db-imports/db1/" + t.import_id + ".meta", "db1/7.bin"].sort());
  });
});

describe("the commit", () => {
  it("validates the whole file, coerces cells, drops bookkeeping headers, and lands ONE flagged insert", async () => {
    const t = await stage(ctxOf());
    expect((await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {})).status).toBe(409);
    await upload(t.upload_path, CSV);
    const res = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ import_id: t.import_id, mode: "applied", rows_total: 2, rows_ingested: 2, rows_skipped: 0, errors: [], ignored_columns: ["_id"] });
    const insert = actorCalls.find((c) => c.path === "/rows/insert")!;
    expect(insert.body).toMatchObject({
      table_id: "tbl_1",
      import: true,
      rows: [
        { col_ref: "B1", col_rate: 120, col_status: "Confirmed" },
        { col_ref: "B2", col_rate: 1050, col_status: "Cancelled" },
      ],
    });
    // The staging is consumed; the marker answers a replay.
    expect(blobs.keys()).toEqual([`db-imports/db1/${t.import_id}.done`]);
    const again = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ already_applied: true, rows_ingested: 2 });
    expect(actorCalls.filter((c) => c.path === "/rows/insert")).toHaveLength(1);
  });

  it("refuses bad rows with a row-level report and touches nothing, unless told to skip them", async () => {
    const t = await stage(ctxOf());
    await upload(t.upload_path, "Booking Ref,nightly_rate,Status\nB1,120,Confirmed\nB2,n/a,Checked-Out\n");
    const res = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "import_validation_failed", rows_total: 2, rows_failed: 1, errors_truncated: false });
    expect(body.errors).toEqual([
      expect.objectContaining({ row: 2, column: "nightly_rate", value: "n/a", code: "invalid_number", message: "not a number" }),
      expect.objectContaining({ row: 2, column: "Status", value: "Checked-Out", code: "invalid_choice" }),
    ]);
    expect(actorCalls.some((c) => c.path === "/rows/insert")).toBe(false);
    // Still staged: a corrected commit can proceed without a new upload.
    const skip = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, { on_error: "skip_bad_rows", max_bad_rows: 5 });
    expect(skip.status).toBe(200);
    expect(await skip.json()).toMatchObject({ rows_total: 2, rows_ingested: 1, rows_skipped: 1 });
    expect(actorCalls.find((c) => c.path === "/rows/insert")!.body.rows).toEqual([{ col_ref: "B1", col_rate: 120, col_status: "Confirmed" }]);
  });

  it("refuses unmapped headers instead of dropping them, and honours column_map", async () => {
    const t = await stage(ctxOf());
    await upload(t.upload_path, "ref,rate\nB1,10\n");
    const res = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string; column: string }> };
    expect(body.errors.map((e) => [e.code, e.column])).toEqual([
      ["unknown_column", "ref"],
      ["unknown_column", "rate"],
    ]);
    const mapped = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, { column_map: { ref: "booking_ref", rate: null } });
    expect(mapped.status).toBe(200);
    expect(await mapped.json()).toMatchObject({ rows_ingested: 1, ignored_columns: ["rate"] });
  });

  it("dry_run reports the verdict, writes nothing, and keeps the staging for the real commit", async () => {
    const t = await stage(ctxOf());
    await upload(t.upload_path, "Booking Ref,nightly_rate,Status,_id\nB1,120,Confirmed,x\nB2,n/a,Cancelled,y\n");
    const res = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, { dry_run: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dry_run: true,
      import_id: t.import_id,
      rows_total: 2,
      rows_ready: 1,
      rows_failed: 1,
      matched_columns: ["Booking Ref", "Nightly Rate", "Status"],
      ignored_columns: ["_id"],
      errors: [expect.objectContaining({ row: 2, column: "nightly_rate", code: "invalid_number" })],
    });
    expect(actorCalls.some((c) => c.path === "/rows/insert")).toBe(false);
    expect(blobs.keys()).toContain(`db-imports/db1/${t.import_id}.body`);
    // Header trouble is a verdict too, not a refusal.
    const t2 = await stage(ctxOf());
    await upload(t2.upload_path, "nope\n1\n");
    const bad = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t2.import_id}/commit`, { dry_run: true });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({ rows_ready: 0, rows_failed: 1, matched_columns: [], errors: [expect.objectContaining({ row: 0, code: "unknown_column" })] });
    // The real commit then lands the row that passed.
    const done = await call(ctxOf(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, { on_error: "skip_bad_rows" });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ rows_ingested: 1, rows_skipped: 1 });
  });

  it("proposes an agent's import through the run ledger with the flag set", async () => {
    const t = await stage(agent());
    await upload(t.upload_path, CSV);
    const res = await call(agent(), "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "proposed", rows_ingested: 2, pending: 1, run: { id: "run_1" } });
    const propose = actorCalls.find((c) => c.path === "/runs/propose")!;
    expect(propose.body.source).toBe("stdio");
    expect(propose.body.op).toMatchObject({ kind: "rows.insert", table: "tbl_1", import: true });
    expect((propose.body.op as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it("only the credential that staged an import may commit it", async () => {
    const t = await stage(ctxOf());
    await upload(t.upload_path, CSV);
    const other = ctxOf({ alias: "owner-1", principals: ["user:owner-1"] });
    expect((await call(other, "POST", `/api/databases/db1/imports/${t.import_id}/commit`, {})).status).toBe(403);
    expect((await call(ctxOf(), "POST", `/api/databases/db1/imports/imp_zz_000000000000000000/commit`, {})).status).toBe(404);
  });
});

describe("declarative tables", () => {
  const columns = [
    { name: "Guest", type: "text" },
    { name: "Tier", type: "single_select", choices: ["Gold", "Silver"] },
  ];

  it("shape-checks the columns before anything is proposed", async () => {
    const res = await call(agent(), "POST", "/api/databases/db1/tables", { display: "Guests", columns: [{ name: "Tier", type: "single_select" }] });
    expect(res.status).toBe(400);
    expect(actorCalls.some((c) => c.path === "/runs/propose")).toBe(false);
  });

  it("fans an agent's create out to one run of table + columns, minting every id", async () => {
    const res = await call(agent(), "POST", "/api/databases/db1/tables", { display: "Guests", columns });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "proposed", minted: { table_id: "tbl_new", column_ids: ["col_new", "col_new"] } });
    const ops = actorCalls.filter((c) => c.path === "/runs/propose").map((c) => c.body.op as Record<string, unknown>);
    expect(ops).toEqual([
      { kind: "tables.create", display: "Guests" },
      { kind: "columns.add", table: "tbl_new", display: "Guest", type: "text", choices: undefined },
      { kind: "columns.add", table: "tbl_new", display: "Tier", type: "single_select", choices: ["Gold", "Silver"] },
    ]);
  });

  it("hands a person's create to the actor in one call", async () => {
    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables", { display: "Guests", columns });
    expect(res.status).toBe(200);
    const create = actorCalls.find((c) => c.path === "/tables/create")!;
    expect(create.body).toMatchObject({ display: "Guests", columns: [{ display: "Guest", type: "text" }, { display: "Tier", type: "single_select", choices: ["Gold", "Silver"] }] });
  });

  it("creates a database born with the named table and columns", async () => {
    mockCreateDoc.mockResolvedValue({ ...DB_DOC, doc_id: "db-new" });
    const res = await call(ctxOf(), "POST", "/api/docs", { title: "Hotel", doc_type: "database", table: "Bookings", columns });
    expect(res.status).toBe(201);
    const init = actorCalls.find((c) => c.path === "/schema/init")!;
    expect(init.body).toMatchObject({ display: "Bookings", columns: [{ display: "Guest", type: "text" }, { display: "Tier", type: "single_select", choices: ["Gold", "Silver"] }] });
    expect((await call(ctxOf(), "POST", "/api/docs", { title: "Prose", columns })).status).toBe(400);
  });
});
