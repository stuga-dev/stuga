/**
 * The keyword legs of search against Postgres's own text search: the vectors a write leaves, BM25
 * over them, every language the node may stem, and the background pass that writes a row again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { SEARCH_LANGUAGES, type SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { createClient, closeClients, type Sql } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { askDocs, indexDoc, searchDocs } from "./search.js";
import { createDoc, setDatabaseSearchText, setDocSearchHidden, updateDoc } from "./docs.js";
import { listDocsToReindex, reindexDocVectors, searchFormat } from "./search-vectors.js";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-keyword";
const ALICE = ["user:alice", `org:${WS}`];

let sql: Sql;
if (URL) sql = createClient(URL);

async function seed(docId: string, title: string, body: string, acl: string[] = ["user:alice"], languages: readonly SearchLanguage[] = []) {
  await createDoc(sql, { docId, workspaceId: WS, owner: "user:alice", title, aclPrincipals: acl, searchLanguages: languages });
  await indexDoc(sql, {
    embeddingDims: EMBEDDING_DIMS,
    docId,
    snapshotSeq: 1,
    title,
    searchText: body,
    embeddingHash: `h-${docId}`,
    chunks: [{ content: body, embedding: null, headingPath: null, embedHash: `eh-${docId}` }],
    searchLanguages: languages,
  });
}

const search = (query: string, principals = ALICE, queryEmbedding: number[] | null = null, languages: readonly SearchLanguage[] = []) =>
  searchDocs(sql, {
    embeddingDims: EMBEDDING_DIMS,
    maxDistance: 0.6,
    workspaceId: WS,
    principals,
    query,
    queryEmbedding,
    searchLanguages: () => languages,
  });

const ids = async (query: string, languages: readonly SearchLanguage[] = []) =>
  (await search(query, ALICE, null, languages)).map((r) => r.doc_id);

const ask = (query: string, principals = ALICE, languages: readonly SearchLanguage[] = []) =>
  askDocs(sql, {
    embeddingDims: EMBEDDING_DIMS,
    workspaceId: WS,
    principals,
    query,
    queryEmbedding: null,
    searchLanguages: () => languages,
  });

/** A unit vector along axis `i`, EMBEDDING_DIMS wide. */
function axis(i: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  v[i] = 1;
  return v;
}

afterAll(async () => {
  if (URL) await closeClients();
});

