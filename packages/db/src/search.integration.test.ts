import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc } from "./docs.js";
import { indexDoc, searchDocs, askDocs, semanticScan, getEmbeddingHash, getReusableChunkEmbeddings } from "./search.js";
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

  it("says whether each hit is a document or a database", async () => {
    await makeDoc("prose", "Vendor notes", "Every vendor we use.");
    await createDoc(sql, { docId: "db", workspaceId: WS, owner: "user:alice", title: "Vendors", docType: "database", aclPrincipals: ["user:alice"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS, docId: "db", snapshotSeq: 1, title: "Vendors", searchText: "Vendor list", embeddingHash: "hash-db", chunks: [] });
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "vendor", queryEmbedding: null });
    expect(Object.fromEntries(res.map((r) => [r.doc_id, r.doc_type]))).toEqual({ prose: "prose", db: "database" });
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

  it.each([0.5, 0.6, 1, 2, null])("returns a document found only by meaning iff its best chunk's cosine distance is below a cutoff of %s", async (maxDistance) => {
    const distances = [0.3, 0.55, 0.8, 1.3];
    for (const d of distances) {
      await makeDoc(`at-${d}`, "Notes", "unrelated filler", "alice", [{ content: "unrelated filler", embedding: towardQuery(1 - d) }]);
    }
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY });
    expect(res.map((r) => r.doc_id).sort()).toEqual(distances.filter((d) => maxDistance === null || d < maxDistance).map((d) => `at-${d}`).sort());
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
  // exactly instead, so the connection rules the sort out, and exactScanMax 0
  // keeps the leg on the index.
  it("semantic leg on the index finds a visible passage behind hundreds of nearer ones the searcher cannot see", async () => {
    await makeDoc("bobs", "Bob's notes", "unrelated", "bob",
      Array.from({ length: 300 }, (_, i) => ({ content: `decoy ${i}`, embedding: towardQuery(0.99 - i * 1e-5) })));
    await makeDoc("alices", "Alice's notes", "unrelated", "alice", [{ content: "the one alice can see", embedding: towardQuery(0.75) }]);
    const indexed = createClient(`${URL!}${URL!.includes("?") ? "&" : "?"}enable_seqscan=off&enable_sort=off`);
    const input = { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY, exactScanMax: 0 };

    expect(await semanticScan(indexed, input)).toBe("index");
    const docs = await searchDocs(indexed, input);
    expect(docs.map((r) => r.doc_id)).toEqual(["alices"]);
    const passages = await askDocs(indexed, input);
    expect(passages.map((p) => p.content)).toEqual(["the one alice can see"]);
  });

  // An HNSW scan stops at its tuple and memory budget, so a searcher who sees a
  // small slice of the node could get nothing from it however far it walks.
  it("counts the chunks the searcher may read, embedded or not, when choosing an exact scan", async () => {
    await seedWorkspaces(sql, "ws-other");
    await createDoc(sql, { docId: "elsewhere", workspaceId: "ws-other", owner: "user:alice", title: "Elsewhere", aclPrincipals: ALICE });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS, docId: "elsewhere", snapshotSeq: 1, title: "Elsewhere", searchText: "x", embeddingHash: "h-elsewhere",
      chunks: Array.from({ length: 20 }, (_, i) => ({ content: `other ${i}`, embedding: towardQuery(0.9), embedHash: `eo-${i}` })) });
    await makeDoc("bobs", "Bob's notes", "x", "bob", Array.from({ length: 20 }, (_, i) => ({ content: `bob ${i}`, embedding: towardQuery(0.9) })));
    for (const id of ["trashed", "hidden"]) {
      await makeDoc(id, id, "x", "alice", Array.from({ length: 20 }, (_, i) => ({ content: `${id} ${i}`, embedding: towardQuery(0.9) })));
    }
    await sql`UPDATE docs SET trashed = TRUE WHERE doc_id = 'trashed'`;
    await sql`UPDATE docs SET search_hidden = TRUE WHERE doc_id = 'hidden'`;
    await makeDoc("unembedded", "Unembedded", "x", "alice", Array.from({ length: 20 }, (_, i) => ({ content: `raw ${i}`, embedding: null })));
    await makeDoc("alices", "Alice's notes", "x", "alice", Array.from({ length: 3 }, (_, i) => ({ content: `alice ${i}`, embedding: towardQuery(0.8) })));
    const input = (exactScanMax: number, scopeDocIds?: string[]) =>
      ({ embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "q", queryEmbedding: QUERY, exactScanMax, scopeDocIds });

    // Alice's 3 embedded chunks and the 20 unembedded ones: the count is an upper bound.
    expect(await semanticScan(sql, input(23))).toBe("exact");
    expect(await semanticScan(sql, input(22))).toBe("index");
    expect(await semanticScan(sql, input(0, ["alices"]))).toBe("index");
    await makeDoc("small", "Small", "x", "alice", [{ content: "one", embedding: towardQuery(0.8) }]);
    expect(await semanticScan(sql, input(1, ["small"]))).toBe("exact");
  });

  it("an exact semantic leg returns the visible passages in distance order, whatever crowds the query", async () => {
    await seedWorkspaces(sql, "ws-other");
    await createDoc(sql, { docId: "crowd", workspaceId: "ws-other", owner: "user:alice", title: "Crowd", aclPrincipals: ALICE });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS, docId: "crowd", snapshotSeq: 1, title: "Crowd", searchText: "x", embeddingHash: "h-crowd",
      chunks: Array.from({ length: 300 }, (_, i) => ({ content: `crowd ${i}`, embedding: towardQuery(0.99 - i * 1e-5), embedHash: `ec-${i}` })) });
    await makeDoc("bobs", "Bob's notes", "x", "bob", Array.from({ length: 300 }, (_, i) => ({ content: `bob ${i}`, embedding: towardQuery(0.99 - i * 1e-5) })));
    const near = [0.9, 0.8, 0.7, 0.3];
    for (const cos of near) await makeDoc(`a-${cos}`, `Alice ${cos}`, "x", "alice", [{ content: `alice ${cos}`, embedding: towardQuery(cos) }]);
    const indexed = createClient(`${URL!}${URL!.includes("?") ? "&" : "?"}enable_seqscan=off&enable_sort=off`);
    // A tuple budget below the crowd: the index gives up before reaching Alice's passages.
    const input = { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: QUERY, scanTuples: 50 };

    expect(await semanticScan(indexed, { ...input, exactScanMax: 0 })).toBe("index");
    expect(await askDocs(indexed, { ...input, exactScanMax: 0 })).toEqual([]);
    expect(await searchDocs(indexed, { ...input, exactScanMax: 0 })).toEqual([]);

    expect(await semanticScan(indexed, input)).toBe("exact");
    const docs = await searchDocs(indexed, input);
    expect(docs.map((r) => r.doc_id)).toEqual(["a-0.9", "a-0.8", "a-0.7"]);
    // Retrieval has no cutoff: the farther passage comes too, after the near ones.
    const passages = await askDocs(indexed, input);
    expect(passages.map((p) => p.content)).toEqual(["alice 0.9", "alice 0.8", "alice 0.7", "alice 0.3"]);
  });

  const keyword = (query: string) =>
    searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query, queryEmbedding: null });

  it("reads the last word as unfinished: a whole-word match first, then a title it begins, then a body word", async () => {
    await makeDoc("body", "Deadlines", "Send a notification within 72 hours.");
    await makeDoc("title", "Notifications", "Who to tell.");
    await makeDoc("exact", "Channels", "The notif channel is muted.");
    await makeDoc("none", "Other", "Nothing relevant here.");
    expect((await keyword("notif")).map((r) => r.doc_id)).toEqual(["exact", "title", "body"]);
  });

  it("finds a body word the unfinished last word begins, highlighted in the excerpt", async () => {
    await makeDoc("d", "Start here", `${"Some opening words. ".repeat(10)}If you are not sure where a rule comes from, open Sources.`);
    const [hit] = await keyword("whe");
    expect(hit?.doc_id).toBe("d");
    expect(hit?.snippet).toContain("not sure ⟦where⟧ a rule");
  });

  it("requires the finished words of a query whose last word is unfinished", async () => {
    await makeDoc("both", "Start here", "If you are not sure where a rule comes from.");
    await makeDoc("prefix-only", "Wheat prices", "Grain markets moved.");
    expect((await keyword("sure whe")).map((r) => r.doc_id)).toEqual(["both"]);
  });

  it("matches the finished words of an unfinished query by their stems, as a whole query's", async () => {
    await makeDoc("d", "Handbook", "Send a notification within 72 hours.");
    expect((await keyword("sending notif")).map((r) => r.doc_id)).toEqual(["d"]);
  });

  it("leaves a short or unspaced last word to whole-word matching", async () => {
    await makeDoc("d", "Wheat prices", "Grain markets moved.");
    expect(await keyword("wh")).toEqual([]);
  });

  // Far enough apart that each passage is an excerpt of its own.
  const apart = "Calm air over the bay. ".repeat(12);

  it("gives a keyword excerpt the passage showing the most of the query's words, over one repeating fewer", async () => {
    await makeDoc("d", "Notes", `The tapir sleeps. The tapir eats. The tapir swims. The tapir naps. ${apart}By the river a tapir, a heron and a lemur.`);
    const [hit] = await keyword("tapir heron lemur");
    expect(hit?.snippet).toContain("a ⟦tapir⟧, a ⟦heron⟧ and a ⟦lemur⟧");
  });

  // pdb.snippet weighed each word by how many rows of the node's index hold it, unreadable ones too.
  it("gives a keyword excerpt the first of the passages showing as many of the query's words, whatever the searcher cannot read", async () => {
    await makeDoc("d", "Notes", `Early on, a tapir met a heron. ${apart}Later, a tapir met a lemur.`);
    const excerpt = async () => (await keyword("tapir heron lemur"))[0]?.snippet;
    expect(await excerpt()).toContain("a ⟦tapir⟧ met a ⟦heron⟧");
    for (let i = 0; i < 5; i++) await makeDoc(`bob-${i}`, "Birds", "A heron by the reeds.", "bob");
    expect(await excerpt()).toContain("a ⟦tapir⟧ met a ⟦heron⟧");
  });

  it("takes a keyword excerpt from the first 64 passages holding a match", async () => {
    const naps = (n: number) => `A tapir naps. ${apart}`.repeat(n);
    await makeDoc("64th", "Notes", `${naps(63)}A tapir met a heron.`);
    await makeDoc("65th", "Notes", `${naps(64)}A tapir met a heron.`);
    const hits = await keyword("tapir heron");
    expect(hits.find((h) => h.doc_id === "64th")?.snippet).toContain("A ⟦tapir⟧ met a ⟦heron⟧");
    expect(hits.find((h) => h.doc_id === "65th")?.snippet).toMatch(/^A ⟦tapir⟧ naps\./);
  });

  it("gives a document matched by its title alone the opening of its text, not an empty excerpt", async () => {
    await makeDoc("d", "Zephyr", "Calm air over the bay.");
    const [hit] = await keyword("zephyr");
    expect(hit?.snippet).toBe("Calm air over the bay.");
  });

  it("gives a document found by meaning alone its closest passage", async () => {
    await makeDoc("d", "Mixed Doc", "intro paragraph about cats, then much else", "alice", [
      { content: "intro paragraph about cats", embedding: vec(5) },
      { content: "target passage about quantum entanglement", embedding: vec(42) },
    ]);
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zzqxq nomatch", queryEmbedding: vec(42) });
    expect(res.find((r) => r.doc_id === "d")?.snippet).toBe("target passage about quantum entanglement");
  });

  /** A fenced block whose `zebra` line is far below its opening fence, each line after `quote`. */
  function codeBlock(quote = ""): string {
    const lines = ["```python"];
    for (let i = 0; i < 30; i++) lines.push(`    def method_${i}(self):`, "        return self.__iter__()");
    lines.push("    zebra = 1", "```");
    return lines.map((line) => quote + line).join("\n");
  }

  it.each([
    ["a code block", ""],
    ["a code block in a quote", "> "],
  ])("opens a keyword excerpt that begins inside %s with a fence of its own", async (_, quote) => {
    const body = `# Iterators\n\nHow the class walks its items.\n\n${codeBlock(quote)}\n\nThat is all.`;
    await makeDoc("d", "Iterators", body);
    const [hit] = await keyword("zebra");
    // A block in a quote has its fence there too.
    expect(hit?.snippet.startsWith(`${quote}\`\`\`\n`)).toBe(true);
    expect(hit?.snippet).toContain("⟦zebra⟧ = 1");
    // The fence is all the excerpt gains, and it begins below the block's own.
    const excerpt = hit!.snippet.slice(quote.length + 4).replace(/[⟦⟧]/g, "");
    expect(body).toContain(excerpt);
    expect(excerpt).not.toContain("```python");
  });

  it("opens an excerpt of the word an unfinished query begins with a fence when it begins inside a code block", async () => {
    await makeDoc("d", "Iterators", `How the class walks its items.\n\n${codeBlock()}\n\nThat is all.`);
    const [hit] = await keyword("zeb");
    expect(hit?.snippet).toBe("```\n    def method_29(self):\n        return self.__iter__()\n    ⟦zebra⟧ = 1\n```\n\nThat is all.");
  });

  it("makes a fence line whole again when the excerpt begins past its backticks", async () => {
    // The excerpt keeps 60 characters before the word: from the "sh" after the fence's backticks.
    const head = "```sh\n";
    const line = `${"npm ci && ".padEnd(63 - head.length)}wombat start`;
    await makeDoc("d", "Setup", `${head}${line}\n\`\`\`\n\nDone.`);
    const [hit] = await keyword("womb");
    expect(hit?.snippet).toBe(`${head}${line.replace("wombat", "⟦wombat⟧")}\n\`\`\`\n\nDone.`);
  });

  it("drops the blank lines an excerpt begins with inside a code block, which would read as the block's end", async () => {
    // The excerpt keeps 60 characters before the word, so it begins on the blank line.
    const line = `${"    tally = herd.count()  # at the gate".padEnd(59)}quokka = 1`;
    await makeDoc("d", "Herd", ["```python", "    import herd", "", line, "```"].join("\n"));
    const [hit] = await keyword("quok");
    expect(hit?.snippet).toBe(`\`\`\`\n${line.replace("quokka", "⟦quokka⟧")}\n\`\`\``);
  });

  it("opens a passage found by meaning that begins inside a code block with a fence of its own", async () => {
    const body = `# Iterators\n\n${codeBlock()}\n\nThat is all.`;
    // A section too long for one chunk is cut at line breaks, inside its code too, and trimmed.
    const cut = body.indexOf("    def method_20");
    const passage = body.slice(cut).trim();
    await makeDoc("d", "Iterators", body, "alice", [
      { content: body.slice(0, cut).trim(), embedding: vec(5) },
      { content: passage, embedding: vec(42) },
    ]);
    const res = await searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query: "zzqxq nomatch", queryEmbedding: vec(42) });
    expect(res.find((r) => r.doc_id === "d")?.snippet).toBe(`\`\`\`\n${passage.slice(0, 200)}`);
  });

  it.each([
    ["a document without code", ""],
    ["prose below a closed code block", `${codeBlock()}\n\n`],
  ])("leaves the excerpt of %s as the body has it", async (_, above) => {
    const body = `${above}${"Calm air over the bay. ".repeat(20)}The okapi waits by the water.`;
    await makeDoc("d", "Bay", body);
    for (const query of ["okapi", "oka"]) {
      const [hit] = await keyword(query);
      expect(hit?.snippet).toContain("⟦okapi⟧");
      expect(body).toContain(hit!.snippet.replace(/[⟦⟧]/g, ""));
    }
  });

  it("leaves an excerpt that begins inside a code block's closing fence as the body has it", async () => {
    // The excerpt keeps 60 characters before the word: from the fence's second backtick.
    const prose = `${"The herd crosses at dawn, and the".padEnd(56)}gazelle waits.`;
    await makeDoc("d", "Herd", `${codeBlock()}\n\n${prose}`);
    const [hit] = await keyword("gaze");
    expect(hit?.snippet).toBe(`\`\`\n\n${prose.replace("gazelle", "⟦gazelle⟧")}`);
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
