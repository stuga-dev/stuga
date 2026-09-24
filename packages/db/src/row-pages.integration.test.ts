import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, deleteDoc, detachPage, listDocs, listPagesOf, trashPagesOf, updateDoc } from "./docs.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const ALICE = ["user:alice", "org:all"];
const WS = "ws-row-pages";

describe.skipIf(!URL)("row pages in the documents list", () => {
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
    await seedWorkspaces(sql, WS);
  });

  /** A database, a plain document, and two pages of the database's rows. */
  async function seed() {
    await createDoc(sql, { workspaceId: WS, docId: "db", owner: "user:alice", title: "Tasks", docType: "database", aclPrincipals: ALICE });
    await createDoc(sql, { workspaceId: WS, docId: "plain", owner: "user:alice", title: "Notes", aclPrincipals: ALICE });
    await createDoc(sql, { workspaceId: WS, docId: "p1", owner: "user:alice", title: "Fix login", aclPrincipals: ALICE, pageOf: "db", pageRow: "t1.r1" });
    await createDoc(sql, { workspaceId: WS, docId: "p2", owner: "user:alice", title: "Ship it", aclPrincipals: ALICE, pageOf: "db", pageRow: "t1.r2" });
  }
  const ids = (rows: Array<{ doc_id: string }>) => rows.map((r) => r.doc_id).sort();

  it("records the link on the row, and lists the page only when asked", async () => {
    await seed();
    const page = (await listDocs(sql, ALICE, WS, { pages: "only" }))[0]!;
    expect(page.page_of).toBe("db");
    expect(page.page_row).toMatch(/^t1\.r[12]$/);

    expect(ids(await listDocs(sql, ALICE, WS))).toEqual(["db", "plain"]);
    expect(ids(await listDocs(sql, ALICE, WS, { pages: "exclude" }))).toEqual(["db", "plain"]);
    expect(ids(await listDocs(sql, ALICE, WS, { pages: "include" }))).toEqual(["db", "p1", "p2", "plain"]);
    expect(ids(await listDocs(sql, ALICE, WS, { pages: "only" }))).toEqual(["p1", "p2"]);
    expect(ids(await listDocs(sql, ALICE, WS, { pages: "only", pageOf: "db" }))).toEqual(["p1", "p2"]);
    expect(ids(await listDocs(sql, ALICE, WS, { pages: "only", pageOf: "other" }))).toEqual([]);
  });

  it("the trash lists a deleted page beside everything else, when told to include pages", async () => {
    await seed();
    await updateDoc(sql, "p1", { trashed: true });
    await updateDoc(sql, "plain", { trashed: true });
    expect(ids(await listDocs(sql, ALICE, WS, { trashedOnly: true, pages: "include" }))).toEqual(["p1", "plain"]);
    expect(ids(await listDocs(sql, ALICE, WS, { trashedOnly: true }))).toEqual(["plain"]);
    expect(ids(await listPagesOf(sql, WS, "db"))).toEqual(["p1", "p2"]);
    expect(ids(await listPagesOf(sql, WS, "db", { trashed: true }))).toEqual(["p1"]);
    expect(ids(await listPagesOf(sql, WS, "db", { trashed: false }))).toEqual(["p2"]);
  });

  it("tells the pages trashed WITH a database from one trashed on its own before", async () => {
    await seed();
    // p1 on its own first, then the database and its pages, in the route's order.
    await updateDoc(sql, "p1", { trashed: true });
    await updateDoc(sql, "db", { trashed: true });
    await updateDoc(sql, "p2", { trashed: true });
    expect(ids(await listPagesOf(sql, WS, "db", { trashed: true }))).toEqual(["p1", "p2"]);
    expect(ids(await listPagesOf(sql, WS, "db", { trashed: true, trashedWithDatabase: true }))).toEqual(["p2"]);
  });

  // Three stamps inside one millisecond: a boundary carried through a JS Date would include p1.
  it("keeps the boundary exact when the page and the database were trashed in the same millisecond", async () => {
    await seed();
    await sql`
      UPDATE docs SET trashed = TRUE, trashed_at = CASE doc_id
        WHEN 'p1' THEN '2026-09-12 10:00:00.000100+00'::timestamptz
        WHEN 'db' THEN '2026-09-12 10:00:00.000200+00'::timestamptz
        WHEN 'p2' THEN '2026-09-12 10:00:00.000300+00'::timestamptz END
      WHERE doc_id IN ('p1', 'db', 'p2')`;
    expect(ids(await listPagesOf(sql, WS, "db", { trashed: true, trashedWithDatabase: true }))).toEqual(["p2"]);
  });

  it("bounds nothing for a database in the trash without a stamp", async () => {
    await seed();
    await updateDoc(sql, "p1", { trashed: true });
    await updateDoc(sql, "p2", { trashed: true });
    await sql`UPDATE docs SET trashed = TRUE, trashed_at = NULL WHERE doc_id = 'db'`;
    expect(ids(await listPagesOf(sql, WS, "db", { trashed: true, trashedWithDatabase: true }))).toEqual(["p1", "p2"]);
  });

  it("trashPagesOf moves the live, unlocked pages of a database in, and nothing else", async () => {
    await seed();
    await sql`UPDATE docs SET locked = TRUE WHERE doc_id = 'p2'`;
    expect(await trashPagesOf(sql, "db")).toEqual(["p1"]);
    expect(await trashPagesOf(sql, "db")).toEqual([]);
    const rows = await sql<Array<{ doc_id: string; trashed: boolean; trashed_at: string | null }>>`SELECT doc_id, trashed, trashed_at FROM docs ORDER BY doc_id`;
    expect(rows.map((r) => [r.doc_id, r.trashed, r.trashed_at !== null])).toEqual([
      ["db", false, false],
      ["p1", true, true],
      ["p2", false, false],
      ["plain", false, false],
    ]);
  });

  it("a database deleted for good releases its pages into the library", async () => {
    await seed();
    await deleteDoc(sql, "db");
    expect(await listPagesOf(sql, WS, "db")).toEqual([]);
    const rows = await listDocs(sql, ALICE, WS);
    expect(ids(rows)).toEqual(["p1", "p2", "plain"]);
    for (const r of rows) expect(r.page_of).toBeNull();
  });

  it("a page its row replaced stays in the trash, and restores into the library", async () => {
    await seed();
    await updateDoc(sql, "p1", { trashed: true });
    // Only this database's page in this workspace is touched.
    await detachPage(sql, WS, "other", "p1");
    await detachPage(sql, "ws-elsewhere", "db", "p1");
    expect(ids(await listPagesOf(sql, WS, "db"))).toEqual(["p1", "p2"]);
    await detachPage(sql, WS, "db", "p1");
    expect(ids(await listPagesOf(sql, WS, "db"))).toEqual(["p2"]);
    expect(ids(await listDocs(sql, ALICE, WS, { trashedOnly: true }))).toEqual(["p1"]);
    await updateDoc(sql, "p1", { trashed: false });
    const rows = await listDocs(sql, ALICE, WS);
    expect(ids(rows)).toEqual(["db", "p1", "plain"]);
    expect(rows.find((r) => r.doc_id === "p1")).toMatchObject({ page_of: null, page_row: null });
  });

  it("refuses a page of a database that does not exist", async () => {
    await expect(createDoc(sql, { workspaceId: WS, docId: "orphan", owner: "user:alice", pageOf: "nope", pageRow: "t1.r1" })).rejects.toThrow(/page_of/);
  });
});
