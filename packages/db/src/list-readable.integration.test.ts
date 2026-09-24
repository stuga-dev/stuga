import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, listEditableDocs, listReadableDocs } from "./docs.js";
import { createFolder, getFolderSubtreeIds } from "./folders.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const WS = "ws-test";
const ALICE = ["user:alice", "org:all"];

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title).sort();

async function doc(sql: Sql, docId: string, title: string, parentId: string | null = null, acl = ["user:alice"]) {
  await createDoc(sql, { workspaceId: WS, docId, owner: "user:alice", title, parentId, aclPrincipals: acl });
}

describe.skipIf(!URL)("listReadableDocs", () => {
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
    await sql`TRUNCATE folders CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  describe("title filter", () => {
    it("matches a plain filter anywhere in the title", async () => {
      await doc(sql, "d1", "Q3 Planning");
      await doc(sql, "d2", "Unrelated");

      const rows = await listReadableDocs(sql, ALICE, WS, { q: "plan" });
      expect(titles(rows)).toEqual(["Q3 Planning"]);
    });

    it("treats * and ? as wildcards", async () => {
      await doc(sql, "d1", "Q3 Report");
      await doc(sql, "d2", "Q4 Report");
      await doc(sql, "d3", "Annual Report");

      expect(titles(await listReadableDocs(sql, ALICE, WS, { q: "Q?" }))).toEqual([]);
      expect(titles(await listReadableDocs(sql, ALICE, WS, { q: "Q? Report" }))).toEqual(["Q3 Report", "Q4 Report"]);
      expect(titles(await listReadableDocs(sql, ALICE, WS, { q: "Q3*" }))).toEqual(["Q3 Report"]);
    });

    it("treats LIKE metacharacters in the filter as literal text", async () => {
      await doc(sql, "d1", "Discount 50% off");
      await doc(sql, "d2", "Plain title");
      await doc(sql, "d3", "snake_case notes");
      await doc(sql, "d4", "snakeXcase notes");

      expect(titles(await listReadableDocs(sql, ALICE, WS, { q: "%" }))).toEqual(["Discount 50% off"]);
      expect(titles(await listReadableDocs(sql, ALICE, WS, { q: "snake_case" }))).toEqual(["snake_case notes"]);
    });
  });

  describe("folder scoping", () => {
    beforeEach(async () => {
      await createFolder(sql, { workspaceId: WS, folderId: "f_root", owner: "user:alice", title: "Root", parentId: null });
      await createFolder(sql, { workspaceId: WS, folderId: "f_kid", owner: "user:alice", title: "Kid", parentId: "f_root" });
      await createFolder(sql, { workspaceId: WS, folderId: "f_other", owner: "user:alice", title: "Other", parentId: null });
      await doc(sql, "in_root", "In Root", "f_root");
      await doc(sql, "in_kid", "In Kid", "f_kid");
      await doc(sql, "in_other", "In Other", "f_other");
      await doc(sql, "loose", "Loose", null);
    });

    it("confines the list to a folder's whole subtree", async () => {
      const subtree = await getFolderSubtreeIds(sql, "f_root", WS);
      const rows = await listReadableDocs(sql, ALICE, WS, { parentIds: subtree });
      expect(titles(rows)).toEqual(["In Kid", "In Root"]);
    });

    it("combines a folder scope with a title filter", async () => {
      const subtree = await getFolderSubtreeIds(sql, "f_root", WS);
      const rows = await listReadableDocs(sql, ALICE, WS, { parentIds: subtree, q: "*Kid" });
      expect(titles(rows)).toEqual(["In Kid"]);
    });

    it("treats an empty subtree as nothing, not everything", async () => {
      expect(await listReadableDocs(sql, ALICE, WS, { parentIds: [] })).toEqual([]);
    });

    it("never widens past the ACL gate", async () => {
      await doc(sql, "secret", "Secret In Root", "f_root", ["user:bob"]);
      const subtree = await getFolderSubtreeIds(sql, "f_root", WS);

      const rows = await listReadableDocs(sql, ALICE, WS, { parentIds: subtree });
      expect(titles(rows)).toEqual(["In Kid", "In Root"]);
    });
  });

  describe("collection scoping", () => {
    it("lists only the scope's documents, intersected with a folder and the ACL", async () => {
      await createFolder(sql, { workspaceId: WS, folderId: "f_root", owner: "user:alice", title: "Root", parentId: null });
      await doc(sql, "in_root", "In Root", "f_root");
      await doc(sql, "also_root", "Also Root", "f_root");
      await doc(sql, "loose", "Loose");
      await doc(sql, "secret", "Secret", null, ["user:bob"]);

      expect(titles(await listReadableDocs(sql, ALICE, WS, { docIds: ["in_root", "loose", "secret"] }))).toEqual(["In Root", "Loose"]);
      expect(titles(await listReadableDocs(sql, ALICE, WS, { docIds: ["in_root", "loose"], parentIds: ["f_root"] }))).toEqual(["In Root"]);
    });

    it("treats an empty scope as nothing, not everything", async () => {
      await doc(sql, "loose", "Loose");
      expect(await listReadableDocs(sql, ALICE, WS, { docIds: [] })).toEqual([]);
    });
  });

  describe("listEditableDocs", () => {
    it("confines to the scope's documents, and an empty scope to nothing", async () => {
      await doc(sql, "a", "A", null, ALICE);
      await doc(sql, "b", "B", null, ALICE);
      await sql`UPDATE docs SET acl_writers = ${ALICE}`;

      expect(titles(await listEditableDocs(sql, ALICE, WS, {}))).toEqual(["A", "B"]);
      expect(titles(await listEditableDocs(sql, ALICE, WS, { docIds: ["b"] }))).toEqual(["B"]);
      expect(await listEditableDocs(sql, ALICE, WS, { docIds: [] })).toEqual([]);
    });
  });
});
