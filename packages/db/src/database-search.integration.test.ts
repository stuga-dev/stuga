import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { createClient, closeClients, type Sql } from "./client.js";
import { createDoc, getDocSearchText, setDatabaseSearchText } from "./docs.js";
import { searchDocs } from "./search.js";
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
