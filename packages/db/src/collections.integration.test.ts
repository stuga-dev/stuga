import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc } from "./docs.js";
import { createFolder } from "./folders.js";
import { indexDoc, searchDocs } from "./search.js";
import {
  createCollection,
  listCollections,
  addCollectionItems,
  removeCollectionItems,
  filterVisibleRefs,
  listCollectionItems,
  expandCollectionScope,
  readsEveryMember,
} from "./collections.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

const ALICE = ["user:alice", "org:all"];

describe.skipIf(!URL)("collections", () => {
  let sql: Sql;
  const WS = "ws-test";
  const reach = { principals: ALICE, workspaceId: WS, scopeFolderIds: null };

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE collections CASCADE`;
    await sql`TRUNCATE docs CASCADE`;
    await sql`TRUNCATE folders CASCADE`;
    await seedWorkspaces(sql, WS, "ws-other");
  });

  it("CRUD + member add/remove with item count", async () => {
    const c = await createCollection(sql, { workspaceId: WS, collectionId: "col1", owner: "alice", name: "Q3" });
    expect(c.name).toBe("Q3");
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Doc 1", aclPrincipals: ["user:alice"] });
    expect(await addCollectionItems(sql, "col1", { docIds: ["d1"] })).toBe(1);
    expect(await addCollectionItems(sql, "col1", { docIds: ["d1"] })).toBe(0);
    let items = await listCollectionItems(sql, "col1", reach);
    expect(items).toHaveLength(1);
    expect(items[0]!.doc_id).toBe("d1");
    expect(items[0]!.title).toBe("Doc 1");

    const list = await listCollections(sql, "alice", reach);
    expect(list[0]!.item_count).toBe(1);

    expect(await removeCollectionItems(sql, "col1", { docIds: ["d1"] })).toBe(1);
    expect(await removeCollectionItems(sql, "col1", { docIds: ["d1"] })).toBe(0);
    items = await listCollectionItems(sql, "col1", reach);
    expect(items).toHaveLength(0);
  });

  it("batch add/remove a mix of docs + folders, with ACL filtering and idempotency", async () => {
    await createCollection(sql, { workspaceId: WS, collectionId: "colB", owner: "alice", name: "Batch" });
    await createFolder(sql, { workspaceId: WS, folderId: "fA", owner: "user:alice", title: "Folder A", parentId: null });
    await createDoc(sql, { workspaceId: WS, docId: "dA", owner: "user:alice", title: "Doc A", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dB", owner: "user:alice", title: "Doc B", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dSecret", owner: "user:bob", title: "Secret", aclPrincipals: ["user:bob"] });
    await createFolder(sql, { workspaceId: WS, folderId: "fSecret", owner: "user:bob", title: "Secret folder", parentId: null, aclPrincipals: ["user:bob"] });

    const visible = await filterVisibleRefs(sql, reach, ["dA", "dB", "dSecret"], ["fA", "fSecret"]);
    expect(visible.docIds.sort()).toEqual(["dA", "dB"]);
    expect(visible.folderIds).toEqual(["fA"]);

    await addCollectionItems(sql, "colB", visible);
    await addCollectionItems(sql, "colB", visible);
    let items = await listCollectionItems(sql, "colB", reach);
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.doc_id).map((i) => i.doc_id).sort()).toEqual(["dA", "dB"]);
    expect(items.filter((i) => i.folder_id).map((i) => i.folder_id)).toEqual(["fA"]);

    await removeCollectionItems(sql, "colB", { docIds: ["dA"], folderIds: ["fA"] });
    items = await listCollectionItems(sql, "colB", reach);
    expect(items).toHaveLength(1);
    expect(items[0]!.doc_id).toBe("dB");

    await addCollectionItems(sql, "colB", { docIds: [], folderIds: [] });
    await removeCollectionItems(sql, "colB", {});
    expect(await listCollectionItems(sql, "colB", reach)).toHaveLength(1);
  });

  it("lists and counts only the members a caller can read", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "fA", owner: "user:alice", title: "Folder A", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "fSecret", owner: "user:bob", title: "Secret folder", parentId: null, aclPrincipals: ["user:bob"] });
    await createDoc(sql, { workspaceId: WS, docId: "dA", owner: "user:alice", title: "Doc A", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dTrashed", owner: "user:alice", title: "Trashed", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dUnshared", owner: "user:bob", title: "Unshared", aclPrincipals: ["user:bob"] });
    await createCollection(sql, { workspaceId: WS, collectionId: "col1", owner: "alice", name: "Mixed" });
    await addCollectionItems(sql, "col1", { docIds: ["dA", "dTrashed", "dUnshared"], folderIds: ["fA", "fSecret"] });
    await sql`UPDATE docs SET trashed = TRUE WHERE doc_id = 'dTrashed'`;

    const items = await listCollectionItems(sql, "col1", reach);
    expect(items.map((i) => i.doc_id ?? i.folder_id).sort()).toEqual(["dA", "fA"]);
    expect((await listCollections(sql, "alice", reach))[0]!.item_count).toBe(2);

    const bob = { principals: ["user:bob"], workspaceId: WS, scopeFolderIds: null };
    expect((await listCollectionItems(sql, "col1", bob)).map((i) => i.doc_id ?? i.folder_id).sort()).toEqual(["dUnshared", "fSecret"]);
  });

  it("confines a folder-scoped key to members inside its folders", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "fIn", owner: "user:alice", title: "In", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "fOut", owner: "user:alice", title: "Out", parentId: null });
    await createDoc(sql, { workspaceId: WS, docId: "dIn", owner: "user:alice", title: "In", parentId: "fIn", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dOut", owner: "user:alice", title: "Out", parentId: "fOut", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dRoot", owner: "user:alice", title: "Root", aclPrincipals: ["user:alice"] });
    const scoped = { ...reach, scopeFolderIds: ["fIn"] };

    const visible = await filterVisibleRefs(sql, scoped, ["dIn", "dOut", "dRoot"], ["fIn", "fOut"]);
    expect(visible).toEqual({ docIds: ["dIn"], folderIds: ["fIn"] });

    await createCollection(sql, { workspaceId: WS, collectionId: "col1", owner: "alice", name: "Scoped" });
    await addCollectionItems(sql, "col1", { docIds: ["dIn", "dOut", "dRoot"], folderIds: ["fIn", "fOut"] });
    expect((await listCollectionItems(sql, "col1", scoped)).map((i) => i.doc_id ?? i.folder_id).sort()).toEqual(["dIn", "fIn"]);
    expect((await listCollections(sql, "alice", scoped))[0]!.item_count).toBe(2);
    expect((await listCollections(sql, "alice", reach))[0]!.item_count).toBe(5);
    expect((await expandCollectionScope(sql, "col1", scoped)).sort()).toEqual(["dIn"]);
    expect((await expandCollectionScope(sql, "col1", reach)).sort()).toEqual(["dIn", "dOut", "dRoot"]);
  });

  it("expands to nothing for a folder-scoped key whose readable members all lie outside its folders", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "fIn", owner: "user:alice", title: "In", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "fOut", owner: "user:alice", title: "Out", parentId: null });
    await createDoc(sql, { workspaceId: WS, docId: "dOut", owner: "user:alice", title: "Out", parentId: "fOut", aclPrincipals: ["user:alice"] });
    await createCollection(sql, { workspaceId: WS, collectionId: "col1", owner: "alice", name: "Elsewhere" });
    await addCollectionItems(sql, "col1", { docIds: ["dOut"] });

    expect(await expandCollectionScope(sql, "col1", { ...reach, scopeFolderIds: ["fIn"] })).toEqual([]);
    expect(await expandCollectionScope(sql, "col1", reach)).toEqual(["dOut"]);
  });

  it("says whether a reach reads every member of a collection", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "fIn", owner: "user:alice", title: "In", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "fOut", owner: "user:alice", title: "Out", parentId: null });
    await createDoc(sql, { workspaceId: WS, docId: "dIn", owner: "user:alice", title: "In", parentId: "fIn", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "dOut", owner: "user:alice", title: "Out", parentId: "fOut", aclPrincipals: ["user:alice"] });
    const scoped = { ...reach, scopeFolderIds: ["fIn"] };
    await createCollection(sql, { workspaceId: WS, collectionId: "empty", owner: "alice", name: "Empty" });
    await createCollection(sql, { workspaceId: WS, collectionId: "inside", owner: "alice", name: "Inside" });
    await createCollection(sql, { workspaceId: WS, collectionId: "mixed", owner: "alice", name: "Mixed" });
    await addCollectionItems(sql, "inside", { docIds: ["dIn"], folderIds: ["fIn"] });
    await addCollectionItems(sql, "mixed", { docIds: ["dIn"], folderIds: ["fOut"] });

    expect(await readsEveryMember(sql, "empty", scoped)).toBe(true);
    expect(await readsEveryMember(sql, "inside", scoped)).toBe(true);
    expect(await readsEveryMember(sql, "mixed", scoped)).toBe(false);
    expect(await readsEveryMember(sql, "mixed", reach)).toBe(true);
  });

  it("expands direct docs ∪ recursive folder subtree, gated by ACL", async () => {
    await createFolder(sql, { workspaceId: WS, folderId: "root", owner: "user:alice", title: "Root", parentId: null });
    await createFolder(sql, { workspaceId: WS, folderId: "child", owner: "user:alice", title: "Child", parentId: "root" });
    await createDoc(sql, { workspaceId: WS, docId: "inRoot", owner: "user:alice", title: "In root", parentId: "root", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "inChild", owner: "user:alice", title: "In child", parentId: "child", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "direct", owner: "user:alice", title: "Direct", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "secret", owner: "user:bob", title: "Secret", parentId: "child", aclPrincipals: ["user:bob"] });

    await createCollection(sql, { workspaceId: WS, collectionId: "col1", owner: "alice", name: "Scope" });
    await addCollectionItems(sql, "col1", { docIds: ["direct"], folderIds: ["root"] });

    const scope = await expandCollectionScope(sql, "col1", reach);
    expect(scope.sort()).toEqual(["direct", "inChild", "inRoot"]);
  });

  it("does not traverse a folder chain through another workspace", async () => {
    const OTHER_WS = "ws-other";
    await createFolder(sql, { workspaceId: WS, folderId: "root", owner: "user:alice", title: "Root" });
    await createFolder(sql, {
      workspaceId: OTHER_WS,
      folderId: "foreign-bridge",
      owner: "user:alice",
      title: "Foreign",
      parentId: "root",
    });
    await createFolder(sql, {
      workspaceId: WS,
      folderId: "reentry",
      owner: "user:alice",
      title: "Reentry",
      parentId: "foreign-bridge",
    });
    await createDoc(sql, {
      workspaceId: WS,
      docId: "must-not-leak",
      owner: "user:alice",
      title: "Hidden by tenant break",
      parentId: "reentry",
      aclPrincipals: ["user:alice"],
    });
    await createCollection(sql, { workspaceId: WS, collectionId: "col-tenant", owner: "alice", name: "Scope" });
    await addCollectionItems(sql, "col-tenant", { folderIds: ["root"] });

    expect(await expandCollectionScope(sql, "col-tenant", reach)).toEqual([]);
  });

  it("searchDocs honors scopeDocIds (and empty scope returns nothing)", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Quarterly planning notes", aclPrincipals: ["user:alice"] });
    await createDoc(sql, { workspaceId: WS, docId: "d2", owner: "user:alice", title: "Quarterly budget review", aclPrincipals: ["user:alice"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "d1",
      snapshotSeq: 1,
      title: "Quarterly planning notes",
      searchText: "planning notes for the quarter",
      embeddingHash: "h1",
      chunks: [],
    });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "d2",
      snapshotSeq: 1,
      title: "Quarterly budget review",
      searchText: "budget review for the quarter",
      embeddingHash: "h2",
      chunks: [],
    });

    const all = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "quarterly", queryEmbedding: null });
    expect(all.map((r) => r.doc_id).sort()).toEqual(["d1", "d2"]);

    const scoped = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "quarterly", queryEmbedding: null, scopeDocIds: ["d1"] });
    expect(scoped.map((r) => r.doc_id)).toEqual(["d1"]);

    const empty = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "quarterly", queryEmbedding: null, scopeDocIds: [] });
    expect(empty).toEqual([]);
  });
});
