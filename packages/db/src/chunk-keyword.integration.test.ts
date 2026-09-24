import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc } from "./docs.js";
import { indexDoc, askDocs, type ChunkInput } from "./search.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

const WS = "ws-test";
const ALICE = ["user:alice", "org:all"];

async function seed(
  sql: Sql,
  docId: string,
  title: string,
  chunks: ChunkInput[],
  acl: string[] = ["user:alice"],
) {
  await createDoc(sql, { workspaceId: WS, docId, owner: "user:alice", title, aclPrincipals: acl });
  await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
    docId,
    snapshotSeq: 1,
    title,
    searchText: chunks.map((c) => c.content).join("\n\n"),
    embeddingHash: `h-${docId}`,
    chunks,
  });
}

function chunk(content: string, headingPath: string | null, i: number): ChunkInput {
  return { content, embedding: null, headingPath, embedHash: `eh-${i}` };
}

const ask = (sql: Sql, query: string, scopeDocIds: string[] | null = null) =>
  askDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.9, workspaceId: WS, principals: ALICE, query, queryEmbedding: null, scopeDocIds });

// No chunk embeddings and no query vector: only the keyword leg answers.
describe.skipIf(!URL)("askDocs per-chunk keyword leg", () => {
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

  it("cites the section holding the term, not chunk 0", async () => {
    await seed(sql, "d1", "Ops Handbook", [
      chunk("This handbook covers day to day operations.", "Overview", 0),
      chunk("Deployments go out on Tuesdays.", "Releases", 1),
      chunk("The rollback lever is called kryptonite.", "Emergencies", 2),
    ]);

    const hits = await ask(sql, "kryptonite");

    expect(hits.length).toBe(1);
    expect(hits[0]!.chunk_index).toBe(2);
    expect(hits[0]!.content).toContain("kryptonite");
    expect(hits[0]!.heading_path).toBe("Emergencies");
  });

  it("matches a term that appears only in a heading", async () => {
    await seed(sql, "d1", "Service Guide", [
      chunk("Start here for the basics.", "Overview", 0),
      chunk("Follow the numbered steps in order.", "Runbook", 1),
    ]);

    const hits = await ask(sql, "runbook");

    expect(hits.length).toBe(1);
    expect(hits[0]!.chunk_index).toBe(1);
  });

  it("indexes a chunk with no heading path", async () => {
    await seed(sql, "d1", "Loose Notes", [chunk("An unfiled thought about barnacles.", null, 0)]);

    const hits = await ask(sql, "barnacles");

    expect(hits.length).toBe(1);
    expect(hits[0]!.heading_path).toBeNull();
  });

  it("excludes chunks of docs the searcher cannot see", async () => {
    await seed(sql, "mine", "Mine", [chunk("The passphrase is albatross.", "Body", 0)]);
    await seed(sql, "theirs", "Theirs", [chunk("The passphrase is albatross.", "Body", 0)], ["user:bob"]);

    const hits = await ask(sql, "albatross");

    expect(hits.length).toBe(1);
    expect(hits[0]!.doc_id).toBe("mine");
  });

  it("honours the collection scope", async () => {
    await seed(sql, "in", "In Scope", [chunk("A note about pelicans.", "Body", 0)]);
    await seed(sql, "out", "Out Of Scope", [chunk("Another note about pelicans.", "Body", 0)]);

    expect((await ask(sql, "pelicans")).length).toBe(2);
    expect((await ask(sql, "pelicans", ["in"])).map((h) => h.doc_id)).toEqual(["in"]);
    expect(await ask(sql, "pelicans", [])).toEqual([]);
  });
});
