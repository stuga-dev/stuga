/**
 * The online rebuild against pg_search itself, in a database of its own: the
 * languages change on a populated corpus while documents are written and
 * searched, search answers throughout, and the indexes end in the new shape.
 * A node stopped in the middle is finished by the next boot's reconcile.
 * Needs TEST_DATABASE_URL with pg_search preloaded; skips without it.
 */
import {
  askDocs,
  closeClients,
  createClient,
  getSearchLanguages,
  initSchema,
  listSearchIndexes,
  runBootRepairs,
  searchDocs,
  type SearchLanguage,
  type Sql,
} from "@stuga/db";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { createSearchLanguages, type SearchLanguages } from "./languages.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_searchlang_${process.pid}`;
const WS = "ws-langs";
const PRINCIPALS = ["user:liv", `org:${WS}`];
/** Enough rows that a build takes a while, few enough to seed in a moment. */
const CORPUS = 3000;

let maintenance: LockSql;
let sql: Sql;
/** Documents the writers made, across every change. */
let written = 0;
/** The loops still writing or searching, stopped before the connections close whatever a test did. */
const loops = new Set<() => Promise<unknown>>();

const TEXTS = [
  "Consent must be freely given, specific, informed and unambiguous.",
  "정보주체의 동의를 받아야 하며 마리아나 해구의 생물 다양성을 조사했다.",
  "يجب الحصول على موافقة صاحب البيانات قبل المعالجة في محيطات الأرض.",
];

/** Every row of the corpus, plus one chunk each, in one statement per table. */
async function seedCorpus(): Promise<void> {
  await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Laws')`;
  await sql`
    INSERT INTO docs (doc_id, workspace_id, owner, title, search_text, acl_principals)
    SELECT 'd' || i, ${WS}, 'user:liv', 'Law ' || i, (${TEXTS}::text[])[1 + i % 3] || ' Article ' || i, ${PRINCIPALS}::text[]
    FROM generate_series(1, ${CORPUS}) AS i`;
  await sql`
    INSERT INTO doc_chunks (doc_id, workspace_id, chunk_index, content, doc_title)
    SELECT doc_id, workspace_id, 0, search_text, title FROM docs WHERE workspace_id = ${WS}`;
}

/** Writes documents until stopped: new ones, and edits to the corpus. */
function writeWhileRunning(): { stop: () => Promise<number> } {
  let running = true;
  const from = written;
  const loop = (async () => {
    while (running) {
      const n = written++;
      const id = `w${n}`;
      await sql`
        INSERT INTO docs (doc_id, workspace_id, owner, title, search_text, acl_principals)
        VALUES (${id}, ${WS}, 'user:liv', ${`Draft ${n}`}, ${TEXTS[n % 3]!}, ${PRINCIPALS})`;
      await sql`
        INSERT INTO doc_chunks (doc_id, workspace_id, chunk_index, content, doc_title)
        VALUES (${id}, ${WS}, 0, ${TEXTS[n % 3]!}, ${`Draft ${n}`})`;
      await sql`UPDATE docs SET search_text = search_text || ' amended', updated_at = now() WHERE doc_id = ${`d${1 + (n % CORPUS)}`}`;
    }
  })();
  const stop = async () => {
    running = false;
    loops.delete(stop);
    await loop;
    return written - from;
  };
  loops.add(stop);
  return { stop };
}

/**
 * Searches and asks until stopped, with the languages `search` allows at the
 * moment; every one must answer, and find the consent articles.
 */