describe.skipIf(!URL)("the keyword leg", () => {
  beforeAll(async () => {
    await initSearchSchema(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  it("writes a document's vectors with its text, its passages' with them, and every index on each write", async () => {
    await seed("fresh", "Ocean planet", "The ocean covers most of the planet surface.");
    const [doc] = await sql<{ title_dl: number; search_dl: number; title: string; search: string; search_format: string }[]>`
      SELECT title_dl, search_dl, title_tsv::text AS title, search_tsv::text AS search, search_format FROM docs WHERE doc_id = 'fresh'`;
    expect(doc).toMatchObject({ title_dl: 2, search_dl: 8, search_format: searchFormat([]) });
    // Stems at the words' positions; the words as written, which prefixes and stopwords read, without one.
    expect(doc!.search).toContain("'cover':3");
    expect(doc!.search).toContain("'covers'");
    expect(doc!.search).toContain("'the'");
    const [chunk] = await sql<{ dl: number; tsv: string }[]>`SELECT dl, tsv::text AS tsv FROM doc_chunks WHERE doc_id = 'fresh'`;
    // The opening passage holds the title before its own words, and no word as written.
    expect(chunk!.dl).toBe(10);
    expect(chunk!.tsv).toContain("'ocean':1,4");
    expect(chunk!.tsv).not.toContain("'covers'");
    const gin = await sql<{ relname: string; reloptions: string[] }[]>`
      SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_am am ON am.oid = c.relam
      WHERE am.amname = 'gin' AND c.relname IN ('docs_title_tsv_gin', 'docs_search_tsv_gin', 'doc_chunks_tsv_gin') ORDER BY c.relname`;
    expect(gin.map((g) => [g.relname, g.reloptions])).toEqual([
      ["doc_chunks_tsv_gin", ["fastupdate=off"]],
      ["docs_search_tsv_gin", ["fastupdate=off"]],
      ["docs_title_tsv_gin", ["fastupdate=off"]],
    ]);
  });

  it("ranks a doc that carries the terms above one that merely mentions them", async () => {
    await seed("strong", "Ocean planet", "The ocean covers most of the planet surface.");
    await seed("weak", "Notes", "A single ocean mention, and nothing about a planet at all.");
    expect((await ids("ocean planet"))[0]).toBe("strong");
  });

  it("weighs a word by the documents the searcher can see, whatever others hold", async () => {
    await seed("herons", "Notes", "heron heron tapir");
    await seed("tapirs", "Notes", "tapir tapir heron");
    const before = (await search("heron tapir")).map((r) => [r.doc_id, r.kw_rank]);
    // Twenty herons only Bob can read leave heron as rare as tapir for Alice.
    for (let i = 0; i < 20; i++) await seed(`bob-${i}`, "Birds", "A heron by the reeds.", ["user:bob"]);
    const after = (await search("heron tapir")).map((r) => [r.doc_id, r.kw_rank]);
    expect(after).toEqual(before);
    expect(after.map(([id]) => id)).toEqual(["herons", "tapirs"]);
    expect(after[0]![1]).toBeCloseTo(after[1]![1] as number, 12);
  });

  // 100 hidden matches overfill the 80-row candidate LIMIT.
  it("applies the ACL before the candidate LIMIT, not after it", async () => {
    for (let i = 0; i < 100; i++) {
      await seed(`bob${i}`, `Bob ocean dossier ${i}`, "ocean ".repeat(30), ["user:bob"]);
    }
    await seed("alice1", "Notes", "a single ocean mention");
    expect(await ids("ocean")).toEqual(["alice1"]);
  });

  // `noise` holds all six characters and none of the words.
  it("finds Chinese by the words a query's characters make, not by its characters apart", async () => {
    await seed("trench", "深海探测报告", "中国科学院发布了最新的深海探测报告，涉及马里亚纳海沟的生物多样性调查。");
    await seed("noise", "马匹护理与沟通", "马匹护理与沟通要点；亚洲纳税指南；海关里程说明。");
    expect(await ids("马里亚纳海沟")).toEqual(["trench"]);
  });

  it("highlights a CJK match inside the body as one run", async () => {
    await seed("trench", "深海探测报告", "中国科学院发布了最新的深海探测报告，涉及马里亚纳海沟的生物多样性调查。");
    const [hit] = await search("马里亚纳海沟");
    expect(hit!.snippet).toContain("涉及⟦马里亚纳海沟⟧的");
  });

  it("finds a Chinese word beside a neighbour that would split it wrongly", async () => {
    await seed("phone", "人工翻译和智能手机", "人工翻译和智能手机");
    expect(await ids("智能手机")).toEqual(["phone"]);
  });

  it("ranks a Chinese compound above its parts found apart", async () => {
    await seed("apart", "需要人工审核的智能系统", "需要人工审核的智能系统");
    await seed("whole", "人工智能的发展", "人工智能的发展");
    expect(await ids("人工智能")).toEqual(["whole", "apart"]);
  });

  it("finds a phrase typed whole in a text that has a word between its parts", async () => {
    await seed("between", "规划", "人工智能的发展需要时间。");
    expect(await ids("人工智能发展")).toEqual(["between"]);
  });

  it("finds traditional Chinese from a simplified query, and simplified from a traditional one", async () => {
    await seed("traditional", "國家圖書館開放時間", "國家圖書館週末照常開放，閱覽室需預約。");
    await seed("simplified", "博物馆讲解安排", "博物馆每周三下午安排免费讲解。");
    expect(await ids("国家图书馆")).toEqual(["traditional"]);
    expect(await ids("博物館講解")).toEqual(["simplified"]);
    const [hit] = await search("图书馆");
    expect(hit!.snippet).toContain("國家⟦圖書館⟧週末");
  });

  it("finds Japanese written in kanji and kana, and Chinese characters the two languages share", async () => {
    await seed("ja", "会社の設立", "新しい会社を設立したのは去年です。");
    await seed("zh", "中国的公司", "中国的公司");
    expect(await ids("設立した")).toEqual(["ja"]);
    expect(await ids("会社")).toEqual(["ja"]);
    expect(await ids("公司")).toEqual(["zh"]);
  });

  it("finds a bare Korean noun where it carries a particle (해구 → 해구의), with no language chosen", async () => {
    await seed("trench", "심해 탐사 보고서", "해양 연구팀이 마리아나 해구의 생물 다양성을 조사한 최신 보고서를 발표했다.");
    await seed("noise", "서울특별시 소개", "서울특별시는 대한민국의 수도이며 다양한 문화 시설과 교통 인프라를 갖추고 있다.");
    expect(await ids("마리아나 해구")).toEqual(["trench"]);
    const [hit] = await search("해구");
    expect(hit!.snippet).toContain("마리아나 ⟦해구⟧의");
  });

  it("finds Thai by its words, with no language chosen", async () => {
    await seed("sheep", "แกะ", "นักวิทยาศาสตร์สร้างแกะโคลนตัวแรกของโลก");
    await seed("other", "ข่าว", "ฝนตกหนักในกรุงเทพมหานครเมื่อวานนี้");
    expect(await ids("แกะโคลน")).toEqual(["sheep"]);
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
      expect(await ids(q), q).toEqual(["launch"]);
    }
    const [hit] = await search("plans");
    expect(hit!.snippet).toContain("⟦planning⟧");
  });

  it("matches a word written with accents or in full width as the index folds it", async () => {
    await seed("cafe", "Café notes", "The ＣＡＦＥ opens at nine.");
    expect(await ids("cafe")).toEqual(["cafe"]);
    const [hit] = await search("café");
    expect(hit!.snippet).toBe("The ⟦ＣＡＦＥ⟧ opens at nine.");
  });

  it("ignores English stopwords in a match, without letting a stopword-only query match everything", async () => {
    await seed("road", "Q3", "Roadmap for next quarter.");
    await seed("other", "Cooking", "Recipes for pasta and bread.");
    await seed("stop", "The And Or", "nothing else");
    expect(await ids("the roadmap")).toEqual(["road"]);
    expect(await ids("the and or")).toEqual(["stop"]);
  });

  it("still finds a doc whose title was mistyped, without letting it outrank a real match", async () => {
    await seed("exact", "Retention", "Snapshots are kept for thirty days.");
    await seed("typo", "Retentoin policy", "Nothing else in here.");
    const found = await ids("retention");
    expect(found).toContain("typo");
    expect(found[0]).toBe("exact");
  });

  it("finds a title one typo away from every word, and none further", async () => {
    await seed("budget", "Quarterly budget review", "Numbers.");
    await seed("far", "Quaterly bduget", "Numbers.");
    expect(await ids("quartely budget")).toEqual(["budget"]);
    expect(await ids("quarterly budgte")).toEqual(["budget"]);
    expect(await ids("quarterly budgets")).toEqual(["budget"]);
  });

  it("indexes a text past what one vector holds from its start", { timeout: 60_000 }, async () => {
    let state = 7;
    const han = () => String.fromCodePoint(0x4e00 + ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) % 3000));
    const text = `开头的标记 ${Array.from({ length: 300_000 }, han).join("")}`;
    await seed("huge", "Huge", text);
    expect(await ids("开头的标记")).toEqual(["huge"]);
  });

  it("answers an empty or punctuation-only query with no results and no error", async () => {
    await seed("d1", "Ocean", "the ocean");
    expect(await search("")).toEqual([]);
    expect(await search("   ")).toEqual([]);
    expect(await search('"; DROP TABLE docs; --')).toEqual([]);
    expect(await search("'':* & | !")).toEqual([]);
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM docs`;
    expect(rows[0]?.count).toBe(1);
  });

  it("finds a document by its title before it has ever been indexed", async () => {
    await createDoc(sql, { docId: "fresh", workspaceId: WS, owner: "user:alice", title: "Never Opened", aclPrincipals: ["user:alice"] });
    const hits = await search("never opened");
    expect(hits.map((r) => r.doc_id)).toEqual(["fresh"]);
    expect(hits[0]!.snippet).toBe("");
  });

  it("finds a renamed document by its new title, and no longer by its old one", async () => {
    await seed("renamed", "Zeppelin", "Airships of the interwar period.");
    await updateDoc(sql, "renamed", { title: "Blimp" });
    expect(await ids("zeppelin")).toEqual([]);
    expect(await ids("blimp")).toEqual(["renamed"]);
  });

  it("leaves trashed and search-hidden documents out of both keyword legs", async () => {
    await seed("live", "Albatross", "albatross sightings by colony");
    await seed("trashed", "Albatross", "albatross sightings by colony");
    await seed("hidden", "Albatross", "albatross sightings by colony");
    await updateDoc(sql, "trashed", { trashed: true });
    await setDocSearchHidden(sql, "hidden", true);

    expect(await ids("albatross")).toEqual(["live"]);
    expect((await ask("albatross")).map((c) => c.doc_id)).toEqual(["live"]);
  });

  describe("the snippet of a row with no match in its text", () => {
    const BODY = "Counts from the northern colonies were lower this year. ".repeat(6);
    /** The text's first 200 characters, cut back to a whole word. */
    const HEAD = BODY.slice(0, 200).replace(/\s\S*$/, "");

    it("is the head of the text, in whole words, for a match on the title alone", async () => {
      await seed("titled", "Albatross survey", BODY);
      const [hit] = await search("albatross");
      expect(hit!.doc_id).toBe("titled");
      expect(hit!.snippet).toBe(HEAD);
    });

    it("is the head of the text, in whole words, for a document only the semantic leg found", async () => {
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
      expect(hit!.snippet).toBe(HEAD);
    });
  });

  it("finds a database by the stems of its cells", async () => {
    await createDoc(sql, { docId: "stock", workspaceId: WS, owner: "user:alice", title: "Stock", docType: "database", aclPrincipals: ["user:alice"] });
    await setDatabaseSearchText(sql, "stock", "Flour · 12 bags\nCroissants · baked daily");
    expect(await ids("croissant")).toEqual(["stock"]);
  });

  describe("the per-chunk leg", () => {
    it("gates chunks on the ACL of the document that owns them", async () => {
      await seed("mine", "Mine", "snapshots are kept for thirty days");
      await seed("theirs", "Theirs", "snapshots are kept for thirty days", ["user:bob"]);
      expect((await ask("how long are snapshots kept")).map((c) => c.doc_id)).toEqual(["mine"]);
    });

    it("finds a Chinese question's words, not its characters apart", async () => {
      await seed("trench", "深海", "涉及马里亚纳海沟的生物多样性调查。");
      await seed("noise", "马匹", "马匹护理与沟通要点；亚洲纳税指南；海关里程说明。");
      expect((await ask("马里亚纳海沟")).map((c) => c.doc_id)).toEqual(["trench"]);
    });

    it("finds a Korean question's noun, particle and all", async () => {
      await seed("trench", "심해", "마리아나 해구의 생물 다양성을 조사했다.");
      await seed("noise", "서울", "서울특별시는 대한민국의 수도이다.");
      expect((await ask("마리아나 해구")).map((c) => c.doc_id)).toEqual(["trench"]);
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

      const [chunk0] = await sql<{ tsv: string }[]>`SELECT tsv::text AS tsv FROM doc_chunks WHERE doc_id = 'race' AND chunk_index = 0`;
      expect(chunk0!.tsv).toContain("'blimp'");
      expect(chunk0!.tsv).not.toContain("'zeppelin'");
      expect((await ask("blimp")).map((c) => c.doc_id)).toEqual(["race"]);
    });

    it("matches a question by stem and passes over its stopwords", async () => {
      await seed("snap", "Retention", "A snapshot is retained for thirty days.");
      await seed("filler", "Filler", "They are here and there.");
      expect((await ask("how long are snapshots kept")).map((c) => c.doc_id)).toEqual(["snap"]);
    });
  });
});

describe.skipIf(!URL)("the keyword leg with search languages chosen", () => {
  const AR: SearchLanguage[] = ["ar"];

  beforeAll(async () => {
    await initSearchSchema(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  it("finds a bare Arabic noun in its ال-prefixed form (أرض → الأرض)", async () => {
    await seed("trench", "تقرير استكشاف أعماق البحار", "أعلن علماء المحيطات عن استكشاف جديد لخندق ماريانا، وهو أعمق نقطة في محيطات الأرض.", undefined, AR);
    await seed("noise", "دليل العناية بالخيول", "دليل شامل للعناية بالخيول يغطي العناية بالحوافر وتنظيف العرف.", undefined, AR);
    expect(await ids("أرض", AR)).toEqual(["trench"]);
  });

  it("does not strip a bare Arabic ل proclitic (خندق does not match لخندق)", async () => {
    await seed("trench", "تقرير استكشاف أعماق البحار", "أعلن علماء المحيطات عن استكشاف جديد لخندق ماريانا.", undefined, AR);
    expect(await ids("خندق", AR)).toEqual([]);
  });

  it("still finds Chinese by its words beside the languages chosen", async () => {
    await seed("trench", "深海探测报告", "中国科学院发布了最新的深海探测报告，涉及马里亚纳海沟的生物多样性调查。", undefined, AR);
    await seed("noise", "马匹护理与沟通", "马匹护理与沟通要点；亚洲纳税指南；海关里程说明。", undefined, AR);
    expect(await ids("马里亚纳海沟", AR)).toEqual(["trench"]);
  });

  it("finds each language's word in another of its forms, which English stemming would miss", async () => {
    const cases = [
      ["fr", "Le cheval du village", "chevaux"],
      ["de", "Die Häuser der Altstadt", "Haus"],
      ["es", "Las canciones del verano", "canción"],
      ["ru", "Между домами старого города", "дом"],
      ["el", "Τα σπίτια του χωριού", "σπίτι"],
      ["tr", "Köydeki evlerden biri", "ev"],
    ] as const;
    for (const [lang, text] of cases) await seed(lang, text, text, undefined, SEARCH_LANGUAGES);
    for (const [lang, , query] of cases) expect(await ids(query, SEARCH_LANGUAGES), query).toEqual([lang]);
  });

  it("drops a language's stopwords, so an article the document lacks does not stop a match", async () => {
    await seed("fr", "Maison", "Une maison au bord du lac", undefined, ["fr"]);
    expect(await ids("la maison", ["fr"])).toEqual(["fr"]);
  });

  it("counts a word once however many languages spell its stem alike", async () => {
    await seed("one", "Notes", "test", undefined, SEARCH_LANGUAGES);
    const [row] = await sql<{ positions: number[] }[]>`
      SELECT array_agg(DISTINCT p) AS positions FROM docs, unnest(search_tsv) u, unnest(u.positions) p WHERE doc_id = 'one'`;
    expect(row!.positions).toEqual([1]);
    const [hit] = await search("test", ALICE, null, SEARCH_LANGUAGES);
    const [alone] = await search("test");
    expect(hit!.kw_rank).toBeCloseTo(alone!.kw_rank, 12);
  });
});

describe.skipIf(!URL)("writing the keyword index again", () => {
  beforeAll(async () => {
    await initSearchSchema(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  it("lists the documents written in another format, or never, a page at a time", async () => {
    await seed("a", "Le cheval", "Le cheval du village");
    await seed("b", "Notes", "nothing");
    await sql`INSERT INTO docs (doc_id, workspace_id, owner, title, search_text) VALUES ('c', ${WS}, 'user:alice', 'Raw', 'raw text')`;
    expect(await listDocsToReindex(sql, [], 10)).toEqual(["c"]);
    expect(await listDocsToReindex(sql, ["fr"], 10)).toEqual(["a", "b", "c"]);
    expect(await listDocsToReindex(sql, ["fr"], 2)).toEqual(["a", "b"]);
    expect(await listDocsToReindex(sql, ["fr"], 2, "b")).toEqual(["c"]);
  });

  it("writes a document's vectors and its passages' for other languages, and nothing else", async () => {
    // English stems chevaux as written; French, as cheval.
    await seed("horse", "Village", "Les chevaux du village");
    const [before] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM docs WHERE doc_id = 'horse'`;
    expect(await ids("cheval", ["fr"])).toEqual([]);

    await reindexDocVectors(sql, "horse", ["fr"]);
    expect(await ids("cheval", ["fr"])).toEqual(["horse"]);
    expect((await ask("cheval", ALICE, ["fr"])).map((c) => c.doc_id)).toEqual(["horse"]);
    const [after] = await sql<{ updated_at: Date; search_text: string; search_format: string }[]>`
      SELECT updated_at, search_text, search_format FROM docs WHERE doc_id = 'horse'`;
    expect(after).toEqual({ updated_at: before!.updated_at, search_text: "Les chevaux du village", search_format: searchFormat(["fr"]) });
    expect(await listDocsToReindex(sql, ["fr"], 10)).toEqual([]);
  });

  it("marks a document for writing again when a write of one vector meets older ones", async () => {
    await seed("horse", "Le cheval", "Le cheval du village");
    await updateDoc(sql, "horse", { title: "Les chevaux" }, ["fr"]);
    expect(await listDocsToReindex(sql, ["fr"], 10)).toEqual(["horse"]);
    await reindexDocVectors(sql, "horse", ["fr"]);
    await updateDoc(sql, "horse", { title: "Le cheval" }, ["fr"]);
    expect(await listDocsToReindex(sql, ["fr"], 10)).toEqual([]);
  });
});
