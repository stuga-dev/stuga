/** Workspace export against a scripted workspace: what is read, where it lands, and how bodies and names are rewritten. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentRow, DocRow, FolderRow } from "@stuga/db";
import type { DatabaseSchema, RowRecord } from "@stuga/protocol/databases/types";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(),
  listFolders: vi.fn(),
  getFolderAncestors: vi.fn(),
  listExportDocs: vi.fn(),
  getDoc: vi.fn(),
  listComments: vi.fn(),
  listDocsWithCommentsOver: vi.fn(),
  getUsers: vi.fn(),
  resolveHumanAuth: vi.fn(),
}));

/** Caps a test lowers, so it can pass them with bodies of a few KiB; 0 keeps the archive's own. */
const caps = vi.hoisted(() => ({ body: 0, unpacked: 0 }));
vi.mock("./format.js", async (orig) => {
  const real = await orig<typeof import("./format.js")>();
  return {
    ...real,
    get ARCHIVE_MAX_BODY_BYTES() {
      return caps.body || real.ARCHIVE_MAX_BODY_BYTES;
    },
    get ARCHIVE_MAX_UNPACKED_BYTES() {
      return caps.unpacked || real.ARCHIVE_MAX_UNPACKED_BYTES;
    },
  };
});

const db = await import("@stuga/db");
const { ExportRefused, planWorkspaceExport, writeWorkspaceExport } = await import("./export.js");
const { openZip } = await import("../lib/zip.js");
const { parseManifest, parseTableRows } = await import("./format.js");
const { checkArchive } = await import("./check.js");
const { readArchive } = await import("./import.js");
const { LIMITS } = await import("./testing/fixture.js");
import type { Ctx } from "../auth/context.js";
import type { ArchiveDatabase, ArchiveDoc, ArchiveManifest } from "./format.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_HASH = createHash("sha256").update(PNG).digest("hex");
const MISSING_HASH = "0".repeat(64);

function doc(doc_id: string, patch: Partial<DocRow> = {}): DocRow {
  return {
    doc_id,
    workspace_id: "ws1",
    owner: "user:u_liv",
    title: doc_id,
    title_source: "heading",
    doc_type: "prose",
    parent_id: null,
    snapshot_seq: 1,
    version_floor: null,
    trashed: false,
    trashed_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    acl_principals: ["user:u_liv"],
    acl_writers: ["user:u_liv"],
    acl_commenters: [],
    inherits_perms: true,
    locked: false,
    locked_by: null,
    locked_at: null,
    search_hidden: false,
    own_grants: { p: [], w: [], c: [] },
    created_by: "user:u_liv",
    agent_mode: "review",
    agent_instructions: "",
    page_of: null,
    page_row: null,
    ...patch,
  };
}

