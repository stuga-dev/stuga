import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc } from "./docs.js";
import { indexDoc, askDocs } from "./search.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

const ALICE = ["user:alice", "org:all"];

const DIMS = 1024;
/** A unit 2-axis vector a·e0 + b·e1 (rest 0). cos to e0 = a/hypot(a,b). */
function blendVec(a: number, b: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0);
  const n = Math.hypot(a, b) || 1;
  v[0] = a / n;
  v[1] = b / n;
  return v;
}

const WS = "ws-test";

async function seed(sql: Sql, docId: string, owner: string, title: string, body: string, acl: string[]) {
  await createDoc(sql, { workspaceId: WS, docId, owner: `user:${owner}`, title, aclPrincipals: acl });
  await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
    docId,
    snapshotSeq: 1,
    title,
    searchText: body,
    embeddingHash: `h-${docId}`,
    chunks: [
      { content: `${title} — ${body}`, embedding: null, headingPath: "Intro", embedHash: `${docId}-eh-0` },
      { content: `More about ${title}`, embedding: null, headingPath: "Details", embedHash: `${docId}-eh-1` },
    ],
  });
}

/** A document whose only passage is `content`, embedded as `embedding`. */
async function seedPassage(sql: Sql, docId: string, title: string, content: string, embedding: number[] | null) {
  await createDoc(sql, { workspaceId: WS, docId, owner: "user:alice", title, aclPrincipals: ["user:alice"] });
  await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
    docId,
    snapshotSeq: 1,
    title,
    searchText: content,
    embeddingHash: `h-${docId}`,
    chunks: [{ content, embedding, embedHash: `${docId}-eh-0` }],
  });
}

describe.skipIf(!URL)("askDocs (chunk-returning RAG retrieval)", () => {
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

  it("returns chunk rows with content, gated by ACL", async () => {
    await seed(sql, "d1", "alice", "Quarterly Plan", "revenue target growth strategy", ["user:alice"]);
    await seed(sql, "secret", "bob", "Quarterly Secret", "revenue target confidential", ["user:bob"]);

    const chunks = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS, principals: ALICE, query: "revenue target", queryEmbedding: null });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.doc_id === "d1")).toBe(true);
    expect(chunks[0]!.content).toContain("Quarterly Plan");
    expect(typeof chunks[0]!.chunk_index).toBe("number");
    expect(chunks[0]!.heading_path).toBe("Intro");
  });

  it("honors a Collection scope (scopeDocIds), and empty scope returns nothing", async () => {
    await seed(sql, "d1", "alice", "Alpha", "shared keyword apple", ["user:alice"]);
    await seed(sql, "d2", "alice", "Beta", "shared keyword apple", ["user:alice"]);

    const scoped = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS,
      principals: ALICE,
      query: "apple",
      queryEmbedding: null,
      scopeDocIds: ["d1"],
    });
    expect(scoped.every((c) => c.doc_id === "d1")).toBe(true);
    expect(scoped.length).toBeGreaterThan(0);

    const empty = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS, principals: ALICE, query: "apple", queryEmbedding: null, scopeDocIds: [] });
    expect(empty).toEqual([]);
  });

  it("matches a natural-language question on any of its terms", async () => {
    await seed(sql, "d1", "alice", "Retention Policy", "Stuga keeps document snapshots for ninety days before archival.", ["user:alice"]);
    const chunks = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS,
      principals: ALICE,
      query: "how long are snapshots kept",
      queryEmbedding: null,
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.doc_id).toBe("d1");
    const none = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS, principals: ALICE, query: "pineapple helicopter", queryEmbedding: null });
    expect(none).toEqual([]);
  });

  it("orders passages found only by meaning by their similarity, with no keyword credit", async () => {
    await seedPassage(sql, "a", "Alpha", "alpha passage", blendVec(0.5, Math.sqrt(1 - 0.25)));
    await seedPassage(sql, "b", "Beta", "beta passage", blendVec(0.8, 0.6));
    const chunks = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS, principals: ALICE, query: "zephyr", queryEmbedding: blendVec(1, 0) });
    expect(chunks.map((c) => c.doc_id)).toEqual(["b", "a"]);
    expect(Number(chunks[0]!.score)).toBeCloseTo(1 / 61, 12);
    expect(Number(chunks[1]!.score)).toBeCloseTo(1 / 62, 12);
  });

  it("credits a passage with 1/(60 + rank) for each leg it appears in, and nothing for a leg it is absent from", async () => {
    await seedPassage(sql, "both", "Notes", "zephyr quasar", blendVec(0.9, Math.sqrt(1 - 0.81)));
    await seedPassage(sql, "kw-only", "Notes", "zephyr", null);
    await seedPassage(sql, "sem-only", "Notes", "calm air", blendVec(0.6, 0.8));
    const chunks = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS, principals: ALICE, query: "zephyr quasar", queryEmbedding: blendVec(1, 0) });
    const score = (docId: string) => Number(chunks.find((c) => c.doc_id === docId)!.score);
    expect(chunks[0]!.doc_id).toBe("both");
    expect(score("both")).toBeCloseTo(1 / 61 + 1 / 61, 12);
    expect(score("kw-only")).toBeCloseTo(1 / 62, 12);
    expect(score("sem-only")).toBeCloseTo(1 / 62, 12);
  });

  it.each([0.5, 0.9, 1, 2])("returns a passage found only by meaning iff its cosine distance is below a cutoff of %s", async (maxDistance) => {
    const distances = [0.3, 0.67, 0.98, 1.3];
    for (const d of distances) {
      await seedPassage(sql, `at-${d}`, "Notes", "unrelated filler", blendVec(1 - d, Math.sqrt(1 - (1 - d) ** 2)));
    }
    const chunks = await askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance, workspaceId: WS,
      principals: ALICE,
      query: "zephyr",
      queryEmbedding: blendVec(1, 0),
    });
    expect(chunks.map((c) => c.doc_id).sort()).toEqual(distances.filter((d) => d < maxDistance).map((d) => `at-${d}`).sort());
  });
});
