/**
 * POST /api/workspaces/import: the archive is checked before a workspace exists, the workspace is
 * listed only once the import is done, and a failed import, or one a stopped node left, leaves none behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  provisionWorkspace: vi.fn(),
  deleteWorkspaceCascade: vi.fn(),
  getWorkspace: vi.fn(),
  finishWorkspaceImport: vi.fn(),
  listUnfinishedImports: vi.fn(),
}));
vi.mock("../archive/import.js", async (orig) => ({
  ...(await orig<typeof import("../archive/import.js")>()),
  importWorkspaceArchive: vi.fn(),
}));

const { provisionWorkspace, deleteWorkspaceCascade, getWorkspace, finishWorkspaceImport, listUnfinishedImports } = await import("@stuga/db");
const { ImportStepError, importWorkspaceArchive } = await import("../archive/import.js");
const { checkWorkspaceImport, discardHeldImport, importHeldWorkspace, importWorkspace, purgeUnfinishedImports } = await import("./workspaces.js");
const { HELD_IMPORT_TTL_MS, sweepHeldImports } = await import("../archive/held.js");
const { archiveWorkUnderWay, holdArchiveWork } = await import("../archive/under-way.js");
const { APP_ROUTES } = await import("../http/routes.js");
const { matchRoute } = await import("../http/router.js");
const { readsOwnBody } = await import("../http/dispatch.js");
import { WORKSPACE_IMPORT_MAX_BYTES } from "@stuga/protocol/domain/workspaces";
import { zipFiles, type ZipFile } from "../lib/zip.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";
import type { AccountCtx } from "../auth/context.js";
import { MemoryBlobStore } from "@stuga/runtime/testing";

const mockProvision = provisionWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockCascade = deleteWorkspaceCascade as unknown as ReturnType<typeof vi.fn>;
const mockGetWorkspace = getWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockImport = importWorkspaceArchive as unknown as ReturnType<typeof vi.fn>;
const mockFinish = finishWorkspaceImport as unknown as ReturnType<typeof vi.fn>;
const mockUnfinished = listUnfinishedImports as unknown as ReturnType<typeof vi.fn>;

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** An archive of one document, and `extra` files beside what its manifest names. */
function archive(start = true, extra: ZipFile[] = []): Uint8Array {
  const manifest = {
    format: "stuga-workspace",
    version: 1,
    generator: "stuga test",
    exported_at: "2026-09-25T10:00:00Z",
    workspace: { name: "Team handbook", agent_instructions: "" },
    ...(start ? { start: "Start here.md" } : {}),
    items: [
      {
        kind: "doc",
        path: "Start here.md",
        parent: null,
        title: "Start here",
        title_source: "heading",
        agent_mode: "review",
        locked: false,
        search_hidden: false,
        agent_instructions: "",
      },
    ],
  };
  return zipFiles(
    [
      { name: "stuga.json", data: text(JSON.stringify(manifest)) },
      { name: "Start here.md", data: text("# Start here\n") },
      ...extra,
    ],
    "deflate",
  );
}

const jobs: Array<Record<string, unknown>> = [];
let snapshots: MemoryBlobStore;
let actorCalls: string[];
let mediaPrefixes: string[];

function ctxOf(alias = "u_liv"): AccountCtx {
  const ns = () => ({ get: () => ({ fetch: async (url: string) => (actorCalls.push(url), new Response("{}")) }) });
  return {
    sql: {},
    surface: "web",
    alias,
    displayName: "Liv",
    isAgent: false,
    requestId: "req-1",
    env: {
      sql: {},
      settings: { current: () => ({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES }) },
      snapshots,
      jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) },
      docs: ns(),
      databases: ns(),
      media: {
        list: async ({ prefix }: { prefix: string }) => (mediaPrefixes.push(prefix), { objects: [], truncated: false }),
        delete: async () => {},
      },
    },
  } as unknown as AccountCtx;
}

