import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, listExportDocs, updateDoc } from "./docs.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const WS = "ws-export";
const OTHER = "ws-other";
const LIV = ["user:u_liv", `org:${WS}`];

describe.skipIf(!URL)("listExportDocs", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS, OTHER);
  });

  const doc = (docId: string, opts: { acl?: string[]; ws?: string; docType?: "prose" | "database"; pageOf?: string } = {}) =>
    createDoc(sql, {
      workspaceId: opts.ws ?? WS,
      docId,
      owner: "user:u_liv",
      title: docId,
      docType: opts.docType,
      aclPrincipals: opts.acl ?? ["user:u_liv"],
      ...(opts.pageOf ? { pageOf: opts.pageOf, pageRow: "t1.r1" } : {}),
    });

  it("pages through every readable live document in doc_id order, databases and row pages included", async () => {
    await doc("d3");
    await doc("d1", { docType: "database" });
    await doc("d2", { pageOf: "d1" });
    await doc("d5", { acl: [`org:${WS}`] });
    await doc("d4");

    const first = await listExportDocs(sql, LIV, WS, null, 2);
    expect(first.map((d) => d.doc_id)).toEqual(["d1", "d2"]);
    const second = await listExportDocs(sql, LIV, WS, "d2", 2);
    expect(second.map((d) => d.doc_id)).toEqual(["d3", "d4"]);
    const last = await listExportDocs(sql, LIV, WS, "d4", 2);
    expect(last.map((d) => d.doc_id)).toEqual(["d5"]);
    expect(await listExportDocs(sql, LIV, WS, "d5", 2)).toEqual([]);
  });

  it("leaves out the trash, what the principals cannot read, and other workspaces", async () => {
    await doc("live");
    await doc("trashed");
    await updateDoc(sql, "trashed", { trashed: true });
    await doc("private", { acl: ["user:u_other"] });
    await doc("elsewhere", { ws: OTHER });

    expect((await listExportDocs(sql, LIV, WS, null)).map((d) => d.doc_id)).toEqual(["live"]);
  });
});
