/**
 * The background pass against Postgres, in a database of its own: the
 * languages change on a populated corpus while documents are written and
 * searched, search answers throughout, and every document ends written for the
 * new languages. A node stopped in the middle is finished by the next start.
 * Needs TEST_DATABASE_URL; skips without it.
 */
import {
  askDocs,
  closeClients,
  createClient,
  createDoc,
  getSearchLanguages,
  indexDoc,
  initSchema,
  listDocsToReindex,
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
/** Enough rows that a pass takes a while, few enough to seed in a moment. */
const CORPUS = 3000;

let maintenance: LockSql;
let sql: Sql;
/** Documents the writers made, across every change. */
let written = 0;
/** The loops still writing or searching, stopped before the connections close whatever a test did. */
const loops = new Set<() => Promise<unknown>>();

const TEXTS = [
  "Consent must be freely given, specific, informed and unambiguous.",
  "Les chevaux du village attendent le consentement du maire.",
  "يجب الحصول على موافقة صاحب البيانات قبل المعالجة في محيطات الأرض.",
];

/** Every row of the corpus, plus one chunk each, in one statement per table, written as no node yet has. */
async function seedCorpus(): Promise<void> {
  await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Laws')`;
  await sql`
    INSERT INTO docs (doc_id, workspace_id, owner, title, search_text, acl_principals)
    SELECT 'd' || lpad(i::text, 5, '0'), ${WS}, 'user:liv', 'Law ' || i, (${TEXTS}::text[])[1 + i % 3] || ' Article ' || i, ${PRINCIPALS}::text[]
    FROM generate_series(1, ${CORPUS}) AS i`;
  await sql`
    INSERT INTO doc_chunks (doc_id, workspace_id, chunk_index, content)
    SELECT doc_id, workspace_id, 0, search_text FROM docs WHERE workspace_id = ${WS}`;
}

/** Writes documents until stopped, as the index job does, in the languages `search` says now. */
function writeWhileRunning(search: SearchLanguages): { stop: () => Promise<number> } {
  let running = true;
  const from = written;
  const loop = (async () => {
    while (running) {
      const n = written++;
      const docId = `w${n}`;
      const text = TEXTS[n % 3]!;
      const languages = search.current();
      await createDoc(sql, { docId, workspaceId: WS, owner: "user:liv", title: `Draft ${n}`, aclPrincipals: PRINCIPALS, searchLanguages: languages });
      await indexDoc(sql, {
        embeddingDims: EMBEDDING_DIMS,
        docId,
        snapshotSeq: 1,
        title: `Draft ${n}`,
        searchText: text,
        embeddingHash: `h-${docId}`,
        chunks: [{ content: text, embedding: null, embedHash: `eh-${docId}` }],
        searchLanguages: languages,
      });
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
 * Searches and asks until stopped, in the languages `search` says now; every
 * one must answer, and find the consent articles.
 */
function searchWhileRunning(search: SearchLanguages): {
  stop: () => Promise<{ answered: number; answeredMidway: number; failures: string[] }>;
} {
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
          searchLanguages: () => search.current(),
        });
        const passages = await askDocs(sql, {
          embeddingDims: EMBEDDING_DIMS,
          workspaceId: WS,
          principals: PRINCIPALS,
          query: "موافقة consent",
          queryEmbedding: null,
          limit: 5,
          searchLanguages: () => search.current(),
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

/** Finds a horse under a French stem only: English keeps chevaux as written. */
const horses = async (languages: readonly SearchLanguage[]) =>
  (
    await searchDocs(sql, {
      embeddingDims: EMBEDDING_DIMS,
      maxDistance: 0.6,
      workspaceId: WS,
      principals: PRINCIPALS,
      query: "cheval",
      queryEmbedding: null,
      limit: 5,
      searchLanguages: () => languages,
    })
  ).length;

describe.skipIf(!URL)("changing the search languages", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)} TEMPLATE template0 LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
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
    const writers = writeWhileRunning(search);
    const searchers = searchWhileRunning(search);
    const rebuilt = search.rebuild(to);
    expect(search.status()).toEqual({ languages: to, rebuilding: true, error: null });
    await rebuilt;
    return { written: await writers.stop(), ...(await searchers.stop()) };
  }

  it("writes a corpus no node has indexed at the first start", async () => {
    const search = createSearchLanguages({ sql, languages: [] });
    expect(await listDocsToReindex(sql, [], 1)).toEqual(["d00001"]);
    await search.rebuild([]);
    expect(await listDocsToReindex(sql, [], 1)).toEqual([]);
    expect(search.status()).toEqual({ languages: [], rebuilding: false, error: null });
  }, 120_000);

  it("adds and removes languages on a populated corpus while it is written and searched", async () => {
    const search = createSearchLanguages({ sql, languages: [] });
    expect(await horses(["fr"])).toBe(0);

    const on = await change(search, ["fr", "ar"]);
    expect(on.failures).toEqual([]);
    expect(on.answeredMidway).toBeGreaterThan(0);
    expect(on.written).toBeGreaterThan(0);
    expect(search.status()).toEqual({ languages: ["fr", "ar"], rebuilding: false, error: null });
    expect(search.current()).toEqual(["fr", "ar"]);
    // What was written during the pass is in the new languages too.
    expect(await listDocsToReindex(sql, ["fr", "ar"], 1)).toEqual([]);
    expect(await horses(["fr", "ar"])).toBeGreaterThan(0);

    const off = await change(search, ["ar"]);
    expect(off.failures).toEqual([]);
    expect(search.current()).toEqual(["ar"]);
    expect(await listDocsToReindex(sql, ["ar"], 1)).toEqual([]);
    expect(await horses(["ar"])).toBe(0);
  }, 180_000);

  it("a node stopped in the middle of a pass is finished by the next start", async () => {
    const search = createSearchLanguages({ sql, languages: ["ar"] });
    // As Settings saves it: the setting first, then the pass, which the node stops at once.
    await search.save(["fr"], null);
    await search.stop();
    expect(search.status().rebuilding).toBe(false);
    expect((await listDocsToReindex(sql, ["fr"], 10)).length).toBeGreaterThan(0);

    // The setting was saved before the pass began, so the next start reads it and finishes.
    const next = createSearchLanguages({ sql, languages: (await getSearchLanguages(sql)) ?? [] });
    await next.rebuild(next.current());
    expect(next.current()).toEqual(["fr"]);
    expect(await listDocsToReindex(sql, ["fr"], 1)).toEqual([]);
    expect(await horses(["fr"])).toBeGreaterThan(0);
  }, 120_000);
});
