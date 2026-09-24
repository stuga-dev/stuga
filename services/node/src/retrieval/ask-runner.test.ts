/** Ask's tools under a selected collection: every list, read, search and query stays inside it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  listReadableDocs: vi.fn(async () => []),
  listFolders: vi.fn(async () => []),
  getFolder: vi.fn(),
  getFolderSubtreeIds: vi.fn(async () => []),
  listDocs: vi.fn(async () => []),
  listAncestorFolderIds: vi.fn(async () => []),
}));
vi.mock("../agents/edits.js", () => ({
  readDocMarkdownWithProjection: vi.fn(async () => ({ markdown: "body", doc: { title: "Doc" } })),
  databaseDocMessage: (id: string) => `${id} is a database`,
}));
vi.mock("../databases/gate.js", () => ({
  authorizedDatabase: vi.fn(async () => ({ doc_id: "db_in", title: "Tasks" })),
  callDatabaseActor: vi.fn(async (_ctx: unknown, _id: string, path: string) =>
    // The actor answers a query row as an object keyed by column name, which is what the runner must convert.
    Response.json(path === "schema" ? { database_id: "db_in", tables: [] } : { columns: ["n", "who"], rows: [{ n: 1, who: null }] }),
  ),
}));
vi.mock("./retrieve.js", () => ({ retrieveAndRerank: vi.fn(async () => ({ chunks: [], degraded: false })) }));

const db = await import("@stuga/db");
const { readDocMarkdownWithProjection } = await import("../agents/edits.js");
const { authorizedDatabase, callDatabaseActor } = await import("../databases/gate.js");
const { retrieveAndRerank } = await import("./retrieve.js");
const { createAskRunner, describeSchema } = await import("./ask-runner.js");
import type { DocRow, FolderRow } from "@stuga/db";
import type { ColumnSpec, DatabaseSchema } from "@stuga/protocol/databases/types";
import type { Ctx } from "../auth/context.js";

const ctx = {
  sql: {},
  alias: "ada",
  isAgent: false,
  principals: ["user:ada"],
  workspaceId: "ws1",
  role: "member",
  env: { embeddingDims: 2, searchLanguages: [] },
} as unknown as Ctx;

const runner = (scopeDocIds: string[] | null) => createAskRunner({ ctx, aiCfg: {} as never, scopeDocIds }).runner;
const folder = (folder_id: string) => ({ folder_id, title: folder_id, workspace_id: "ws1", acl_principals: ["user:ada"] }) as FolderRow;
const doc = (doc_id: string, doc_type = "prose") => ({ doc_id, title: doc_id, doc_type }) as DocRow;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Ask with a collection selected", () => {
  it("reads a document inside it", async () => {
    expect(await runner(["d_in"]).readDocument({ doc_id: "d_in" })).toEqual({ title: "Doc", text: "body", total: 4 });
  });

  it("refuses a document outside it with a tool error, without reading it", async () => {
    expect(await runner(["d_in"]).readDocument({ doc_id: "d_out" })).toEqual({ error: "that document is not in the selected collection" });
    expect(readDocMarkdownWithProjection).not.toHaveBeenCalled();
  });

  it("lists only its documents, and only the folders that lead to them", async () => {
    vi.mocked(db.listFolders).mockResolvedValue([folder("f_lead"), folder("f_elsewhere")]);
    vi.mocked(db.listAncestorFolderIds).mockResolvedValue(["f_lead", "f_parent"]);
    const out = await runner(["d_in"]).listDocuments({ query: "plan" });
    expect(db.listReadableDocs).toHaveBeenCalledWith({}, ["user:ada"], "ws1", expect.objectContaining({ q: "plan", docIds: ["d_in"] }));
    expect(db.listAncestorFolderIds).toHaveBeenCalledWith({}, ["d_in"], "ws1");
    expect(out.folders).toEqual([{ folder_id: "f_lead", title: "f_lead" }]);
  });

  it("confines a folder listing to the collection too", async () => {
    vi.mocked(db.getFolder).mockResolvedValue(folder("f_lead"));
    vi.mocked(db.getFolderSubtreeIds).mockResolvedValue(["f_lead", "f_kid"]);
    await runner(["d_in"]).listDocuments({ folder_id: "f_lead" });
    expect(db.listReadableDocs).toHaveBeenCalledWith({}, ["user:ada"], "ws1", expect.objectContaining({ parentIds: ["f_lead", "f_kid"], docIds: ["d_in"] }));
  });

  it("searches exactly its documents", async () => {
    await runner(["d_in"]).search({ query: "launch", offset: 0 });
    expect(retrieveAndRerank).toHaveBeenCalledWith(expect.objectContaining({ scopeDocIds: ["d_in"] }));
  });

  it("describes and queries only its databases", async () => {
    vi.mocked(db.listDocs).mockResolvedValue([doc("db_in", "database"), doc("db_out", "database")]);
    const listed = await runner(["db_in"]).listDatabases();
    expect(listed.map((d) => d.database_id)).toEqual(["db_in"]);

    vi.mocked(callDatabaseActor).mockClear();
    expect(await runner(["db_in"]).queryDatabase({ database_id: "db_out", sql: "SELECT 1" })).toEqual({
      error: "that database is not in the selected collection",
    });
    expect(authorizedDatabase).not.toHaveBeenCalled();
    expect(callDatabaseActor).not.toHaveBeenCalled();
    // Cells in column order: the agent renders rows positionally, so an object row would have crashed the turn.
    expect(await runner(["db_in"]).queryDatabase({ database_id: "db_in", sql: "SELECT 1" })).toMatchObject({
      columns: ["n", "who"],
      rows: [[1, null]],
    });
  });

  it("finds nothing at all in an empty collection", async () => {
    expect(await runner([]).readDocument({ doc_id: "d_any" })).toEqual({ error: "that document is not in the selected collection" });
    await runner([]).listDocuments({});
    expect(db.listReadableDocs).toHaveBeenCalledWith({}, ["user:ada"], "ws1", expect.objectContaining({ docIds: [] }));
  });
});

describe("Ask without a collection", () => {
  it("reaches every document the caller can read", async () => {
    vi.mocked(db.listFolders).mockResolvedValue([folder("f_any")]);
    expect(await runner(null).readDocument({ doc_id: "d_any" })).toMatchObject({ text: "body" });
    const out = await runner(null).listDocuments({});
    expect(db.listReadableDocs).toHaveBeenCalledWith({}, ["user:ada"], "ws1", expect.objectContaining({ docIds: null }));
    expect(db.listAncestorFolderIds).not.toHaveBeenCalled();
    expect(out.folders).toEqual([{ folder_id: "f_any", title: "f_any" }]);
  });
});

describe("the schema listing text-to-SQL is written from", () => {
  const col = (over: Partial<ColumnSpec> & Pick<ColumnSpec, "column_id" | "name" | "type">): ColumnSpec => ({
    display: over.name!,
    position: 0,
    options: null,
    ...over,
  }) as ColumnSpec;

  const schema: DatabaseSchema = {
    database_id: "db_in",
    tables: [
      {
        table_id: "t1",
        name: "deals",
        display: "Deals",
        position: 0,
        row_count: 3,
        columns: [
          col({ column_id: "c1", name: "customer", type: "text" }),
          col({ column_id: "c2", name: "amount", display: "Amount (net)", type: "number", description: "  USD,\n  net of refunds  " }),
          col({ column_id: "c3", name: "stage", type: "single_select", options: { choices: ["open", "won"] }, description: "Pipeline stage" }),
        ],
        views: [
          { view_id: "v1", table_id: "t1", kind: "table", name: "Live deals", position: 0, filter: { column_id: "c3", op: "eq", value: "open" }, sorts: [], group_by: null, hidden_columns: [], config: {} },
        ],
      },
    ],
  };

  it("carries each column's type, display name, select values and description, plus the saved views line", () => {
    expect(describeSchema(schema)).toBe(
      'table deals ("Deals") [3 rows]: _id, customer text, ' +
        'amount number ("Amount (net)") — "USD, net of refunds", ' +
        "stage single_select one of: 'open', 'won' — \"Pipeline stage\"" +
        "\n  saved views (what the people here mean by these words): Live deals = stage = 'open'",
    );
  });

  it("says nothing extra for a database with no tables", () => {
    expect(describeSchema({ database_id: "db_in", tables: [] })).toBe("(no tables)");
  });
});
