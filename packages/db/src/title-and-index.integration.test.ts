import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc, updateDoc, getDoc } from "./docs.js";
import { indexDoc, searchDocs } from "./search.js";
import { provisionWorkspace } from "./workspaces.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("title provenance across index runs", () => {
  let sql: Sql;
  const WS = "ws-test";

  function flush(docId: string, seq: number, title: string, searchText: string) {
    return indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId,
      snapshotSeq: seq,
      title,
      searchText,
      embeddingHash: `hash-${seq}`,
      chunks: [],
    });
  }

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE workspaces, docs, doc_chunks CASCADE`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Test", owner: "ws-owner" });
  });

  it("a body flush keeps an explicit rename", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:alice", title: "Draft" });
    await flush("d1", 1, "Draft", "some body text");
    expect((await getDoc(sql, "d1"))!.title).toBe("Draft");

    await updateDoc(sql, "d1", { title: "Q3 Planning" });
    expect((await getDoc(sql, "d1"))!.title).toBe("Q3 Planning");

    await flush("d1", 2, "Draft", "some body text, edited");
    expect((await getDoc(sql, "d1"))!.title).toBe("Q3 Planning");
  });

  it("the heading still wins for a doc nobody has explicitly renamed", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d2", owner: "user:alice", title: "Untitled" });
    await flush("d2", 1, "Meeting Notes", "body");
    expect((await getDoc(sql, "d2"))!.title).toBe("Meeting Notes");
    await flush("d2", 2, "Meeting Notes, Revised", "body");
    expect((await getDoc(sql, "d2"))!.title).toBe("Meeting Notes, Revised");
  });

  it("keyword search finds the title actually stored, not the one the flush proposed", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d3", owner: "user:alice", title: "Draft" });
    await updateDoc(sql, "d3", { title: "Zebra Logistics" });
    await flush("d3", 1, "Draft", "body about shipping");

    const search = (query: string) =>
      searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ["user:alice"], query, queryEmbedding: null });
    expect((await search("Zebra")).map((r) => r.doc_id)).toEqual(["d3"]);
    expect(await search("Draft")).toEqual([]);
  });

  it("a flush with an older seq changes nothing", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d4", owner: "user:alice", title: "T" });
    await flush("d4", 5, "Fifth", "body five");
    await flush("d4", 2, "Second", "body two");
    const doc = (await getDoc(sql, "d4"))!;
    expect(doc.title).toBe("Fifth");
    expect(doc.snapshot_seq).toBe(5);
  });

  it("a rename keeps its title through a reindex, and title_source is on the row", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "d9", owner: "user:alice", title: "Draft" });
    expect((await getDoc(sql, "d9"))!.title_source).toBe("heading");

    await updateDoc(sql, "d9", { title: "Q3 Report" });
    expect((await getDoc(sql, "d9"))!.title_source).toBe("user");

    await flush("d9", 1, "Some Heading", "body text");
    const row = await getDoc(sql, "d9");
    expect(row!.title).toBe("Q3 Report");
    expect(row!.title_source).toBe("user");
  });
});