function folder(folder_id: string, title: string, parent_id: string | null, agent_instructions = ""): FolderRow {
  return {
    folder_id,
    workspace_id: "ws1",
    parent_id,
    owner: "user:u_liv",
    title,
    acl_principals: ["user:u_liv"],
    acl_writers: ["user:u_liv"],
    inherits_perms: true,
    own_grants: { p: [], w: [], c: [] },
    agent_instructions,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
}

function comment(num: number, parent_num: number | null, author: string, body: string, anchor_quote: string | null = null): CommentRow {
  return {
    doc_id: "d1-plan",
    num,
    parent_num,
    author,
    body,
    anchor_start: null,
    anchor_end: null,
    anchor_quote,
    resolved: num === 1,
    reactions: {},
    mentions: [],
    created_at: `2026-09-2${num}T10:00:00Z`,
    updated_at: `2026-09-2${num}T10:00:00Z`,
  };
}

const PLANS = folder("f1", "Plans", null, "Plans are drafts.");
const HIDDEN = folder("f2", "Hidden", "f1");
const INNER = folder("f3", "Inner", "f2");

/** The workspace: every document, readable or not, and each prose body. */
let docs: DocRow[];
let bodies: Map<string, string>;
let schema: DatabaseSchema;
let rows: RowRecord[];
let actorCalls: string[];
/** Actors released, as `docs:<id>` or `databases:<id>`, in order. */
let released: string[];
/** Documents whose actor answers with an error. */
let failing: Set<string>;
/** Runs once the database actor has answered each page of rows. */
let onPage: (() => void) | null;

const START = [
  "# Start here",
  "",
  "Read [the plan](/doc/d1-plan) and [the secret](http://livs-air.local:8787/doc/d-secret).",
  "",
  "Open [the tasks](/doc/db1?table=t1&view=v1&row=row_a1), or [one task](https://node.test/doc/p1?row=db1.t1.row_a1).",
  "",
  "Ask [@Liv](mention:u_liv) about [contributing](CONTRIBUTING.md) or see [the site](https://example.com).",
  "",
  `![Chart](/api/docs/d-start/media/${PNG_HASH})`,
  "",
  `![Gone](/api/docs/d-start/media/${MISSING_HASH})`,
].join("\n");

function world(): void {
  docs = [
    doc("d-start", { title: "Welcome" }),
    doc("d1-plan", { title: "Plan", title_source: "user", parent_id: "f1" }),
    doc("d2-hidden", { title: "Plan", parent_id: "f2" }),
    doc("d-secret", { acl_principals: ["user:u_other"] }),
    doc("db1", { title: "Tasks", doc_type: "database", parent_id: "f1", agent_mode: "auto", locked: true, agent_instructions: "Keep rows short." }),
    doc("p1", { title: "Write", parent_id: "f1", page_of: "db1", page_row: "t1.row_a1" }),
    doc("p2-orphan", { title: "Write again", parent_id: "f1", page_of: "db1", page_row: "t1.row_gone" }),
  ];
  bodies = new Map([
    ["d-start", START],
    ["d1-plan", `# Plan v2\n\nThe plan is simple.\n\n![Dot](data:image/png;base64,${Buffer.from(PNG).toString("base64")})`],
    ["d2-hidden", "# Plan\n\nKept in a folder Liv cannot open."],
    ["p1", "# Write\n\nBack to [the table](/doc/db1)."],
    ["p2-orphan", "# Write again"],
  ]);
  schema = {
    database_id: "db1",
    tables: [
      {
        table_id: "t1",
        name: "tasks",
        display: "Tasks",
        position: 0,
        row_count: 2,
        columns: [
          { column_id: "c1", name: "name", display: "Name", type: "text", position: 0, options: null },
          { column_id: "c2", name: "name_2", display: "name", type: "text", position: 1, options: null },
          { column_id: "c3", name: "status", display: "Status", type: "single_select", position: 2, options: { choices: ["Open", "Done"] } },
          { column_id: "c4", name: "done", display: "Done", type: "checkbox", position: 3, options: null, description: "Shipped and checked." },
          { column_id: "c5", name: "id", display: "_id", type: "text", position: 4, options: null },
        ],
        views: [
          {
            view_id: "v1",
            table_id: "t1",
            kind: "table",
            name: "Open",
            position: 0,
            filter: {
              and: [
                { column_id: "c3", op: "eq", value: "Open" },
                { column_id: "_id", op: "ne", value: "row_a2" },
                { column_id: "c-gone", op: "eq", value: 1 },
                // Saved while Done was text: a word the archive's checkbox cannot compare with.
                { column_id: "c4", op: "eq", value: "yes" },
                { column_id: "c4", op: "contains", value: "yes" },
                { column_id: "_doc_id", op: "not_empty" },
              ],
            },
            sorts: [
              { column_id: "c1", dir: "asc" },
              { column_id: "c-gone", dir: "desc" },
            ],
            group_by: "c3",
            hidden_columns: ["c2"],
            config: { widths: { c1: 120 } },
          },
          { view_id: "v2", table_id: "t1", kind: "table", name: "open", position: 1, filter: null, sorts: [], group_by: null, hidden_columns: [], config: {} },
        ],
      },
    ],
  };
  rows = [
    { _id: "row_a1", _created_at: 1, _updated_at: 1, _doc_id: "p1", c1: "Write", c2: null, c3: "Open", c4: 1, c5: "x" },
    { _id: "row_a2", _created_at: 2, _updated_at: 2, _doc_id: null, c1: "Ship", c2: "b", c3: "Blocked", c4: 0, c5: null },
  ];
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function ctxOf(): Ctx {
  return {
    sql: {},
    surface: "web",
    alias: "u_liv",
    displayName: "Liv",
    isAgent: false,
    principals: ["user:u_liv", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: {
      publicOrigin: "https://node.test",
      extraOrigins: ["http://livs-air.local:8787"],
      settings: { current: () => ({ databaseOpsKeep: 500 }) },
      jobs: { send: vi.fn(async () => {}) },
      docs: {
        get: (id: string) => ({
          fetch: async (url: string) => {
            actorCalls.push(url);
            return failing.has(id) ? new Response("down", { status: 503 }) : json({ markdown: bodies.get(id) ?? "" });
          },
        }),
        release: async (id: string) => void released.push(`docs:${id}`),
      },
      databases: {
        release: async (id: string) => void released.push(`databases:${id}`),
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            actorCalls.push(url);
            if (url.startsWith("http://actor/schema")) return json(schema);
            // As the actor pages by `after`: from past the row the page before ended on.
            const body = JSON.parse(String(init!.body)) as { after: string; limit: number };
            const page = rows.filter((r) => body.after === "" || Number(r._created_at) > Number(body.after)).slice(0, body.limit);
            const next = page.length < body.limit ? null : String(page.at(-1)!._created_at);
            onPage?.();
            return json({ rows: page, total: rows.length, next });
          },
        }),
      },
      media: {
        head: async (key: string) => (key === `media/ws1/${PNG_HASH}` ? { key, size: PNG.length } : null),
        get: async (key: string) => (key === `media/ws1/${PNG_HASH}` ? { arrayBuffer: async () => PNG.slice().buffer } : null),
      },
    },
  } as unknown as Ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  caps.body = 0;
  caps.unpacked = 0;
  world();
  actorCalls = [];
  released = [];
  failing = new Set();
  onPage = null;
  vi.mocked(db.getWorkspace).mockResolvedValue({ workspace_id: "ws1", name: "Liv's team", agent_instructions: "Write plainly." } as never);
  // The ACL is the query's: only what Liv can read comes back.
  vi.mocked(db.listFolders).mockResolvedValue([PLANS, INNER]);
  vi.mocked(db.getFolderAncestors).mockImplementation(async (_sql, id) => (id === "f2" ? [PLANS, HIDDEN] : []));
  vi.mocked(db.listExportDocs).mockImplementation(async (_sql, principals, _ws, after, limit = 500) =>
    docs
      .filter((d) => d.acl_principals.some((p) => principals.includes(p)) && (after === null || d.doc_id > after))
      .sort((a, b) => (a.doc_id < b.doc_id ? -1 : 1))
      .slice(0, limit),
  );
  vi.mocked(db.getDoc).mockImplementation(async (_sql, id) => docs.find((d) => d.doc_id === id) ?? null);
  vi.mocked(db.listComments).mockImplementation(async (_sql, id) =>
    id === "d1-plan"
      ? [
          comment(1, null, "u_liv", "  Is this final?  ", "The plan"),
          comment(2, 1, "imported:Ada", "Yes."),
          comment(4, 3, "u_liv", "A reply to nothing."),
          comment(5, 1, "agent-sample", "Settled."),
        ]
      : [],
  );
  // Liv is ws1's only member.
  vi.mocked(db.getUsers).mockImplementation(async (_sql, aliases, ws) =>
    ws === "ws1" && aliases.includes("u_liv") ? [{ alias: "u_liv", display_name: "Liv", username: "liv", email: null } as never] : [],
  );
  vi.mocked(db.listDocsWithCommentsOver).mockResolvedValue([]);
  reach({ role: "owner", groups: [] });
});

