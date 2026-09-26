/**
 * The keyword leg of search against pg_search itself. With TEST_DATABASE_URL
 * set, a server that lacks pg_search or does not preload it fails the file
 * rather than skipping it. Each suite drops and rebuilds the BM25 indexes, so a
 * run tests this tree's definitions, and leaves the base indexes in place.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { createClient, closeClients, type Sql } from "../client.js";
import { seedWorkspaces } from "../testing/fixtures.js";
import { initSchema } from "./migrate.js";
import { runBootRepairs } from "./boot-repairs.js";
import { preloadsPgSearch } from "./search-indexes.js";
import { askDocs, indexDoc, searchDocs } from "../search.js";
import { createDoc, setDocSearchHidden, updateDoc } from "../docs.js";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-pgsearch";
const ALICE = ["user:alice", `org:${WS}`];
const BM25 = ["docs_bm25_v1", "doc_chunks_bm25_v1"];
const BM25_LANGS = ["docs_bm25_v1_ar_ko", "doc_chunks_bm25_v1_ar_ko"];

let sql: Sql;
if (URL) sql = createClient(URL);

const search = (query: string, principals = ALICE, queryEmbedding: number[] | null = null) =>
  searchDocs(sql, {
    embeddingDims: EMBEDDING_DIMS,
    maxDistance: 0.6,
    workspaceId: WS,
    principals,
    query,
    queryEmbedding,
  });

const ask = (query: string, principals = ALICE) =>
  askDocs(sql, {
    embeddingDims: EMBEDDING_DIMS,
    maxDistance: 0.9,
    workspaceId: WS,
    principals,
    query,
    queryEmbedding: null,
  });

async function seed(docId: string, title: string, body: string, acl: string[] = ["user:alice"]) {
  await createDoc(sql, { docId, workspaceId: WS, owner: "user:alice", title, aclPrincipals: acl });
  await indexDoc(sql, {
    embeddingDims: EMBEDDING_DIMS,
    docId,
    snapshotSeq: 1,
    title,
    searchText: body,
    embeddingHash: `h-${docId}`,
    chunks: [{ content: body, embedding: null, headingPath: null, embedHash: `eh-${docId}` }],
  });
}

// Fails every test with a message naming the missing piece.
beforeAll(async () => {
  if (!URL) return;
  const [ext] = await sql<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') AS available`;
  expect(
    ext?.available,
    "the Postgres at TEST_DATABASE_URL does not offer the pg_search extension, and keyword search requires it",
  ).toBe(true);
  const [preload] = await sql<{ shared_preload_libraries: string }[]>`SHOW shared_preload_libraries`;
  expect(
    preloadsPgSearch(preload?.shared_preload_libraries ?? ""),
    "the Postgres at TEST_DATABASE_URL does not list pg_search in shared_preload_libraries, and pg_search requires it",
  ).toBe(true);
});

afterAll(async () => {
  await closeClients();
});

/** A unit vector along axis `i`, EMBEDDING_DIMS wide. */
function axis(i: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  v[i] = 1;
  return v;
}