function searchWhileRunning(search: SearchLanguages): {
  stop: () => Promise<{ answered: number; answeredMidway: number; failures: string[] }>;
} {
  const languages = () => search.current();
  let running = true;
  let answered = 0;
  let answeredMidway = 0;
  const failures: string[] = [];
  const loop = (async () => {
    while (running) {
      try {
        const hits = await searchDocs(sql, {
          embeddingDims: EMBEDDING_DIMS,
          maxDistance: 0.6,
          workspaceId: WS,
          principals: PRINCIPALS,
          query: "consent",
          queryEmbedding: null,
          limit: 5,
          searchLanguages: languages,
        });
        const passages = await askDocs(sql, {
          embeddingDims: EMBEDDING_DIMS,
          maxDistance: 0.9,
          workspaceId: WS,
          principals: PRINCIPALS,
          query: "동의 موافقة consent",
          queryEmbedding: null,
          limit: 5,
          searchLanguages: languages,
        });
        if (hits.length === 0 || passages.length === 0) failures.push("no results");
        answered++;
        if (search.status().rebuilding) answeredMidway++;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
  })();
  const stop = async () => {
    running = false;
    loops.delete(stop);
    await loop;
    return { answered, answeredMidway, failures };
  };
  loops.add(stop);
  return { stop };
}

const indexes = async () =>
  (await listSearchIndexes(sql)).map((i) => `${i.name}${i.valid ? "" : " (invalid)"}`).sort();

const koreanHits = async (languages: readonly SearchLanguage[]) =>
  searchDocs(sql, {
    embeddingDims: EMBEDDING_DIMS,
    maxDistance: 0.6,
    workspaceId: WS,
    principals: PRINCIPALS,
    // Only the Korean segmenter finds 해구의 from 해구.
    query: "해구",
    queryEmbedding: null,
    limit: 5,
    searchLanguages: () => languages,
  });

describe.skipIf(!URL)("changing the search languages online", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    await runBootRepairs(sql);
    await seedCorpus();
    vi.spyOn(console, "info").mockImplementation(() => {});
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled([...loops].map((stop) => stop()));
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  async function change(search: SearchLanguages, to: SearchLanguage[]) {
    const writers = writeWhileRunning();
    const searchers = searchWhileRunning(search);
    const rebuilt = search.rebuild(to);
    expect(search.status()).toEqual({ languages: to, rebuilding: true, error: null });
    await rebuilt;
    return { written: await writers.stop(), ...(await searchers.stop()) };
  }

  it("adds and removes languages on a populated corpus while it is written and searched", async () => {
    const search = createSearchLanguages({ sql, languages: [] });
    expect(await koreanHits([])).toEqual([]);

    const on = await change(search, ["ko", "ar"]);
    expect(on.failures).toEqual([]);
    expect(on.answeredMidway).toBeGreaterThan(0);
    expect(on.written).toBeGreaterThan(0);
    expect(search.status()).toEqual({ languages: ["ko", "ar"], rebuilding: false, error: null });
    expect(search.current()).toEqual(["ko", "ar"]);
    expect(await indexes()).toEqual(["doc_chunks_bm25_v1_ar_ko", "docs_bm25_v1_ar_ko"]);
    expect((await koreanHits(["ko", "ar"])).length).toBeGreaterThan(0);
    // What was written during the build is in the new indexes.
    const [counts] = await sql<{ docs: number; indexed_docs: number; chunks: number; indexed_chunks: number }[]>`
      SELECT (SELECT count(*)::int FROM docs) AS docs,
             (SELECT count(*)::int FROM docs WHERE doc_id @@@ paradedb.all()) AS indexed_docs,
             (SELECT count(*)::int FROM doc_chunks) AS chunks,
             (SELECT count(*)::int FROM doc_chunks WHERE doc_id @@@ paradedb.all()) AS indexed_chunks`;
    expect(counts!.indexed_docs).toBe(counts!.docs);
    expect(counts!.indexed_chunks).toBe(counts!.chunks);

    const off = await change(search, ["ar"]);
    expect(off.failures).toEqual([]);
    expect(search.current()).toEqual(["ar"]);
    expect(await indexes()).toEqual(["doc_chunks_bm25_v1_ar", "docs_bm25_v1_ar"]);
    await expect(koreanHits(["ko"])).rejects.toThrow(/is not part of the pg_search index/);
  }, 180_000);

  it("a query that read the languages before the swap is answered on its retry", async () => {
    const search = createSearchLanguages({ sql, languages: ["ar"] });
    await search.rebuild([]);
    // The getter answers the stale set once, as a request that read it before the swap would.
    let reads = 0;
    const stale = () => (reads++ === 0 ? (["ar"] as const) : search.current());
    const hits = await searchDocs(sql, {
      embeddingDims: EMBEDDING_DIMS,
      maxDistance: 0.6,
      workspaceId: WS,
      principals: PRINCIPALS,
      query: "consent",
      queryEmbedding: null,
      searchLanguages: stale,
    });
    expect(reads).toBe(2);
    expect(hits.length).toBeGreaterThan(0);
  }, 60_000);

  it("a node stopped in the middle of a rebuild is finished by the next boot", async () => {
    const search = createSearchLanguages({ sql, languages: [] });
    expect(await indexes()).toEqual(["doc_chunks_bm25_v1", "docs_bm25_v1"]);

    // An open snapshot holds the concurrent build in its wait, with its index made but not valid.
    const holder = sessionConnection(withDatabase(URL!, DB));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const snapshot = holder.begin("ISOLATION LEVEL REPEATABLE READ", async (tx) => {
      await tx`SELECT count(*) FROM docs`;
      held();
      await released;
    });
    await holding;
    try {
      // As Settings saves it: the setting first, then the rebuild.
      await search.save(["ko"], null);
      await vi.waitFor(async () => expect(await indexes()).toContain("docs_bm25_v1_ko (invalid)"), { timeout: 30_000, interval: 50 });
      await search.stop();
    } finally {
      release();
      await snapshot;
      await holder.end({ timeout: 5 });
    }
    expect(search.current()).toEqual([]);
    expect(await indexes()).toEqual(["doc_chunks_bm25_v1", "docs_bm25_v1", "docs_bm25_v1_ko (invalid)"]);

    // The setting was saved before the rebuild began, so the next boot reads it and reconciles to it.
    const repairs = await runBootRepairs(sql, { searchLanguages: (await getSearchLanguages(sql)) ?? [] });
    expect(repairs.searchIndexChanges.sort()).toEqual(["+doc_chunks_bm25_v1_ko", "-doc_chunks_bm25_v1", "-docs_bm25_v1"]);
    expect(repairs.rebuiltSearchIndexes).toEqual(["docs_bm25_v1_ko"]);
    expect(await indexes()).toEqual(["doc_chunks_bm25_v1_ko", "docs_bm25_v1_ko"]);
    expect((await koreanHits(["ko"])).length).toBeGreaterThan(0);
  }, 120_000);
});