async function post(body: Uint8Array, query = "", alias = "u_liv"): Promise<Response> {
  const path = `/api/workspaces/import${query}`;
  const req = new Request(`https://node.test${path}`, { method: "POST", headers: { "content-type": "application/zip" }, body: body as Uint8Array<ArrayBuffer> });
  return importWorkspace({ ctx: ctxOf(alias), req, url: new URL(req.url), match: ["/api/workspaces/import"] });
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.length = 0;
  snapshots = new MemoryBlobStore();
  actorCalls = [];
  mediaPrefixes = [];
  mockProvision.mockImplementation(async (_sql: unknown, input: { workspaceId: string; name: string; defaultDocAccess?: string }) => ({
    workspace_id: input.workspaceId,
    name: input.name,
    default_doc_access: input.defaultDocAccess ?? "workspace_edit",
    agent_instructions: "",
    created_at: "2026-01-01T00:00:00.000Z",
  }));
  mockCascade.mockResolvedValue({ docs: [{ doc_id: "d1", doc_type: "prose" }] });
  mockGetWorkspace.mockResolvedValue(null);
  mockImport.mockResolvedValue({ ids: {}, startDocId: "d1", counts: { folders: 0, docs: 1, databases: 0, pages: 0, rows: 0, images: 0, comments: 0 } });
  mockFinish.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/workspaces/import", () => {
  it("creates the workspace, imports into it as its owner, and answers as a create does plus the document to open", async () => {
    // As the import left it: with the archive's instructions.
    mockGetWorkspace.mockImplementation(async (_sql: unknown, id: string) => ({
      workspace_id: id,
      name: "Handbook",
      default_doc_access: "private",
      agent_instructions: "Answer with citations.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const res = await post(archive(), "?name=%20Handbook%20&default_doc_access=private");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agent_instructions", "created_at", "default_doc_access", "imported", "name", "role", "start_doc_id", "workspace_id"]);
    expect(body).toMatchObject({ name: "Handbook", role: "owner", default_doc_access: "private", start_doc_id: "d1", agent_instructions: "Answer with citations." });
    // Marked in the transaction that makes it, so no list shows it until the import is done.
    expect(mockProvision.mock.calls[0]![1]).toMatchObject({ name: "Handbook", owner: "u_liv", defaultDocAccess: "private", importing: true });
    expect(mockFinish).toHaveBeenCalledWith(expect.anything(), body.workspace_id);
    expect(mockFinish.mock.invocationCallOrder[0]).toBeGreaterThan(mockImport.mock.invocationCallOrder[0]!);
    const [ctx, workspaceId, contents] = mockImport.mock.calls[0]!;
    expect((ctx as AccountCtx).alias).toBe("u_liv");
    expect(workspaceId).toBe(body.workspace_id);
    expect((contents as { manifest: { start: string } }).manifest.start).toBe("Start here.md");
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([
      expect.objectContaining({ workspaceId: body.workspace_id, action: "workspace.import", targetLabel: "Handbook", detail: expect.objectContaining({ docs: 1 }) }),
    ]);
    expect(mockCascade).not.toHaveBeenCalled();
  });

  it("takes the archive's name when none is given, and names no document to open when the archive names none", async () => {
    mockImport.mockResolvedValue({ ids: {}, startDocId: null, counts: {} });
    const res = await post(archive(false));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("Team handbook");
    expect("start_doc_id" in body).toBe(false);
    expect(mockProvision.mock.calls[0]![1].defaultDocAccess).toBeUndefined();
  });

  it("refuses an archive it cannot read, saying why, before any workspace exists", async () => {
    const res = await post(text("not a zip"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^cannot import this archive: .*not a zip archive/);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("takes a file past the node's upload limit, reading its own body to the import's cap instead", async () => {
    const tooLarge = new Request("https://node.test/api/workspaces/import", {
      method: "POST",
      headers: { "content-length": String(WORKSPACE_IMPORT_MAX_BYTES + 1) },
      body: new ReadableStream({ pull: () => {} }),
      duplex: "half",
    } as RequestInit);
    const res = await importWorkspace({ ctx: ctxOf(), req: tooLarge, url: new URL(tooLarge.url), match: ["/api/workspaces/import"] });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("this file is larger than 512 MB, the most an import takes");
    // Random bytes, which deflate cannot shrink below the upload limit.
    const noise = new Uint8Array(DEFAULT_MAX_BODY_BYTES + 1).map(() => Math.floor(Math.random() * 256));
    const padded = archive(true, [{ name: "noise.bin", data: noise }]);
    expect(padded.byteLength).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES);
    expect((await post(padded)).status).toBe(201);
    expect(mockProvision).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown default access and an empty body, before reading anything", async () => {
    expect((await post(archive(), "?default_doc_access=public")).status).toBe(400);
    expect((await post(new Uint8Array())).status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("deletes the workspace again when a write fails, and answers without the detail, which goes to the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockImport.mockRejectedValue(new ImportStepError("Laws/GDPR.md", new Error("the actor is gone")));
    const res = await post(archive());
    expect(res.status).toBe(500);
    const answer = JSON.stringify(await res.json());
    expect(answer).not.toContain("actor");
    const workspaceId = mockProvision.mock.calls[0]![1].workspaceId as string;
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), workspaceId);
    expect(actorCalls).toEqual(["http://actor/destroy?docId=d1"]);
    expect(mediaPrefixes).toEqual([`media/${workspaceId}/`]);
    expect(logged).toHaveBeenCalledWith("workspace import failed", expect.objectContaining({ workspaceId, step: "Laws/GDPR.md", error: "Laws/GDPR.md: the actor is gone" }));
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([]);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("deletes the workspace again when its import cannot be marked done, since it would be deleted at the next start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFinish.mockRejectedValue(new Error("connection lost"));
    const res = await post(archive());
    expect(res.status).toBe(500);
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), mockProvision.mock.calls[0]![1].workspaceId);
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([]);
  });

  it("runs one import per person and three on the node, and takes the next once one is done", async () => {
    const finish: Array<() => void> = [];
    mockImport.mockImplementation(() => new Promise((resolve) => finish.push(() => resolve({ ids: {}, startDocId: null, counts: {} }))));
    const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
    const first = post(archive());
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    // A backup waits while any is under way.
    expect(archiveWorkUnderWay()).toBe(true);
    const again = await post(archive());
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe("you are already importing a workspace; try again when it is done");

    // Someone else's import is not held up by Liv's.
    const others = [post(archive(), "", "u_ada"), post(archive(), "", "u_bo")];
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(3));
    const fourth = await post(archive(), "", "u_cy");
    expect(fourth.status).toBe(409);
    expect(await errorOf(fourth)).toBe("other workspaces are being imported on this node; try again when one is done");
    expect(mockProvision).toHaveBeenCalledTimes(3);

    finish.shift()!();
    expect((await first).status).toBe(201);
    const next = post(archive(), "", "u_cy");
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(4));
    for (const done of finish) done();
    expect((await Promise.all([...others, next])).map((r) => r.status)).toEqual([201, 201, 201]);
    expect(archiveWorkUnderWay()).toBe(false);
  });

  it("starts none while a backup waits for the imports and exports under way", async () => {
    holdArchiveWork(true);
    try {
      const res = await post(archive());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "the node is waiting to back up; try again once it has" });
      expect(mockProvision).not.toHaveBeenCalled();
      expect(archiveWorkUnderWay()).toBe(false);
    } finally {
      holdArchiveWork(false);
    }
    expect((await post(archive())).status).toBe(201);
  });

  it("stops an import still writing after 50 minutes, before the web app gives up waiting, and deletes its workspace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal!: AbortSignal;
    mockImport.mockImplementation(
      (_ctx: unknown, _id: unknown, _contents: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = opts.signal;
          signal.addEventListener("abort", () => reject(new ImportStepError("Start here.md", signal.reason)));
        }),
    );
    const answer = post(archive());
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50 * 60_000 - 1_000);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await answer;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the import did not finish within 50 minutes, so the workspace was not created" });
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), mockProvision.mock.calls[0]![1].workspaceId);
    expect(mockFinish).not.toHaveBeenCalled();
    // Its place is free again.
    mockImport.mockResolvedValue({ ids: {}, startDocId: null, counts: {} });
    expect((await post(archive())).status).toBe(201);
  });

  it("is a person's call on their account, before any workspace is theirs", () => {
    const found = matchRoute(APP_ROUTES, "POST", "/api/workspaces/import");
    expect(found?.route).toMatchObject({ auth: "account", humanOnly: expect.any(String), ownBody: true, handler: importWorkspace });
    // The listener leaves this body, and only this one, to its route.
    expect(readsOwnBody("POST", "/api/workspaces/import")).toBe(true);
    expect(readsOwnBody("POST", "/api/workspaces")).toBe(false);
    expect(readsOwnBody("GET", "/api/workspaces/import")).toBe(false);
  });
});

