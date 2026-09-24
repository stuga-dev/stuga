import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, listDocs, updateDoc, findExpiredTrash } from "./docs.js";
import {
  createFolder,
  listFolders,
  getFolderSubtreeIds,
  getFolderAncestors,
  getFolderContentCounts,
  listAncestorFolderIds,
  deleteFolderCascade,
} from "./folders.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const ALICE = ["user:alice", "org:all"];

describe.skipIf(!URL)("folders", () => {
  let sql: Sql;
  const WS = "ws-folders-test";
  const OTHER_WS = "ws-other-tenant";

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
    await seedWorkspaces(sql, WS, OTHER_WS);
  });

  /** f_root/d_root, f_root/f_child/d_child, and an untouched f_sib/d_sib. */
  async function seedTree() {
    await createFolder(sql, { workspaceId: WS, folderId: "f_root", owner: "user:alice", title: "Root", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "f_child", owner: "user:alice", title: "Child", parentId: "f_root" });
    await createFolder(sql, { workspaceId: WS, folderId: "f_sib", owner: "user:alice", title: "Sibling", parentId: null });
    for (const [docId, parentId] of [
      ["d_root", "f_root"],
      ["d_child", "f_child"],
      ["d_sib", "f_sib"],
    ] as const) {
      await createDoc(sql, { workspaceId: WS, docId, owner: "user:alice", title: docId, parentId, aclPrincipals: ALICE });
    }
  }

  it("walks the subtree including itself, over multiple levels", async () => {
    await seedTree();
    const ids = await getFolderSubtreeIds(sql, "f_root", WS);
    expect(ids.sort()).toEqual(["f_child", "f_root"]);
    expect(await getFolderSubtreeIds(sql, "f_child", WS)).toEqual(["f_child"]);
    expect(await getFolderSubtreeIds(sql, "f_root", OTHER_WS)).toEqual([]);
  });

  it("walks ancestors only inside the requested workspace", async () => {
    await seedTree();
    const chain = await getFolderAncestors(sql, "f_child", WS);
    expect(chain.map((f) => f.folder_id)).toEqual(["f_root", "f_child"]);
    expect(await getFolderAncestors(sql, "f_child", OTHER_WS)).toEqual([]);
  });

  it("names every folder above a set of documents, inside the workspace", async () => {
    await seedTree();
    await createDoc(sql, { workspaceId: WS, docId: "d_loose", owner: "user:alice", title: "loose", aclPrincipals: ALICE });
    expect((await listAncestorFolderIds(sql, ["d_child", "d_loose"], WS)).sort()).toEqual(["f_child", "f_root"]);
    expect(await listAncestorFolderIds(sql, ["d_sib"], WS)).toEqual(["f_sib"]);
    expect(await listAncestorFolderIds(sql, ["d_child"], OTHER_WS)).toEqual([]);
    expect(await listAncestorFolderIds(sql, [], WS)).toEqual([]);
  });

  it("counts active docs and descendant folders for the delete confirmation", async () => {
    await seedTree();
    expect(await getFolderContentCounts(sql, "f_root", WS)).toEqual({ docs: 2, folders: 1 });
    expect(await getFolderContentCounts(sql, "f_child", WS)).toEqual({ docs: 1, folders: 0 });

    await updateDoc(sql, "d_child", { trashed: true });
    expect(await getFolderContentCounts(sql, "f_root", WS)).toEqual({ docs: 1, folders: 1 });

    await createFolder(sql, { workspaceId: WS, folderId: "f_empty", owner: "user:alice", title: "Empty", parentId: null });
    expect(await getFolderContentCounts(sql, "f_empty", WS)).toEqual({ docs: 0, folders: 0 });
  });

  it("deletes the whole subtree and moves its documents to Trash", async () => {
    await seedTree();

    const res = await deleteFolderCascade(sql, "f_root", WS);
    expect(res.folderIds.sort()).toEqual(["f_child", "f_root"]);
    expect(res.trashedDocIds.sort()).toEqual(["d_child", "d_root"]);

    const folders = await listFolders(sql, ALICE, WS);
    expect(folders.map((f) => f.folder_id)).toEqual(["f_sib"]);

    const active = await listDocs(sql, ALICE, WS);
    expect(active.map((d) => d.doc_id)).toEqual(["d_sib"]);
    const trashed = await listDocs(sql, ALICE, WS, { trashedOnly: true });
    expect(trashed.map((d) => d.doc_id).sort()).toEqual(["d_child", "d_root"]);
    for (const d of trashed) expect(d.trashed_at).toBeTruthy();
  });

  it("leaves an already-trashed doc's retention clock untouched", async () => {
    await seedTree();
    await updateDoc(sql, "d_child", { trashed: true });
    await sql`UPDATE docs SET trashed_at = now() - interval '29 days' WHERE doc_id = 'd_child'`;
    const before = await sql<{ trashed_at: string }[]>`SELECT trashed_at FROM docs WHERE doc_id = 'd_child'`;

    const res = await deleteFolderCascade(sql, "f_root", WS);
    expect(res.trashedDocIds).toEqual(["d_root"]);

    const after = await sql<{ trashed_at: string }[]>`SELECT trashed_at FROM docs WHERE doc_id = 'd_child'`;
    expect(after[0]!.trashed_at).toEqual(before[0]!.trashed_at);
    const expired = (await findExpiredTrash(sql, 28)).map((d) => d.doc_id);
    expect(expired).toContain("d_child");
    expect(expired).not.toContain("d_root");
  });

  it("never crosses a workspace boundary", async () => {
    await seedTree();
    await createFolder(sql, { workspaceId: OTHER_WS, folderId: "f_other", owner: "user:bob", title: "Other", parentId: null });
    await createDoc(sql, {
      workspaceId: OTHER_WS,
      docId: "d_other",
      owner: "user:bob",
      title: "Other doc",
      parentId: "f_other",
      aclPrincipals: ["user:bob"],
    });

    const miss = await deleteFolderCascade(sql, "f_other", WS);
    expect(miss).toEqual({ folderIds: [], trashedDocIds: [] });
    expect(await listFolders(sql, ["user:bob"], OTHER_WS)).toHaveLength(1);

    await deleteFolderCascade(sql, "f_root", WS);
    const otherDocs = await listDocs(sql, ["user:bob"], OTHER_WS);
    expect(otherDocs.map((d) => d.doc_id)).toEqual(["d_other"]);
    expect(otherDocs[0]!.trashed).toBe(false);
  });

  it("deleting an empty folder touches no documents", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "f_empty", owner: "user:alice", title: "Empty", parentId: null });
    await createDoc(sql, { workspaceId: WS, docId: "d_top", owner: "user:alice", title: "Top", aclPrincipals: ALICE });

    const res = await deleteFolderCascade(sql, "f_empty", WS);
    expect(res).toEqual({ folderIds: ["f_empty"], trashedDocIds: [] });
    const active = await listDocs(sql, ALICE, WS);
    expect(active.map((d) => d.doc_id)).toEqual(["d_top"]);
  });

  it("survives a parent_id cycle instead of looping forever", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "f_a", owner: "user:alice", title: "A", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "f_b", owner: "user:alice", title: "B", parentId: "f_a" });
    await sql`UPDATE folders SET parent_id = 'f_b' WHERE folder_id = 'f_a'`;

    const ids = await getFolderSubtreeIds(sql, "f_a", WS);
    expect(ids.sort()).toEqual(["f_a", "f_b"]);
    await createDoc(sql, { workspaceId: WS, docId: "d_cycle", owner: "user:alice", title: "cycle", parentId: "f_b", aclPrincipals: ALICE });
    expect((await listAncestorFolderIds(sql, ["d_cycle"], WS)).sort()).toEqual(["f_a", "f_b"]);
    const res = await deleteFolderCascade(sql, "f_a", WS);
    expect(res.folderIds.sort()).toEqual(["f_a", "f_b"]);
    expect(await listFolders(sql, ALICE, WS)).toHaveLength(0);
  });
});