describe.skipIf(!URL)("the BM25 keyword leg", () => {
  beforeAll(async () => {
    await initSchema(sql);
    for (const name of [...BM25, ...BM25_LANGS]) await sql.unsafe(`DROP INDEX IF EXISTS "${name}"`);
    const out = await runBootRepairs(sql);
    expect(out.searchIndexChanges.filter((c) => c.startsWith("+"))).toEqual(["+docs_bm25_v1", "+doc_chunks_bm25_v1"]);
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  it("builds each index once and leaves it alone afterwards", async () => {
    const again = await runBootRepairs(sql);
    expect(again.searchIndexChanges).toEqual([]);
    expect(again.rebuiltSearchIndexes).toEqual([]);
    const present = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY(${BM25})
      ORDER BY indexname`;
    expect(present.map((r) => r.indexname)).toEqual(["doc_chunks_bm25_v1", "docs_bm25_v1"]);
  });

  it("indexes a write as it is made, so no query tokenizes rows again", async () => {
    await seed("fresh", "Ocean planet", "The ocean covers most of the planet surface.");
    const segments = await sql<{ mutable: boolean }[]>`
      SELECT mutable FROM paradedb.index_info('docs_bm25_v1')`;
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => !s.mutable)).toBe(true);
  });

  it("ranks a doc that carries the terms above one that merely mentions them", async () => {
    await seed("strong", "Ocean planet", "The ocean covers most of the planet surface.");
    await seed("weak", "Notes", "A single ocean mention, and nothing about a planet at all.");
    const ids = (await search("ocean planet")).map((r) => r.doc_id);
    expect(ids[0]).toBe("strong");
  });

  // 100 hidden matches overfill the 80-row candidate LIMIT.
  it("applies the ACL before the candidate LIMIT, not after it", async () => {
    for (let i = 0; i < 100; i++) {
      await seed(`bob${i}`, `Bob ocean dossier ${i}`, "ocean ".repeat(30), ["user:bob"]);
    }
    await seed("alice1", "Notes", "a single ocean mention");
    const ids = (await search("ocean")).map((r) => r.doc_id);
    expect(ids).toEqual(["alice1"]);
  });

  // `noise` holds all six characters and none of the words.
  it("segments Chinese into words rather than characters", async () => {
    await seed("trench", "深海探测报告", "中国科学院发布了最新的深海探测报告，涉及马里亚纳海沟的生物多样性调查。");
    await seed("noise", "马匹护理与沟通", "马匹护理与沟通要点；亚洲纳税指南；海关里程说明。");
    const ids = (await search("马里亚纳海沟")).map((r) => r.doc_id);
    expect(ids).toEqual(["trench"]);
  });

  it("highlights a CJK match inside the body", async () => {
    await seed("trench", "深海探测报告", "中国科学院发布了最新的深海探测报告，涉及马里亚纳海沟的生物多样性调查。");
    const [hit] = await search("马里亚纳海沟");
    expect(hit!.snippet).toContain("⟦");
    expect(hit!.snippet).toContain("海沟");
  });

  it("gives a highlighted snippet the document's own characters, not HTML entities", async () => {
    const body = `Q&A: it's <b>bold</b> and "quoted", not &lt;escaped&gt; — whale notes`;
    await seed("marked", "Survey log", body);
    const [highlighted] = await search("whale");
    expect(highlighted!.snippet).toBe(body.replace("whale", "⟦whale⟧"));
    const [fallback] = await search("survey");
    expect(fallback!.snippet).toBe(body);
  });

  it("matches an English word by its stem, and marks the form the document used", async () => {
    await seed("launch", "Launch notes", "We are planning the launch and reviewed three documents.");
    for (const q of ["plan", "plans", "planned", "document", "review"]) {
      expect((await search(q)).map((r) => r.doc_id), q).toEqual(["launch"]);
    }
    const [hit] = await search("plans");
    expect(hit!.snippet).toContain("⟦planning⟧");
  });

  it("ignores English stopwords in a match, without letting a stopword-only query match everything", async () => {
    await seed("road", "Q3", "Roadmap for next quarter.");
    await seed("other", "Cooking", "Recipes for pasta and bread.");
    await seed("stop", "The And Or", "nothing else");
    expect((await search("the roadmap")).map((r) => r.doc_id)).toEqual(["road"]);
    expect((await search("the and or")).map((r) => r.doc_id)).toEqual(["stop"]);
  });

  it("still finds a doc whose title was mistyped, without letting it outrank a real match", async () => {
    await seed("exact", "Retention", "Snapshots are kept for thirty days.");
    await seed("typo", "Retentoin policy", "Nothing else in here.");
    const ids = (await search("retention")).map((r) => r.doc_id);
    expect(ids).toContain("typo");
    expect(ids[0]).toBe("exact");
  });

  it("answers an empty or punctuation-only query with no results and no error", async () => {
    await seed("d1", "Ocean", "the ocean");
    expect(await search("")).toEqual([]);
    expect(await search("   ")).toEqual([]);
    expect(await search('"; DROP TABLE docs; --')).toEqual([]);
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM docs`;
    expect(rows[0]?.count).toBe(1);
  });

  it("finds a document by its title before it has ever been indexed", async () => {
    await createDoc(sql, { docId: "fresh", workspaceId: WS, owner: "user:alice", title: "Never Opened", aclPrincipals: ["user:alice"] });
    const hits = await search("never opened");
    expect(hits.map((r) => r.doc_id)).toEqual(["fresh"]);
    expect(hits[0]!.snippet).toBe("");
  });

  it("leaves trashed and search-hidden documents out of both keyword legs", async () => {
    await seed("live", "Albatross", "albatross sightings by colony");
    await seed("trashed", "Albatross", "albatross sightings by colony");
    await seed("hidden", "Albatross", "albatross sightings by colony");
    await updateDoc(sql, "trashed", { trashed: true });
    await setDocSearchHidden(sql, "hidden", true);

    expect((await search("albatross")).map((r) => r.doc_id)).toEqual(["live"]);
    expect((await ask("albatross")).map((c) => c.doc_id)).toEqual(["live"]);
  });

  describe("the snippet of a row pdb.snippet cannot highlight", () => {
    const BODY = "Counts from the northern colonies were lower this year. ".repeat(6);

    it("is the head of the text for a match on the title alone", async () => {
      await seed("titled", "Albatross survey", BODY);
      const [hit] = await search("albatross");
      expect(hit!.doc_id).toBe("titled");
      expect(hit!.snippet).toBe(BODY.slice(0, 200));
    });

    it("is the head of the text for a document only the semantic leg found", async () => {
      await createDoc(sql, { docId: "near", workspaceId: WS, owner: "user:alice", title: "Survey", aclPrincipals: ["user:alice"] });
      await indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId: "near",
        snapshotSeq: 1,
        title: "Survey",
        searchText: BODY,
        embeddingHash: "h-near",
        chunks: [{ content: BODY, embedding: axis(3), headingPath: null, embedHash: "eh-near" }],
      });
      const [hit] = await search("zzqxq", ALICE, axis(3));
      expect(hit!.doc_id).toBe("near");
      expect(hit!.kw_rank).toBe(0);
      expect(hit!.snippet).toBe(BODY.slice(0, 200));
    });
  });

  describe("the per-chunk leg", () => {
    it("gates chunks on the ACL of the document that owns them", async () => {
      await seed("mine", "Mine", "snapshots are kept for thirty days");
      await seed("theirs", "Theirs", "snapshots are kept for thirty days", ["user:bob"]);
      const ids = (await ask("how long are snapshots kept")).map((c) => c.doc_id);
      expect(ids).toEqual(["mine"]);
    });

    it("segments a Chinese question into words", async () => {
      await seed("trench", "深海", "涉及马里亚纳海沟的生物多样性调查。");
      await seed("noise", "马匹", "马匹护理与沟通要点；亚洲纳税指南；海关里程说明。");
      expect((await ask("马里亚纳海沟")).map((c) => c.doc_id)).toEqual(["trench"]);
    });

    it("finds a document's opening passage by a word only its title carries", async () => {
      await createDoc(sql, { docId: "retro", workspaceId: WS, owner: "user:alice", title: "Q3 Retrospective", aclPrincipals: ["user:alice"] });
      await indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId: "retro",
        snapshotSeq: 1,
        title: "Q3 Retrospective",
        searchText: "What went well: shipping on time. What went badly: onboarding.",
        embeddingHash: "h-retro",
        chunks: [
          { content: "What went well: shipping on time.", embedding: null, headingPath: "Well", embedHash: "eh-retro-0" },
          { content: "What went badly: onboarding.", embedding: null, headingPath: "Badly", embedHash: "eh-retro-1" },
        ],
      });
      const hits = await ask("retrospective summary");
      expect(hits.map((c) => [c.doc_id, c.chunk_index])).toEqual([["retro", 0]]);
    });

    it("follows a rename, and keeps it when the next flush still has the old heading", async () => {
      await seed("renamed", "Zeppelin", "Airships of the interwar period.");
      expect((await ask("zeppelin")).map((c) => c.doc_id)).toEqual(["renamed"]);
      await updateDoc(sql, "renamed", { title: "Blimp" });
      expect(await ask("zeppelin")).toEqual([]);
      expect((await ask("blimp")).map((c) => c.doc_id)).toEqual(["renamed"]);
      await indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId: "renamed",
        snapshotSeq: 2,
        title: "Zeppelin",
        searchText: "Airships of the interwar period.",
        embeddingHash: "h-renamed-2",
        chunks: [{ content: "Airships of the interwar period.", embedding: null, headingPath: null, embedHash: "eh-renamed-2" }],
      });
      expect(await ask("zeppelin")).toEqual([]);
      expect((await ask("blimp")).map((c) => c.doc_id)).toEqual(["renamed"]);
    });

    // Holding the chunk rows stops indexDoc with the docs row locked, so the rename waits behind it.
    it("keeps chunk 0's title when a rename lands while the document is being indexed", async () => {
      await seed("race", "Zeppelin", "Airships.");
      const waitingOnLocks = async (n: number) => {
        for (let i = 0; i < 200; i++) {
          const [row] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (row!.n >= n) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`never saw ${n} statement(s) waiting on a lock`);
      };
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let held!: () => void;
      const holding = new Promise<void>((r) => (held = r));
      const holder = sql.begin(async (tx) => {
        await tx`SELECT 1 FROM doc_chunks WHERE doc_id = 'race' FOR UPDATE`;
        held();
        await gate;
      });
      await holding;
      const indexing = indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId: "race",
        snapshotSeq: 2,
        title: "Zeppelin",
        searchText: "Airships and their crews.",
        embeddingHash: "h-race-2",
        chunks: [{ content: "Airships and their crews.", embedding: null, headingPath: null, embedHash: "eh-race-2" }],
      });
      await waitingOnLocks(1);
      const renaming = updateDoc(sql, "race", { title: "Blimp" });
      await waitingOnLocks(2);
      release();
      await Promise.all([holder, indexing, renaming]);

      const [chunk0] = await sql<{ doc_title: string | null }[]>`
        SELECT doc_title FROM doc_chunks WHERE doc_id = 'race' AND chunk_index = 0`;
      expect(chunk0!.doc_title).toBe("Blimp");
      expect((await ask("blimp")).map((c) => c.doc_id)).toEqual(["race"]);
    });

    it("matches a question by stem and passes over its stopwords", async () => {
      await seed("snap", "Retention", "A snapshot is retained for thirty days.");
      await seed("filler", "Filler", "They are here and there.");
      expect((await ask("how long are snapshots kept")).map((c) => c.doc_id)).toEqual(["snap"]);
    });
  });
});

describe.skipIf(!URL)("the BM25 keyword leg with search languages ko and ar", () => {
  const WS2 = "ws-pgsearch-langs";
  const ALICE2 = ["user:alice", `org:${WS2}`];

  async function seed2(docId: string, title: string, body: string, acl: string[] = ["user:alice"]) {
    await createDoc(sql, { docId, workspaceId: WS2, owner: "user:alice", title, aclPrincipals: acl });
    await indexDoc(sql, {
      embeddingDims: EMBEDDING_DIMS,
      docId,
      snapshotSeq: 1,
      title,
      searchText: body,
      embeddingHash: `h-${docId}`,
      chunks: [{ content: body, embedding: null, headingPath: null, embedHash: `eh-${docId}` }],
    });
  }

  const search2 = (query: string) =>
    searchDocs(sql, {
      embeddingDims: EMBEDDING_DIMS,
      maxDistance: 0.6,
      workspaceId: WS2,
      principals: ALICE2,
      query,
      queryEmbedding: null,
      searchLanguages: () => ["ko", "ar"],
    });

  beforeAll(async () => {
    await initSchema(sql);
    for (const name of [...BM25, ...BM25_LANGS]) await sql.unsafe(`DROP INDEX IF EXISTS "${name}"`);
    const out = await runBootRepairs(sql, { searchLanguages: ["ko", "ar"] });
    expect(out.searchIndexChanges.sort()).toEqual([...BM25_LANGS].sort().map((n) => `+${n}`));
  });

  // Back to the base shape, which the other search suites read.
  afterAll(async () => {
    await runBootRepairs(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS2);
  });

  it("names the indexes with the language set", async () => {
    const present = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY(${BM25_LANGS})
      ORDER BY indexname`;
    expect(present.map((r) => r.indexname)).toEqual([...BM25_LANGS].sort());
  });

  it("a bare Korean noun finds a document where it carries a particle (해구 → 해구의)", async () => {
    await seed2(
      "trench",
      "심해 탐사 보고서",
      "해양 연구팀이 마리아나 해구의 생물 다양성을 조사한 최신 보고서를 발표했다.",
    );
    await seed2(
      "noise",
      "서울특별시 소개",
      "서울특별시는 대한민국의 수도이며 다양한 문화 시설과 교통 인프라를 갖추고 있다.",
    );
    const ids = (await search2("마리아나 해구")).map((r) => r.doc_id);
    expect(ids).toEqual(["trench"]);
  });

  it("a bare Arabic noun finds the ال-prefixed form (أرض → الأرض)", async () => {
    await seed2(
      "trench",
      "تقرير استكشاف أعماق البحار",
      "أعلن علماء المحيطات عن استكشاف جديد لخندق ماريانا، وهو أعمق نقطة في محيطات الأرض.",
    );
    await seed2(
      "noise",
      "دليل العناية بالخيول",
      "دليل شامل للعناية بالخيول يغطي العناية بالحوافر وتنظيف العرف.",
    );
    const ids = (await search2("أرض")).map((r) => r.doc_id);
    expect(ids).toEqual(["trench"]);
  });

  it("does not strip a bare Arabic ل proclitic (خندق does not match لخندق)", async () => {
    await seed2("trench", "تقرير استكشاف أعماق البحار", "أعلن علماء المحيطات عن استكشاف جديد لخندق ماريانا.");
    const ids = (await search2("خندق")).map((r) => r.doc_id);
    expect(ids).toEqual([]);
  });

  it("still segments Chinese into words alongside the extra columns", async () => {
    await seed2("trench", "深海探测报告", "中国科学院发布了最新的深海探测报告，涉及马里亚纳海沟的生物多样性调查。");
    await seed2("noise", "马匹护理与沟通", "马匹护理与沟通要点；亚洲纳税指南；海关里程说明。");
    const ids = (await search2("马里亚纳海沟")).map((r) => r.doc_id);
    expect(ids).toEqual(["trench"]);
  });

  describe("the per-chunk leg", () => {
    const ask2 = (query: string) =>
      askDocs(sql, {
        embeddingDims: EMBEDDING_DIMS,
        maxDistance: 0.9,
        workspaceId: WS2,
        principals: ALICE2,
        query,
        queryEmbedding: null,
        searchLanguages: () => ["ko", "ar"],
      });

    it("segments a Korean question into words, particle and all", async () => {
      await seed2("trench", "심해", "마리아나 해구의 생물 다양성을 조사했다.");
      await seed2("noise", "서울", "서울특별시는 대한민국의 수도이다.");
      const ids = (await ask2("마리아나 해구")).map((c) => c.doc_id);
      expect(ids).toEqual(["trench"]);
    });
  });
});

describe.skipIf(!URL)("the boot repair's index sweep", () => {
  beforeAll(async () => {
    await initSchema(sql);
  });

  afterAll(async () => {
    await runBootRepairs(sql);
  });

  it("drops the indexes of another shape and builds this one's", async () => {
    await runBootRepairs(sql, { searchLanguages: ["ko", "ar"] });
    const out = await runBootRepairs(sql);
    expect([...out.searchIndexChanges].sort()).toEqual([
      "+doc_chunks_bm25_v1",
      "+docs_bm25_v1",
      "-doc_chunks_bm25_v1_ar_ko",
      "-docs_bm25_v1_ar_ko",
    ]);
    const present = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${[...BM25, ...BM25_LANGS]})
      ORDER BY indexname`;
    expect(present.map((r) => r.indexname)).toEqual(["doc_chunks_bm25_v1", "docs_bm25_v1"]);
  });

  // A comment naming another version stands in for an upgraded pg_search; no
  // comment at all, for an index whose builder is unknown.
  it("rebuilds an index another pg_search version built, and marks it with this one", async () => {
    await runBootRepairs(sql);
    await sql`COMMENT ON INDEX docs_bm25_v1 IS 'pg_search 0.0.1'`;
    await sql`COMMENT ON INDEX doc_chunks_bm25_v1 IS NULL`;

    const out = await runBootRepairs(sql);
    expect(out.searchIndexChanges).toEqual([]);
    expect([...out.rebuiltSearchIndexes].sort()).toEqual(["doc_chunks_bm25_v1", "docs_bm25_v1"]);

    const [ext] = await sql<{ default_version: string }[]>`
      SELECT default_version FROM pg_available_extensions WHERE name = 'pg_search'`;
    const marks = await sql<{ built_by: string | null }[]>`
      SELECT obj_description(c.oid, 'pg_class') AS built_by
      FROM pg_class c WHERE c.relname = ANY(${BM25})`;
    expect(marks.map((m) => m.built_by)).toEqual([`pg_search ${ext?.default_version}`, `pg_search ${ext?.default_version}`]);
    expect((await runBootRepairs(sql)).rebuiltSearchIndexes).toEqual([]);
  });

  // pg_search's default, a mutable segment every query tokenizes again, stands in for an index
  // built before the indexes were built to index each write as it is made.
  it("rebuilds an index that leaves writes unindexed until a query, to index each write", async () => {
    await runBootRepairs(sql);
    await sql`ALTER INDEX docs_bm25_v1 RESET (mutable_segment_rows)`;

    const out = await runBootRepairs(sql);
    expect(out.searchIndexChanges).toEqual([]);
    expect(out.rebuiltSearchIndexes).toEqual(["docs_bm25_v1"]);
    const [docs] = await sql<{ reloptions: string[] }[]>`SELECT reloptions FROM pg_class WHERE relname = 'docs_bm25_v1'`;
    expect(docs?.reloptions).toContain("mutable_segment_rows=0");
    expect((await runBootRepairs(sql)).rebuiltSearchIndexes).toEqual([]);
  });
});
