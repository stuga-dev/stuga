import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc } from "./docs.js";
import { indexDoc, searchDocs, askDocs, getEmbeddingHash, getReusableChunkEmbeddings } from "./search.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

const DIMS = 1024;
/** A vector pointing mostly along axis `i`. */
function vec(i: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0.01);
  v[i % DIMS] = 1;
  return v;
}

/** A unit vector at cosine similarity `cos` to QUERY. */
function towardQuery(cos: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0);
  v[0] = cos;
  v[1] = Math.sqrt(1 - cos * cos);
  return v;
}
const QUERY = towardQuery(1);

describe.skipIf(!URL)("hybrid search and chunk embeddings", () => {
  let sql: Sql;
  const WS = "ws-test";
  const ALICE = ["user:alice"];
  const BOB = ["user:bob"];

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

  async function makeDoc(docId: string, title: string, body: string, owner = "alice", chunks: { content: string; embedding: number[] | null }[] = []) {
    await createDoc(sql, { docId, workspaceId: WS, owner: `user:${owner}`, title, aclPrincipals: [`user:${owner}`] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId,
      snapshotSeq: 1,
      title,
      searchText: body,
      embeddingHash: `hash-${docId}`,
      chunks: chunks.map((c, i) => ({ ...c, embedHash: `${docId}-eh-${i}` })),
    });
  }

  it("keyword leg finds a doc by body text", async () => {
    await makeDoc("d1", "Ocean Facts", "The ocean covers seventy percent of the planet surface.");
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "ocean planet", queryEmbedding: null });
    expect(res.map((r) => r.doc_id)).toContain("d1");
  });

  it("defaults an invalid result limit instead of passing it to PostgreSQL", async () => {
    await makeDoc("bounded", "Bounded Search", "bounded search result");
    await expect(
      searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6,
        workspaceId: WS,
        principals: ALICE,
        query: "bounded",
        queryEmbedding: null,
        limit: -1,
      }),
    ).resolves.toEqual(expect.any(Array));
  });

  it("semantic leg finds a doc through its best chunk", async () => {
    await makeDoc("d2", "Mixed Doc", "intro paragraph ... unrelated ... target passage here", "alice", [
      { content: "intro paragraph about cats", embedding: vec(5) },
      { content: "target passage about quantum entanglement", embedding: vec(42) },
    ]);
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zzqxq nomatch keyword", queryEmbedding: vec(42) });
    const hit = res.find((r) => r.doc_id === "d2");
    expect(hit).toBeTruthy();
    expect(hit!.sem_score).toBeGreaterThan(0.9);
  });

  it("orders documents found only by meaning by their similarity, with no keyword credit", async () => {
    await makeDoc("sem-a", "Alpha", "unrelated alpha text", "alice", [{ content: "alpha", embedding: towardQuery(0.5) }]);
    await makeDoc("sem-b", "Beta", "unrelated beta text", "alice", [{ content: "beta", embedding: towardQuery(0.8) }]);
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY });
    expect(res.map((r) => r.doc_id)).toEqual(["sem-b", "sem-a"]);
    expect(Number(res[0]!.score)).toBeCloseTo(1 / 61, 12);
    expect(Number(res[1]!.score)).toBeCloseTo(1 / 62, 12);
  });

  it("credits a document with 1/(60 + rank) for each leg it appears in, and nothing for a leg it is absent from", async () => {
    await makeDoc("both", "Zephyr", "zephyr winds", "alice", [{ content: "zephyr winds", embedding: towardQuery(0.9) }]);
    await makeDoc("kw-only", "Notes", "zephyr winds");
    await makeDoc("sem-only", "Other", "calm air", "alice", [{ content: "calm air", embedding: towardQuery(0.6) }]);
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY });
    const hit = (id: string) => res.find((r) => r.doc_id === id)!;
    expect(hit("both").kw_rank).toBeGreaterThan(hit("kw-only").kw_rank);
    expect(hit("sem-only").kw_rank).toBe(0);
    expect(hit("kw-only").sem_score).toBe(0);
    expect(res[0]!.doc_id).toBe("both");
    expect(Number(hit("both").score)).toBeCloseTo(1 / 61 + 1 / 61, 12);
    expect(Number(hit("kw-only").score)).toBeCloseTo(1 / 62, 12);
    expect(Number(hit("sem-only").score)).toBeCloseTo(1 / 62, 12);
  });

  it.each([0.5, 0.6, 1, 2])("returns a document found only by meaning iff its best chunk's cosine distance is below a cutoff of %s", async (maxDistance) => {
    const distances = [0.3, 0.55, 0.8, 1.3];
    for (const d of distances) {
      await makeDoc(`at-${d}`, "Notes", "unrelated filler", "alice", [{ content: "unrelated filler", embedding: towardQuery(1 - d) }]);
    }
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY });
    expect(res.map((r) => r.doc_id).sort()).toEqual(distances.filter((d) => d < maxDistance).map((d) => `at-${d}`).sort());
  });

  it("ACL gate: a non-principal never sees the doc on either leg", async () => {
    await makeDoc("d3", "Secret", "confidential ocean dossier", "alice", [
      { content: "confidential ocean dossier", embedding: vec(7) },
    ]);
    const kw = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: BOB, query: "ocean dossier", queryEmbedding: null });
    const sem = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: BOB, query: "ocean", queryEmbedding: vec(7) });
    expect(kw.map((r) => r.doc_id)).not.toContain("d3");
    expect(sem.map((r) => r.doc_id)).not.toContain("d3");
  });

  // The HNSW scan hands back its nearest ef_search tuples before any WHERE gate
  // runs, so a neighbourhood that belongs to someone else used to leave the
  // semantic leg empty. Real tables plan that scan; this tiny one would sort
  // exactly instead, so the connection rules the sort out.
  it("semantic leg finds a visible passage behind hundreds of nearer ones the searcher cannot see", async () => {
    await makeDoc("bobs", "Bob's notes", "unrelated", "bob",
      Array.from({ length: 300 }, (_, i) => ({ content: `decoy ${i}`, embedding: towardQuery(0.99 - i * 1e-5) })));
    await makeDoc("alices", "Alice's notes", "unrelated", "alice", [{ content: "the one alice can see", embedding: towardQuery(0.75) }]);
    const indexed = createClient(`${URL!}${URL!.includes("?") ? "&" : "?"}enable_seqscan=off&enable_sort=off`);

    const docs = await searchDocs(indexed, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY });
    expect(docs.map((r) => r.doc_id)).toEqual(["alices"]);
    const passages = await askDocs(indexed, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY });
    expect(passages.map((p) => p.content)).toEqual(["the one alice can see"]);
  });

  it("indexDoc replaces the chunk set on re-index (no stale chunks)", async () => {
    await makeDoc("d4", "V1", "old body", "alice", [{ content: "old chunk", embedding: vec(1) }]);
    let n = await sql<{ c: number }[]>`SELECT count(*)::int c FROM doc_chunks WHERE doc_id = 'd4'`;
    expect(n[0]!.c).toBe(1);
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "d4", snapshotSeq: 2, title: "V2", searchText: "new body",
      embeddingHash: "hash-d4-v2",
      chunks: [{ content: "new a", embedding: vec(2), embedHash: "d4-a" }, { content: "new b", embedding: vec(3), embedHash: "d4-b" }],
    });
    n = await sql<{ c: number }[]>`SELECT count(*)::int c FROM doc_chunks WHERE doc_id = 'd4'`;
    expect(n[0]!.c).toBe(2);
  });

  it("an index with an older seq changes neither the row nor its chunks", async () => {
    await makeDoc("d5", "Current", "current text", "alice", [{ content: "current chunk", embedding: vec(9) }]);
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "d5", snapshotSeq: 0, title: "STALE", searchText: "stale text",
      embeddingHash: "hash-stale", chunks: [{ content: "stale chunk", embedding: vec(0), embedHash: "d5-stale" }],
    });
    const rows = await sql<{ title: string; c: number }[]>`
      SELECT d.title, (SELECT count(*)::int FROM doc_chunks WHERE doc_id='d5') AS c
      FROM docs d WHERE d.doc_id='d5'`;
    expect(rows[0]!.title).toBe("Current");
    expect(rows[0]!.c).toBe(1);
  });

  it("getEmbeddingHash round-trips and is null for unknown docs", async () => {
    await makeDoc("d6", "Hashed", "body");
    expect(await getEmbeddingHash(sql, "d6")).toBe("hash-d6");
    expect(await getEmbeddingHash(sql, "nope")).toBeNull();
  });

  it("getReusableChunkEmbeddings returns embed_hash → vector for embedded chunks only", async () => {
    await createDoc(sql, { docId: "d7", workspaceId: WS, owner: "user:alice", title: "Reuse", aclPrincipals: ["user:alice"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "d7", snapshotSeq: 1, title: "Reuse", searchText: "body",
      embeddingHash: "hash-d7",
      chunks: [
        { content: "a", embedding: vec(2), embedHash: "h-a" },
        { content: "b", embedding: null, embedHash: "h-b" },
        { content: "c", embedding: vec(3), embedHash: "h-c" },
      ],
    });

    const map = await getReusableChunkEmbeddings(sql, "d7", EMBEDDING_DIMS);
    expect([...map.keys()].sort()).toEqual(["h-a", "h-c"]);
    expect(map.get("h-a")!.length).toBe(DIMS);
    expect(map.get("h-b")).toBeUndefined();
    expect(map.get("h-a")![2]).toBeCloseTo(1);
  });
});