describe("importing a file held after its check", () => {
  const call = (handler: typeof checkWorkspaceImport, path: string, init: RequestInit, alias = "u_liv") => {
    const req = new Request(`https://node.test${path}`, init);
    return handler({ ctx: ctxOf(alias), req, url: new URL(req.url), match: [path, path.split("/").pop()!] });
  };
  const check = (body: Uint8Array, alias = "u_liv") => call(checkWorkspaceImport, "/api/workspace-imports", { method: "POST", body: body as Uint8Array<ArrayBuffer> }, alias);
  const confirm = (id: string, body: Record<string, unknown> = {}, alias = "u_liv") =>
    call(importHeldWorkspace, `/api/workspace-imports/${id}`, { method: "POST", body: JSON.stringify(body) }, alias);
  const vault = zipFiles(
    [
      { name: "Vault/Note.md", data: text("Hello") },
      { name: "Vault/Slides.pdf", data: text("%PDF-1.7") },
    ],
    "deflate",
  );

  it("says what a file would leave out and holds it, making nothing, then imports what it holds on the go-ahead", async () => {
    const res = await check(vault);
    expect(res.status).toBe(201);
    const held = (await res.json()) as { import_id: string; name: string; expires_at: string; left_out: unknown };
    expect(held).toMatchObject({ name: "Vault", left_out: { count: 1, files: [{ path: "Slides.pdf", reason: "not_linked" }] } });
    expect(mockProvision).not.toHaveBeenCalled();
    expect(snapshots.objects.size).toBe(1);

    const made = await confirm(held.import_id, { name: "Notes", default_doc_access: "private" });
    expect(made.status).toBe(201);
    // The answer says what came in, and again what was left out, for the summary that ends an import.
    expect(await made.json()).toMatchObject({ imported: expect.objectContaining({ docs: 1 }), left_out: { count: 1, files: [{ path: "Slides.pdf", reason: "not_linked" }] } });
    expect(mockProvision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "Notes", defaultDocAccess: "private", owner: "u_liv" }));
    expect(snapshots.objects.size).toBe(0);
    expect((await confirm(held.import_id)).status).toBe(404);
  });

  it("holds one file a person, only for them, and lets it go when they cancel", async () => {
    const first = ((await (await check(archive())).json()) as { import_id: string }).import_id;
    const second = ((await (await check(vault)).json()) as { import_id: string }).import_id;
    expect(snapshots.objects.size).toBe(1);
    expect((await confirm(first)).status).toBe(404);
    expect((await confirm(second, {}, "u_sam")).status).toBe(404);
    const gone = await call(discardHeldImport, `/api/workspace-imports/${second}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(snapshots.objects.size).toBe(0);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("refuses a file it cannot import before holding it, and sweeps a held one once it expires", async () => {
    expect((await check(text("not a zip"))).status).toBe(400);
    expect(snapshots.objects.size).toBe(0);
    await check(vault);
    expect(await sweepHeldImports({ snapshots } as never, Date.now())).toBe(0);
    expect(await sweepHeldImports({ snapshots } as never, Date.now() + HELD_IMPORT_TTL_MS + 1)).toBe(1);
    expect(snapshots.objects.size).toBe(0);
  });
});

describe("purgeUnfinishedImports", () => {
  it("deletes each workspace an import left when the node stopped, logging each, and goes on past one it cannot delete", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUnfinished.mockResolvedValue([
      { workspace_id: "ws-a", name: "Handbook", import_started_at: new Date("2026-09-25T10:00:00Z") },
      { workspace_id: "ws-b", name: "Privacy laws", import_started_at: new Date("2026-09-25T11:00:00Z") },
    ]);
    mockCascade.mockRejectedValueOnce(new Error("connection lost"));
    await purgeUnfinishedImports(ctxOf().env);
    expect(mockCascade.mock.calls.map((c) => c[1])).toEqual(["ws-a", "ws-b"]);
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      '[node] deleting workspace ws-a ("Handbook"): its import, started 2026-09-25T10:00:00.000Z, stopped when the node did',
      '[node] deleting workspace ws-b ("Privacy laws"): its import, started 2026-09-25T11:00:00.000Z, stopped when the node did',
    ]);
    expect(logged).toHaveBeenCalledWith("[node] could not delete the workspace an unfinished import left", { workspaceId: "ws-a", error: "connection lost" });
    // The one it could delete took its documents' actors and media with it.
    expect(actorCalls).toEqual(["http://actor/destroy?docId=d1"]);
    expect(mediaPrefixes).toEqual(["media/ws-b/"]);
  });
});
