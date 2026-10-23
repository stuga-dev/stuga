import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { createClient, closeClients, type Sql } from "./client.js";
import { createDoc, getDocSearchText, setDatabaseSearchText } from "./docs.js";
import { databasesByWords, searchDocs } from "./search.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-test";

describe.skipIf(!URL)("a database's cells in the workspace search", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  const search = (query: string, principals: string[]) =>
    searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals, query, queryEmbedding: null });

  it("finds a database by what its cells say, for whoever can read it and nobody else", async () => {
    await createDoc(sql, { docId: "orders", workspaceId: WS, owner: "user:liv", title: "Orders 2026", docType: "database", aclPrincipals: ["user:liv"] });
    await setDatabaseSearchText(sql, "orders", "Orders 2026\nORD-00777 · 236.3 · Refunded\nORD-00778 · Pain au chocolat · 12");

    const hits = await search("Pain au chocolat", ["user:liv"]);
    expect(hits.map((h) => [h.doc_id, h.doc_type])).toEqual([["orders", "database"]]);
    expect(hits[0]!.snippet).toContain("chocolat");
    expect((await search("ORD-00777", ["user:liv"])).map((h) => h.doc_id)).toEqual(["orders"]);
    expect(await search("Pain au chocolat", ["user:ben"])).toEqual([]);
  });

  it("keeps a database's row count and last change beside its text, writing only what moved", async () => {
    await createDoc(sql, { docId: "crm", workspaceId: WS, owner: "user:liv", title: "Customers", docType: "database", aclPrincipals: ["user:liv"] });
    const read = async () =>
      (await sql<{ row_count: number | null; text_changed_at: Date | null; text_changed_by: string[] }[]>`
        SELECT row_count, text_changed_at, text_changed_by FROM docs WHERE doc_id = 'crm'`)[0]!;
    expect((await read()).row_count).toBeNull();
    await setDatabaseSearchText(sql, "crm", "Customers\nName · Contact\nInitech · Bo Chen", [], { rows: 1, changedAt: 1_760_000_000_000, changedBy: "liv" });
    expect(await read()).toEqual({ row_count: 1, text_changed_at: new Date(1_760_000_000_000), text_changed_by: ["liv"] });
    // The same facts write nothing; a change the text does not show (a checkbox) still moves them.
    const [before] = await sql<{ xmin: string }[]>`SELECT xmin::text FROM docs WHERE doc_id = 'crm'`;
    await setDatabaseSearchText(sql, "crm", "Customers\nName · Contact\nInitech · Bo Chen", [], { rows: 1, changedAt: 1_760_000_000_000, changedBy: "liv" });
    const [same] = await sql<{ xmin: string }[]>`SELECT xmin::text FROM docs WHERE doc_id = 'crm'`;
    expect(same!.xmin).toBe(before!.xmin);
    await setDatabaseSearchText(sql, "crm", "Customers\nName · Contact\nInitech · Bo Chen", [], { rows: 1, changedAt: 1_760_000_005_000, changedBy: "agent-scout" });
    expect(await read()).toEqual({ row_count: 1, text_changed_at: new Date(1_760_000_005_000), text_changed_by: ["agent-scout"] });
    // A page has none of it.
    await createDoc(sql, { docId: "page", workspaceId: WS, owner: "user:liv", title: "Page", aclPrincipals: ["user:liv"] });
    await setDatabaseSearchText(sql, "page", "x", [], { rows: 5, changedAt: 1, changedBy: "liv" });
    expect((await sql<{ row_count: number | null }[]>`SELECT row_count FROM docs WHERE doc_id = 'page'`)[0]!.row_count).toBeNull();
  });

  it("finds the databases a question's words reach, by their cells, their columns' names or their title, for whoever reads them", async () => {
    await createDoc(sql, { docId: "crm", workspaceId: WS, owner: "user:liv", title: "Customers", docType: "database", aclPrincipals: ["user:liv"] });
    await createDoc(sql, { docId: "hr", workspaceId: WS, owner: "user:dee", title: "People", docType: "database", aclPrincipals: ["user:dee"] });
    await createDoc(sql, { docId: "doc", workspaceId: WS, owner: "user:liv", title: "Initech notes", aclPrincipals: ["user:liv"] });
    await setDatabaseSearchText(sql, "crm", "Customers\nName · Contact · Refund window\nInitech · Bo Chen · 30 days");
    await setDatabaseSearchText(sql, "hr", "People\nName · Contact\nInitech · Secret");
    const find = (query: string, principals: string[]) =>
      databasesByWords(sql, { principals, workspaceId: WS, query, limit: 5 }).then((r) => r.map((d) => d.doc_id));
    expect(await find("Initech's contact", ["user:liv"])).toEqual(["crm"]);
    expect(await find("refund window", ["user:liv"])).toEqual(["crm"]);
    expect(await find("customer", ["user:liv"])).toEqual(["crm"]);
    expect(await find("Initech", ["user:dee"])).toEqual(["hr"]);
    expect(await find("nothing here", ["user:liv"])).toEqual([]);
  });

  it("writes only a database's text, and only when it changed", async () => {
    await createDoc(sql, { docId: "notes", workspaceId: WS, owner: "user:liv", title: "Notes", aclPrincipals: ["user:liv"] });
    await setDatabaseSearchText(sql, "notes", "not a database");
    expect(await getDocSearchText(sql, "notes")).toBe("");

    await createDoc(sql, { docId: "stock", workspaceId: WS, owner: "user:liv", title: "Stock", docType: "database", aclPrincipals: ["user:liv"] });
    await setDatabaseSearchText(sql, "stock", "Flour");
    const [before] = await sql<{ xmin: string }[]>`SELECT xmin::text FROM docs WHERE doc_id = 'stock'`;
    await setDatabaseSearchText(sql, "stock", "Flour");
    const [after] = await sql<{ xmin: string }[]>`SELECT xmin::text FROM docs WHERE doc_id = 'stock'`;
    expect(after!.xmin).toBe(before!.xmin);
    expect(await getDocSearchText(sql, "stock")).toBe("Flour");
  });
});
