import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LIBRARY_LIST_CAP } from "@stuga/protocol/domain/limits";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, listDocs, type DocSortKey } from "./docs.js";
import { createFolder, listFolders } from "./folders.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const ALICE = ["user:alice", "org:all"];

describe.skipIf(!URL)("list sorting", () => {
  let sql: Sql;
  const WS = "ws-list-sort";

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

  async function seedDocs() {
    for (const [docId, title] of [
      ["d_b", "banana"],
      ["d_a", "Apple"],
      ["d_c", "cherry"],
    ] as const) {
      await createDoc(sql, { workspaceId: WS, docId, owner: "user:alice", title, parentId: null, aclPrincipals: ALICE });
    }
    await sql`UPDATE docs SET updated_at = '2026-01-01T00:00:00Z' WHERE doc_id = 'd_a'`;
    await sql`UPDATE docs SET updated_at = '2026-02-01T00:00:00Z' WHERE doc_id = 'd_b'`;
    await sql`UPDATE docs SET updated_at = '2026-03-01T00:00:00Z' WHERE doc_id = 'd_c'`;
  }

  const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title);

  it("defaults to newest-edited first", async () => {
    await seedDocs();
    expect(titles(await listDocs(sql, ALICE, WS))).toEqual(["cherry", "banana", "Apple"]);
  });

  it("sorts by title case-insensitively in both directions", async () => {
    await seedDocs();
    expect(titles(await listDocs(sql, ALICE, WS, { sort: "title", order: "asc" }))).toEqual([
      "Apple",
      "banana",
      "cherry",
    ]);
    expect(titles(await listDocs(sql, ALICE, WS, { sort: "title", order: "desc" }))).toEqual([
      "cherry",
      "banana",
      "Apple",
    ]);
  });

  it("sorts by created_at", async () => {
    await seedDocs();
    await sql`UPDATE docs SET created_at = '2026-05-01T00:00:00Z' WHERE doc_id = 'd_c'`;
    await sql`UPDATE docs SET created_at = '2026-04-01T00:00:00Z' WHERE doc_id = 'd_a'`;
    await sql`UPDATE docs SET created_at = '2026-06-01T00:00:00Z' WHERE doc_id = 'd_b'`;
    expect(titles(await listDocs(sql, ALICE, WS, { sort: "created_at", order: "asc" }))).toEqual([
      "Apple",
      "cherry",
      "banana",
    ]);
  });

  it("returns a stable page when every row shares a timestamp", async () => {
    await seedDocs();
    await sql`UPDATE docs SET updated_at = '2026-07-01T00:00:00Z'`;
    const first = (await listDocs(sql, ALICE, WS)).map((d) => d.doc_id);
    for (let i = 0; i < 9; i++) {
      expect((await listDocs(sql, ALICE, WS)).map((d) => d.doc_id)).toEqual(first);
    }
  });

  it("ignores an unknown sort key instead of interpolating it", async () => {
    await seedDocs();
    const injections = [
      "title; DROP TABLE docs--",
      "updated_at DESC, (SELECT 1)",
      "'; DELETE FROM docs; --",
      "",
      "owner",
    ];
    for (const raw of injections) {
      const rows = await listDocs(sql, ALICE, WS, { sort: raw as DocSortKey });
      expect(titles(rows)).toEqual(["cherry", "banana", "Apple"]);
    }
    expect((await listDocs(sql, ALICE, WS)).length).toBe(3);
  });

  it("caps the page, and never above the hard ceiling", async () => {
    for (let i = 0; i < 12; i++) {
      await createDoc(sql, {
        workspaceId: WS,
        docId: `d_${String(i).padStart(3, "0")}`,
        owner: "user:alice",
        title: `doc ${i}`,
        parentId: null,
        aclPrincipals: ALICE,
      });
    }
    expect((await listDocs(sql, ALICE, WS, { limit: 5 })).length).toBe(5);
    expect((await listDocs(sql, ALICE, WS, { limit: 100_000 })).length).toBe(12);
  });

  it("lists at most the library cap when the caller names no limit", async () => {
    await Promise.all(
      Array.from({ length: LIBRARY_LIST_CAP + 1 }, (_, i) =>
        createDoc(sql, {
          workspaceId: WS,
          docId: `d_cap_${String(i).padStart(3, "0")}`,
          owner: "user:alice",
          title: `doc ${i}`,
          parentId: null,
          aclPrincipals: ALICE,
        }),
      ),
    );
    expect((await listDocs(sql, ALICE, WS)).length).toBe(LIBRARY_LIST_CAP);
  });

  it("orders folders A→Z by default, case-insensitively, and stably", async () => {
    for (const [folderId, title] of [
      ["f_b", "beta"],
      ["f_a", "Alpha"],
      ["f_c", "gamma"],
    ] as const) {
      await createFolder(sql, { workspaceId: WS, folderId, owner: "user:alice", title, parentId: null });
    }
    expect(titles(await listFolders(sql, ALICE, WS))).toEqual(["Alpha", "beta", "gamma"]);
    expect(titles(await listFolders(sql, ALICE, WS, undefined, { order: "desc" }))).toEqual([
      "gamma",
      "beta",
      "Alpha",
    ]);
    expect(await listFolders(sql, ["user:mallory"], WS)).toEqual([]);
  });

  it("returns the full folder row, ACL included", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "f_x", owner: "user:alice", title: "X", parentId: null });
    const [folder] = await listFolders(sql, ALICE, WS);
    expect(folder).toMatchObject({ folder_id: "f_x", title: "X", owner: "user:alice", parent_id: null });
    expect(folder?.acl_principals).toBeDefined();
  });
});
