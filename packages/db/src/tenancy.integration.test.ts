// A workspace-A document must not reach a workspace-B caller on any read path.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSearchSchema } from "./testing/search-schema.js";
import {
  provisionWorkspace,
  addWorkspaceMember,
  upsertGroup,
  getGroupsForMember,
  listWorkspacesForUser,
} from "./workspaces.js";
import { createDoc, listDocs, listEditableDocs } from "./docs.js";
import { indexDoc, searchDocs, askDocs } from "./search.js";
import { listFolders, createFolder } from "./folders.js";
import { searchUsers, getUserAliasByHandle } from "./identity.js";
import { seedUser } from "./testing/fixtures.js";
import { insertAiUsage, usageRollup } from "./agents.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { orgPrincipal, principalsFrom, userPrincipal } from "@stuga/auth";

async function resolvePrincipals(sql: Sql, alias: string, workspaceId: string): Promise<string[]> {
  const groups = await getGroupsForMember(sql, userPrincipal(alias), workspaceId);
  return principalsFrom(alias, workspaceId, "member", groups.map((g) => g.group_id));
}

const URL = process.env.TEST_DATABASE_URL;

const DIMS = 1024;
function vec(i: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0.01);
  v[i % DIMS] = 1;
  return v;
}

describe.skipIf(!URL)("tenant isolation", () => {
  let sql: Sql;
  const WS_A = "ws-A";
  const WS_B = "ws-B";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE workspaces, docs, folders, groups, ai_usage, users, workspace_members CASCADE`;
    await provisionWorkspace(sql, { workspaceId: WS_A, name: "A", owner: "alice" });
    await provisionWorkspace(sql, { workspaceId: WS_B, name: "B", owner: "bob" });
  });

  /** A doc shared with everyone in its workspace, with one embedded chunk. */
  async function everyoneDoc(docId: string, ws: string, owner: string, title: string, body: string, axis: number) {
    await createDoc(sql, {
      docId,
      workspaceId: ws,
      owner: `user:${owner}`,
      title,
      aclPrincipals: [`user:${owner}`, orgPrincipal(ws)],
    });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId,
      snapshotSeq: 1,
      title,
      searchText: body,
      embeddingHash: `h-${docId}`,
      chunks: [{ content: body, embedding: vec(axis), embedHash: `${docId}-eh` }],
    });
  }

  it("a doc shared to EVERYONE in workspace A is invisible to a workspace-B member", async () => {
    await everyoneDoc("a-secret", WS_A, "alice", "Merger Plan", "confidential acquisition of Acme", 5);
    const bobPrincipals = await resolvePrincipals(sql, "bob", WS_B);
    expect(bobPrincipals).toContain(orgPrincipal(WS_B));
    expect(bobPrincipals).not.toContain(orgPrincipal(WS_A));

    const listed = await listDocs(sql, bobPrincipals, WS_B);
    expect(listed.map((d) => d.doc_id)).not.toContain("a-secret");

    const kw = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, principals: bobPrincipals, workspaceId: WS_B, query: "acquisition Acme", queryEmbedding: null });
    expect(kw.map((r) => r.doc_id)).not.toContain("a-secret");

    // The vector index has no tenant column; the docs join is the only guard.
    const sem = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, principals: bobPrincipals, workspaceId: WS_B, query: "acquisition", queryEmbedding: vec(5) });
    expect(sem.map((r) => r.doc_id)).not.toContain("a-secret");

    const chunks = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, principals: bobPrincipals, workspaceId: WS_B, query: "acquisition Acme", queryEmbedding: vec(5) });
    expect(chunks.map((c) => c.doc_id)).not.toContain("a-secret");

    const editable = await listEditableDocs(sql, bobPrincipals, WS_B);
    expect(editable.map((d) => d.doc_id)).not.toContain("a-secret");

    const alicePrincipals = await resolvePrincipals(sql, "alice", WS_A);
    const aliceList = await listDocs(sql, alicePrincipals, WS_A);
    expect(aliceList.map((d) => d.doc_id)).toContain("a-secret");
    const aliceSem = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, principals: alicePrincipals, workspaceId: WS_A, query: "acquisition", queryEmbedding: vec(5) });
    expect(aliceSem.map((r) => r.doc_id)).toContain("a-secret");
  });

  it("one global user can join multiple workspaces without crossing their data boundaries", async () => {
    await addWorkspaceMember(sql, WS_B, "alice");
    expect((await listWorkspacesForUser(sql, "alice")).map((workspace) => workspace.workspace_id).sort()).toEqual([
      WS_A,
      WS_B,
    ]);

    await createDoc(sql, {
      docId: "alice-in-a",
      workspaceId: WS_A,
      owner: "user:alice",
      title: "A only",
      aclPrincipals: ["user:alice"],
    });
    const inB = await listDocs(sql, await resolvePrincipals(sql, "alice", WS_B), WS_B);
    expect(inB.map((doc) => doc.doc_id)).not.toContain("alice-in-a");
    const inA = await listDocs(sql, await resolvePrincipals(sql, "alice", WS_A), WS_A);
    expect(inA.map((doc) => doc.doc_id)).toContain("alice-in-a");
  });

  it("folders are workspace-scoped", async () => {
    await createFolder(sql, { folderId: "fA", workspaceId: WS_A, owner: "user:alice", title: "A folder", aclPrincipals: [`user:alice`, orgPrincipal(WS_A)] });
    const bobPrincipals = await resolvePrincipals(sql, "bob", WS_B);
    const folders = await listFolders(sql, bobPrincipals, WS_B);
    expect(folders.map((f) => f.folder_id)).not.toContain("fA");
  });

  it("identically named groups in different workspaces do not merge members", async () => {
    await upsertGroup(sql, "group:eng", ["user:alice"], WS_A);
    await upsertGroup(sql, "group:eng", ["user:bob"], WS_B);
    const aEng = await getGroupsForMember(sql, "user:alice", WS_A);
    const bEng = await getGroupsForMember(sql, "user:bob", WS_B);
    expect(aEng.flatMap((g) => g.members)).toEqual(["user:alice"]);
    expect(bEng.flatMap((g) => g.members)).toEqual(["user:bob"]);
    const aliceInB = await getGroupsForMember(sql, "user:alice", WS_B);
    expect(aliceInB).toHaveLength(0);
  });

  it("user directory is workspace-scoped (no cross-tenant enumeration)", async () => {
    await seedUser(sql, "alice", "Alice A", "alice@a.com");
    await seedUser(sql, "bob", "Bob B", "bob@b.com");
    expect(await searchUsers(sql, "Alice", WS_B)).toHaveLength(0);
    expect(await getUserAliasByHandle(sql, "alice@a.com", WS_B)).toBeNull();
    await addWorkspaceMember(sql, WS_B, "carol");
    await seedUser(sql, "carol", "Carol C", "carol@b.com");
    expect((await searchUsers(sql, "Carol", WS_B)).map((u) => u.alias)).toEqual(["carol"]);
  });

  it("AI usage is attributed per-workspace: one tenant's spend never shows in the other's rollup", async () => {
    const since = new Date("2000-01-01T00:00:00Z");
    await insertAiUsage(sql, { alias: "alice", workspaceId: WS_A, docId: null, kind: "coauthor", model: "m", inputTokens: 80, outputTokens: 80 });
    const a = await usageRollup(sql, WS_A, since);
    const b = await usageRollup(sql, WS_B, since);
    expect(a.byModel.reduce((s, r) => s + r.input_tokens, 0)).toBe(80);
    expect(b.byModel).toEqual([]);
    expect(b.byAlias).toEqual([]);
  });
});