/** Liv's membership as the export reads it again before each item. */
function reach(now: { role: "owner" | "admin" | "member" | null; groups: string[]; workspace?: string }): void {
  vi.mocked(db.resolveHumanAuth).mockResolvedValue({
    user: { alias: "u_liv", display_name: "Liv", username: "liv", email: null } as never,
    membership: now.role === null ? null : { workspace_id: now.workspace ?? "ws1", role: now.role },
    groupIds: now.groups,
  });
}

/** Plan and write the export, then read the archive back as an import would. */
async function exportArchive(ctx = ctxOf()) {
  const chunks: Uint8Array[] = [];
  const plan = await planWorkspaceExport(ctx);
  await writeWorkspaceExport(ctx, plan, (chunk) => void chunks.push(chunk));
  const archive = openZip(Buffer.concat(chunks));
  const text = async (name: string) => new TextDecoder().decode(await archive.read(name));
  const manifest: ArchiveManifest = parseManifest(JSON.parse(await text("stuga.json")));
  return { archive, text, manifest };
}

const item = <T>(manifest: ArchiveManifest, path: string) => manifest.items.find((i) => i.path === path) as T;

describe("workspace export", () => {
  it("holds what the exporter can open, each item under its nearest readable folder", async () => {
    const { archive, manifest } = await exportArchive();
    expect(manifest.workspace).toEqual({ name: "Liv's team", agent_instructions: "Write plainly." });
    expect(manifest.items.map((i) => `${i.kind} ${i.path}`)).toEqual([
      "folder Plans",
      "folder Plans/Inner",
      "doc Plans/Plan.md",
      "doc Plans/Plan (2).md",
      "doc Plans/Write again.md",
      "database Plans/Tasks",
      "doc Welcome.md",
    ]);
    expect(item(manifest, "Plans")).toMatchObject({ parent: null, title: "Plans", agent_instructions: "Plans are drafts." });
    // Inside a folder Liv cannot open, so under the nearest one she can.
    expect(item(manifest, "Plans/Inner")).toMatchObject({ parent: "Plans" });
    expect(item(manifest, "Plans/Plan (2).md")).toMatchObject({ parent: "Plans", title: "Plan" });
    expect([...archive.files.keys()].sort()).toEqual([
      "Plans/Plan (2).md",
      "Plans/Plan.md",
      "Plans/Tasks/Tasks.jsonl",
      "Plans/Tasks/pages/row_a1.md",
      "Plans/Write again.md",
      "Welcome.md",
      `media/${PNG_HASH}.png`,
      "stuga.json",
    ]);
    // What the listing leaves out is never read: no body for the secret, no folder for Hidden.
    expect(actorCalls.some((u) => u.includes("d-secret"))).toBe(false);
    expect(vi.mocked(db.listExportDocs).mock.calls[0]![1]).toEqual(["user:u_liv", "org:ws1"]);
  });

  it("points links into the archive, or at this node's public origin when their target is not exported", async () => {
    const { text } = await exportArchive();
    const start = await text("Welcome.md");
    expect(start).toContain("Read [the plan](Plans/Plan.md) and [the secret](https://node.test/doc/d-secret).");
    expect(start).toContain("Open [the tasks](Plans/Tasks#table=Tasks&view=Open&row=row_a1), or [one task](Plans/Tasks/pages/row_a1.md).");
    // A person is plain text, and a relative link that led nowhere keeps only its words.
    expect(start).toContain("Ask @Liv about contributing or see [the site](https://example.com).");
    expect(start).toContain(`![Chart](media/${PNG_HASH}.png)`);
    expect(start).not.toContain("Gone");
    expect(start).not.toContain("mention:");
    expect(await text("Plans/Tasks/pages/row_a1.md")).toBe("# Write\n\nBack to [the table](..).\n");
  });

  it("copies each image once, named for its bytes, whether stored or inline", async () => {
    const { archive, text } = await exportArchive();
    expect(await archive.read(`media/${PNG_HASH}.png`)).toEqual(PNG);
    expect(await text("Plans/Plan.md")).toContain(`![Dot](../media/${PNG_HASH}.png)`);
  });

  it("writes a table's rows, columns and views by name, de-duplicated", async () => {
    const { manifest, text } = await exportArchive();
    const tasks = item<ArchiveDatabase>(manifest, "Plans/Tasks");
    expect(tasks).toMatchObject({ title: "Tasks", agent_mode: "auto", locked: true, agent_instructions: "Keep rows short." });
    const [table] = tasks.tables;
    expect(table!.columns).toEqual([
      { name: "Name", type: "text" },
      { name: "name (2)", type: "text" },
      // A value the column no longer offers joins its choices, so the row survives an import.
      { name: "Status", type: "single_select", choices: ["Open", "Done", "Blocked"] },
      { name: "Done", type: "checkbox", description: "Shipped and checked." },
      { name: "_id (2)", type: "text" },
    ]);
    const file = await text("Plans/Tasks/Tasks.jsonl");
    expect(file).toBe(
      '{"_id":"row_a1","Name":"Write","Status":"Open","Done":true,"_id (2)":"x"}\n' +
        '{"_id":"row_a2","Name":"Ship","name (2)":"b","Status":"Blocked","Done":false}\n',
    );
    expect(parseTableRows(file, table!).map((r) => r.key)).toEqual(["row_a1", "row_a2"]);
    expect(table!.views).toEqual([
      {
        name: "Open",
        kind: "table",
        position: 0,
        filter: {
          and: [
            { column: "Status", op: "eq", value: "Open" },
            { column: "_id", op: "ne", value: "row_a2" },
            { column: "Done", op: "contains", value: "yes" },
            { column: "_doc_id", op: "not_empty" },
          ],
        },
        sorts: [{ column: "Name", dir: "asc" }],
        group_by: "Status",
        hidden_columns: ["name (2)"],
        config: { widths: { c1: 120 } },
      },
      { name: "open (2)", kind: "table", position: 1, filter: null, sorts: [], group_by: null, hidden_columns: [], config: {} },
    ]);
    // Only the row that links a page has one; a page no row links is an ordinary document.
    expect(table!.pages).toEqual([
      {
        row: "row_a1",
        file: "Plans/Tasks/pages/row_a1.md",
        title: "Write",
        title_source: "heading",
        agent_mode: "review",
        locked: false,
        search_hidden: false,
        agent_instructions: "",
      },
    ]);
  });

  it("reads every row of a table longer than a page, one deleted after it was read leaving no other unread", async () => {
    rows = Array.from({ length: 450 }, (_, i) => ({ _id: `row_${i}`, _created_at: i + 1, _updated_at: i + 1, _doc_id: null, c1: `r${i}`, c2: null, c3: "Open", c4: 0, c5: null }));
    schema.tables[0]!.row_count = 450;
    let pages = 0;
    onPage = () => {
      if (++pages === 1) rows.splice(10, 1);
    };
    const { text } = await exportArchive();
    const keys = (await text("Plans/Tasks/Tasks.jsonl")).trim().split("\n").map((line) => (JSON.parse(line) as { _id: string })._id);
    // Row 10 as it was when read; row 200, the first of the second page, which reading by offset would have stepped over.
    expect(keys).toEqual(Array.from({ length: 450 }, (_, i) => `row_${i}`));
    expect(pages).toBe(3);
  });

  it("titles a document from its body unless someone named it", async () => {
    const { manifest } = await exportArchive();
    // Named for the stored title, titled by the heading the body now opens with.
    expect(item<ArchiveDoc>(manifest, "Welcome.md").title).toBe("Start here");
    expect(item<ArchiveDoc>(manifest, "Plans/Plan.md")).toMatchObject({ title: "Plan", title_source: "user" });
  });

  it("carries comments with their author's name, time, quote and resolution, and drops replies to nothing", async () => {
    const { manifest } = await exportArchive();
    expect(item<ArchiveDoc>(manifest, "Plans/Plan.md").comments).toEqual([
      { num: 1, parent: null, author_name: "Liv", created_at: "2026-09-21T10:00:00.000Z", resolved: true, quote: "The plan", body: "Is this final?" },
      { num: 2, parent: 1, author_name: "Ada", created_at: "2026-09-22T10:00:00.000Z", resolved: false, quote: null, body: "Yes." },
      // Named as the app names it; there is no account behind the alias.
      { num: 5, parent: 1, author_name: "Sample agent", created_at: "2026-09-25T10:00:00.000Z", resolved: false, quote: null, body: "Settled." },
    ]);
    expect(item<ArchiveDoc>(manifest, "Welcome.md").comments).toBeUndefined();
  });

  it("names an author who is no longer a member by their alias, as the workspace sees them, asking once", async () => {
    vi.mocked(db.listComments).mockImplementation(async (_sql, id) =>
      id === "d1-plan" ? [comment(1, null, "u_liv", "Hi."), comment(2, 1, "u_gone", "Bye."), comment(3, 1, "u_gone", "Again.")] : [],
    );
    const { manifest } = await exportArchive();
    expect(item<ArchiveDoc>(manifest, "Plans/Plan.md").comments!.map((c) => c.author_name)).toEqual(["Liv", "u_gone", "u_gone"]);
    expect(vi.mocked(db.getUsers).mock.calls.map((call) => call.slice(1))).toEqual([[["u_liv", "u_gone"], "ws1"]]);
  });

  it("passes the archive check, bodies, titles, links and images included", async () => {
    const { archive } = await exportArchive();
    const files = {
      sizes: new Map([...archive.files].map(([name, info]) => [name, info.size])),
      read: (name: string) => archive.read(name),
      others: new Map<string, string>(),
    };
    expect((await checkArchive(files)).issues).toEqual([]);
  });

  it("writes a document trashed since it was listed as empty, and fails rather than lose one its actor did not read", async () => {
    const ctx = ctxOf();
    const plan = await planWorkspaceExport(ctx);
    docs.find((d) => d.doc_id === "d2-hidden")!.trashed = true;
    const chunks: Uint8Array[] = [];
    await writeWorkspaceExport(ctx, plan, (chunk) => void chunks.push(chunk));
    expect(await openZip(Buffer.concat(chunks)).read("Plans/Plan (2).md")).toEqual(new Uint8Array());

    docs.find((d) => d.doc_id === "d2-hidden")!.trashed = false;
    const again = await planWorkspaceExport(ctx);
    failing = new Set(["d2-hidden"]);
    const out = writeWorkspaceExport(ctx, again, () => {});
    await expect(out).rejects.toThrow('could not read "Plan"');
    // Before anything is sent, when its actor does not answer while the export is planned.
    await expect(planWorkspaceExport(ctx)).rejects.toThrow('could not read "Plan"');
  });

  it("names same-titled items oldest first, whatever their ids, so each export names them alike", async () => {
    docs = [
      doc("a-new", { title: "Minutes", created_at: "2026-09-03T00:00:00Z" }),
      doc("z-old", { title: "minutes", created_at: "2026-09-01T00:00:00Z" }),
      doc("m-tie", { title: "Minutes", created_at: "2026-09-02T00:00:00Z" }),
      doc("b-tie", { title: "Minutes", created_at: "2026-09-02T00:00:00Z" }),
      doc("db-new", { title: "Log", doc_type: "database", created_at: "2026-09-02T00:00:00Z" }),
      doc("db-old", { title: "Log", doc_type: "database", created_at: "2026-09-01T00:00:00Z" }),
    ];
    for (const d of docs) bodies.set(d.doc_id, `Kept by ${d.doc_id}.`);
    vi.mocked(db.listFolders).mockResolvedValue([
      { ...folder("f-new", "Notes", null, "new"), created_at: "2026-09-02T00:00:00Z" },
      { ...folder("f-old", "Notes", null, "old"), created_at: "2026-09-01T00:00:00Z" },
    ]);
    docs.find((d) => d.doc_id === "db-new")!.agent_instructions = "new";
    docs.find((d) => d.doc_id === "db-old")!.agent_instructions = "old";
    const { manifest, text } = await exportArchive();
    const named = Object.fromEntries(
      await Promise.all(
        manifest.items.filter((i) => i.kind === "doc").map(async (i) => [i.path, (await text(i.path)).trim()] as const),
      ),
    );
    expect(named).toEqual({
      "minutes.md": "Kept by z-old.",
      "Minutes (2).md": "Kept by b-tie.",
      "Minutes (3).md": "Kept by m-tie.",
      "Minutes (4).md": "Kept by a-new.",
    });
    // Folders and databases by age as well.
    const others = manifest.items.filter((i) => i.kind !== "doc") as Array<{ path: string; agent_instructions: string }>;
    expect(others.map((i) => `${i.path}: ${i.agent_instructions}`)).toEqual(["Notes: old", "Notes (2): new", "Log: old", "Log (2): new"]);
  });

  it("releases each document's and database's actor once it is read", async () => {
    await exportArchive();
    const bodiesRead = ["d-start", "d1-plan", "d2-hidden", "p1", "p2-orphan"];
    // Each body twice: measured while planning, then written.
    for (const id of bodiesRead) expect(released.filter((r) => r === `docs:${id}`)).toHaveLength(2);
    // The database's once for its schema and once for its rows.
    expect(released.filter((r) => r === "databases:db1")).toHaveLength(2);
    expect(released.some((r) => r.includes("d-secret"))).toBe(false);
  });

  it("refuses a workspace larger than an archive holds before writing anything", async () => {
    const refusal = async (): Promise<string> => {
      const err = await planWorkspaceExport(ctxOf()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExportRefused);
      expect((err as InstanceType<typeof ExportRefused>).status).toBe(413);
      return (err as Error).message;
    };
    docs = Array.from({ length: 10_001 }, (_, i) => doc(`d${String(i).padStart(5, "0")}`));
    // Its two folders as well.
    expect(await refusal()).toBe("this workspace holds 10003 folders, documents and databases you can open; an archive holds at most 10000");

    // Within both counts, but with three rows files and the manifest, 20,003 files.
    vi.mocked(db.listFolders).mockResolvedValueOnce([]);
    schema.tables.push({ ...schema.tables[0]!, table_id: "t2" }, { ...schema.tables[0]!, table_id: "t3" });
    docs = [
      doc("db1", { doc_type: "database" }),
      ...Array.from({ length: 9_999 }, (_, i) => doc(`d${String(i).padStart(5, "0")}`)),
      ...Array.from({ length: 10_000 }, (_, i) => doc(`p${String(i).padStart(5, "0")}`, { page_of: "db1" })),
    ];
    expect(await refusal()).toBe("this workspace would take 20003 files; an archive holds at most 20000");

    world();
    schema.tables[0]!.row_count = 500_001;
    expect(await refusal()).toBe("this workspace holds 500001 rows you can open; an archive holds at most 500000");
    schema.tables[0]!.row_count = 2;

    // Only a document the exporter would carry counts.
    vi.mocked(db.listDocsWithCommentsOver).mockResolvedValue([
      { doc_id: "d-secret", comments: 6_000 },
      { doc_id: "d1-plan", comments: 5_001 },
    ]);
    expect(await refusal()).toBe(`"Plan" has 5001 comments; an archive carries at most 5000 on one document`);
    expect(vi.mocked(db.listDocsWithCommentsOver).mock.calls[0]!.slice(1)).toEqual(["ws1", 5_000]);
  });

  it("refuses, before anything is sent, a body longer than an import takes, measured as the export would write it", async () => {
    const refusal = async (): Promise<string> => {
      const err = await planWorkspaceExport(ctxOf()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExportRefused);
      expect((err as InstanceType<typeof ExportRefused>).status).toBe(413);
      return (err as Error).message;
    };
    caps.body = 4_096;
    caps.unpacked = 65_536;
    bodies.set("d-start", `# Start here\n\n${"word ".repeat(1_000)}`);
    expect(await refusal()).toBe(`"Welcome" would be 5014 bytes of Markdown; an archive takes at most 4096 for one document`);

    // An inline image leaves the body for media/, so only its file's name counts.
    const big = new Uint8Array(8_000);
    big.set(PNG);
    bodies.set("d-start", `# Start here\n\n![Big](data:image/png;base64,${Buffer.from(big).toString("base64")})`);
    const { text } = await exportArchive();
    expect(await text("Welcome.md")).toMatch(/^# Start here\n\n!\[Big\]\(media\/[0-9a-f]{64}\.png\)\n$/);

    // Each body within the cap, but together more than an archive unpacks to.
    world();
    const words = "word ".repeat(800);
    docs = Array.from({ length: 20 }, (_, i) => doc(`d${String(i).padStart(2, "0")}`));
    for (const d of docs) bodies.set(d.doc_id, words);
    expect(await refusal()).toBe(`this workspace's documents come to 80000 bytes; an archive unpacks to at most 65536`);
  });

  it("carries no comments or rows of what the exporter can no longer open once the writing reaches it", async () => {
    const ctx = ctxOf();
    const plan = await planWorkspaceExport(ctx);
    // Taken away while the client was slow to read what came before.
    docs = docs.map((d) => (d.doc_id === "d1-plan" || d.doc_id === "db1" ? { ...d, acl_principals: ["user:u_other"] } : d));
    const chunks: Uint8Array[] = [];
    await writeWorkspaceExport(ctx, plan, (chunk) => void chunks.push(chunk));
    const archive = openZip(Buffer.concat(chunks));
    const manifest = parseManifest(JSON.parse(new TextDecoder().decode(await archive.read("stuga.json"))));
    expect(await archive.read("Plans/Plan.md")).toEqual(new Uint8Array());
    expect(item<ArchiveDoc>(manifest, "Plans/Plan.md").comments).toBeUndefined();
    expect(vi.mocked(db.listComments).mock.calls.some(([, id]) => id === "d1-plan")).toBe(false);
    expect(await archive.read("Plans/Tasks/Tasks.jsonl")).toEqual(new Uint8Array());
    expect(actorCalls.some((u) => u.includes("rows/list"))).toBe(false);
  });

  it("narrows to what the exporter can open as each item is written, and stops once they may no longer export", async () => {
    // Plan and Tasks are shared with Finance, which Liv is in when the export starts.
    docs = docs.map((d) => (d.doc_id === "d1-plan" || d.doc_id === "db1" ? { ...d, acl_principals: ["group:finance"] } : d));
    const ctx = { ...ctxOf(), principals: ["user:u_liv", "org:ws1", "group:finance"] } as Ctx;
    const write = async () => {
      const chunks: Uint8Array[] = [];
      await writeWorkspaceExport(ctx, await planWorkspaceExport(ctx), (chunk) => void chunks.push(chunk));
      return openZip(Buffer.concat(chunks));
    };

    reach({ role: "admin", groups: ["group:finance"] });
    expect((await (await write()).read("Plans/Plan.md")).byteLength).toBeGreaterThan(0);

    // Taken out of Finance while the client was slow to read.
    reach({ role: "admin", groups: [] });
    vi.mocked(db.listComments).mockClear();
    actorCalls = [];
    const narrowed = await write();
    expect(await narrowed.read("Plans/Plan.md")).toEqual(new Uint8Array());
    expect(await narrowed.read("Plans/Tasks/Tasks.jsonl")).toEqual(new Uint8Array());
    expect(vi.mocked(db.listComments).mock.calls.some(([, id]) => id === "d1-plan")).toBe(false);
    expect(actorCalls.some((u) => u.includes("rows/list"))).toBe(false);
    expect(vi.mocked(db.resolveHumanAuth).mock.calls[0]!.slice(1)).toEqual(["u_liv", "user:u_liv", "ws1"]);

    for (const now of [{ role: "member" as const }, { role: null }, { role: "owner" as const, workspace: "ws2" }]) {
      reach({ groups: [], ...now });
      await expect(write()).rejects.toThrow("the exporter is no longer an owner or admin of this workspace");
    }
  });

  it("refuses, before anything is sent, folders nested deeper than an archive holds", async () => {
    const chain = Array.from({ length: 33 }, (_, i) => folder(`n${i}`, "A", i === 0 ? null : `n${i - 1}`));
    vi.mocked(db.listFolders).mockResolvedValue(chain);
    const err = await planWorkspaceExport(ctxOf()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportRefused);
    expect((err as InstanceType<typeof ExportRefused>).status).toBe(413);
    expect((err as Error).message).toBe(`the folder "A" is 33 folders deep; an archive holds folders at most 32 deep`);
    expect(actorCalls).toEqual([]);

    vi.mocked(db.listFolders).mockResolvedValue(chain.slice(0, 32));
    const { manifest } = await exportArchive();
    expect(manifest.items.filter((i) => i.kind === "folder").at(-1)!.path).toBe(Array(32).fill("A").join("/"));
  });

  it("writes an archive an import reads, a body that packs far past 100 to 1 included", async () => {
    const log = `# Log\n\n${"ok ".repeat(700_000).trim()}`;
    bodies.set("d-start", log);
    const ctx = ctxOf();
    const chunks: Uint8Array[] = [];
    await writeWorkspaceExport(ctx, await planWorkspaceExport(ctx), (chunk) => void chunks.push(chunk));
    const bytes = Buffer.concat(chunks);
    const entry = openZip(bytes, { maxRatio: Infinity }).files.get("Welcome.md")!;
    expect(entry.size / entry.compressedSize).toBeGreaterThan(100);
    const contents = await readArchive(bytes, LIMITS);
    expect(await contents.body("Welcome.md")).toBe(log);
  });

  it("names a comment's author as the archive takes it, without direction marks", async () => {
    vi.mocked(db.listComments).mockImplementation(async (_sql, id) =>
      id === "d1-plan" ? [comment(1, null, "u_liv", "Hi."), comment(2, 1, "imported:\u202eAda\u2069", "Yes."), comment(3, 1, "imported:\u200f", "No.")] : [],
    );
    vi.mocked(db.getUsers).mockResolvedValue([{ alias: "u_liv", display_name: "Liv\u202e", username: "liv", email: null } as never]);
    const { manifest } = await exportArchive();
    expect(item<ArchiveDoc>(manifest, "Plans/Plan.md").comments!.map((c) => c.author_name)).toEqual(["Liv", "Ada", "Unknown"]);
  });

  it("stops, rather than write an archive no node would import, when a cap is passed while writing", async () => {
    const write = async (): Promise<unknown> => {
      const ctx = ctxOf();
      return writeWorkspaceExport(ctx, await planWorkspaceExport(ctx), () => {}).catch((e: unknown) => e);
    };
    // Grown since the plan measured it.
    const ctx = ctxOf();
    const plan = await planWorkspaceExport(ctx);
    bodies.set("d-start", `# Start here\n\n${"word ".repeat(1_000_000)}`);
    const grown = await writeWorkspaceExport(ctx, plan, () => {}).catch((e: unknown) => e);
    expect(String(grown)).toMatch(/^ArchiveError: Welcome\.md: would be \d+ bytes; an archive takes at most 4194305$/);

    world();
    // Written since the plan counted them.
    vi.mocked(db.listComments).mockImplementation(async (_sql, id) =>
      id === "d1-plan" ? Array.from({ length: 5_001 }, (_, i) => comment(i + 1, null, "u_liv", "More.")) : [],
    );
    expect(String(await write())).toBe(`Error: "Plan" has 5001 comments; an archive carries at most 5000`);
  });
});
