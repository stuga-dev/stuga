/**
 * The BM25 indexes the keyword leg of search reads. Their shape depends on the
 * node's search languages, so they are reconciled on every boot rather than
 * created by a migration, and rebuilt online when the setting changes.
 */
import { createHash } from "node:crypto";
import { SEARCH_LANGUAGES, type SearchLanguage } from "@stuga/protocol/domain/search-languages";
import type { Sql } from "../client.js";

export { SEARCH_LANGUAGES, type SearchLanguage };

const INDEX_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Whether a shared_preload_libraries value names pg_search. Entries may be
 * quoted, written as a path, or carry a file suffix; the library is an entry's
 * last path segment without it.
 */
export function preloadsPgSearch(setting: string): boolean {
  return setting.split(",").some((entry) => {
    const lib = entry.trim().replace(/^["']+|["']+$/g, "").trim();
    return lib.slice(lib.lastIndexOf("/") + 1).replace(/\.(so|dylib)$/, "") === "pg_search";
  });
}

/** The letters of a script, as a regex bracket's ranges. */
const LATIN = "A-Za-zÀ-ÖØ-öø-ɏ";
const CYRILLIC = "Ѐ-ӿ";
const HAN = "㐀-䶿一-鿿";
const KANA = "ぁ-ヿ";

/**
 * Each language's column: the script whose text it sees, and its tokenizer. A column only sees
 * text containing its script, so a Chinese document costs the Latin languages nothing, and
 * lindera(korean) never mis-segments Chinese into character-level false positives. Chinese also
 * skips text with kana, which is Japanese written partly in Chinese characters. Stopwords are
 * dropped for a language pg_search has a list for.
 */
const LANGUAGE_COLUMNS: Record<SearchLanguage, { script: string; unless?: string; tokenizer: (alias: string) => string }> = {
  ar: { script: "؀-ۿ", tokenizer: stemmed("arabic") },
  cs: { script: LATIN, tokenizer: stemmed("czech", { stopwords: true }) },
  da: { script: LATIN, tokenizer: stemmed("danish", { stopwords: true }) },
  de: { script: LATIN, tokenizer: stemmed("german", { stopwords: true }) },
  el: { script: "Ͱ-Ͽἀ-῾", tokenizer: stemmed("greek") },
  es: { script: LATIN, tokenizer: stemmed("spanish", { stopwords: true }) },
  fi: { script: LATIN, tokenizer: stemmed("finnish", { stopwords: true }) },
  fr: { script: LATIN, tokenizer: stemmed("french", { stopwords: true }) },
  hu: { script: LATIN, tokenizer: stemmed("hungarian", { stopwords: true }) },
  it: { script: LATIN, tokenizer: stemmed("italian", { stopwords: true }) },
  ja: { script: KANA, tokenizer: (alias) => `pdb.lindera(japanese, 'alias=${alias}')` },
  ko: { script: "가-힣", tokenizer: (alias) => `pdb.lindera(korean, 'alias=${alias}')` },
  nl: { script: LATIN, tokenizer: stemmed("dutch", { stopwords: true }) },
  no: { script: LATIN, tokenizer: stemmed("norwegian", { stopwords: true }) },
  pl: { script: LATIN, tokenizer: stemmed("polish", { stopwords: true }) },
  pt: { script: LATIN, tokenizer: stemmed("portuguese", { stopwords: true }) },
  ro: { script: LATIN, tokenizer: stemmed("romanian") },
  ru: { script: CYRILLIC, tokenizer: stemmed("russian", { stopwords: true }) },
  sv: { script: LATIN, tokenizer: stemmed("swedish", { stopwords: true }) },
  ta: { script: "஀-௿", tokenizer: stemmed("tamil") },
  tr: { script: LATIN, tokenizer: stemmed("turkish") },
  // Traditional characters are folded to simplified first, in documents and queries alike, so either
  // script finds the other; jieba's dictionary is simplified, and splits traditional text badly.
  zh: { script: HAN, unless: KANA, tokenizer: (alias) => `pdb.jieba('chinese_convert=t2s', 'alias=${alias}')` },
};

function stemmed(language: string, opts: { stopwords?: boolean } = {}): (alias: string) => string {
  const stopwords = opts.stopwords ? `, 'stopwords_language=${language}'` : "";
  return (alias) => `pdb.icu('stemmer=${language}'${stopwords}, 'alias=${alias}')`;
}

function gated(lang: SearchLanguage, expr: string): string {
  const { script, unless } = LANGUAGE_COLUMNS[lang];
  const skip = unless ? ` AND (${expr}) !~ '[${unless}]'` : "";
  return `(CASE WHEN (${expr}) ~ '[${script}]'${skip} THEN (${expr}) ELSE '' END)`;
}

/** Postgres cuts a longer identifier short, which would leave reconcile looking for a name it can never find. */
const MAX_IDENTIFIER = 63;

/**
 * What an index name adds for its languages: their codes while the longest name fits, else a hash
 * of them, which still changes with the set.
 */
function languageSuffix(langs: readonly string[]): string {
  if (!langs.length) return "";
  const readable = `_${langs.join("_")}`;
  if (`doc_chunks_bm25_v1${readable}`.length <= MAX_IDENTIFIER) return readable;
  return `_h${createHash("sha256").update(langs.join(",")).digest("hex").slice(0, 12)}`;
}

const ENGLISH = "'stemmer=english', 'stopwords_language=english'";

/** A chunk's searchable text: the document title (chunk 0 only), heading and passage. */
const CHUNK_TEXT = "coalesce(doc_title, '') || ' ' || coalesce(heading_path, '') || ' ' || content";

/**
 * Each write indexed as it is made, for the docs index, whose rows are whole documents: by default
 * pg_search keeps its last 1,000 rows unindexed in a mutable segment that every query tokenizes
 * again, which over a few long documents makes a search take seconds. Chunks are short, so their
 * index keeps the default and is spared a segment per write.
 */
const INDEXED_ON_WRITE = "mutable_segment_rows = 0";

/** One BM25 index of a language set. */
export interface SearchIndexShape {
  table: "docs" | "doc_chunks";
  /** Encodes the shape: the table, the version of its fields and the languages. */
  name: string;
  /** What follows `ON <table>` in its CREATE INDEX. */
  definition: string;
}

/**
 * The index NAME encodes its shape: reconcile drops every bm25 index on these
 * tables that is not named here, so changing a field or tokenizer means changing
 * the suffix. `all_text` keeps words as written beside the stemmed `all_text_en`,
 * so a stopword-only title still matches; `search_text` is indexed under its own
 * name because pdb.snippet() cannot highlight an aliased field.
 */
export function searchIndexShapes(languages: readonly SearchLanguage[]): readonly SearchIndexShape[] {
  const langs = [...new Set(languages)].sort();
  const suffix = languageSuffix(langs);
  const docsExtra = langs
    .map((l) => `,\n              (${gated(l, "title || ' ' || search_text")}::${LANGUAGE_COLUMNS[l].tokenizer(`all_text_${l}`)})`)
    .join("");
  const chunksExtra = langs
    .map((l) => `,\n              (${gated(l, CHUNK_TEXT)}::${LANGUAGE_COLUMNS[l].tokenizer(`chunk_text_${l}`)})`)
    .join("");
  return [
    {
      table: "docs",
      name: `docs_bm25_v1${suffix}`,
      definition: `USING bm25 (
                doc_id,
                (title::pdb.icu),
                (search_text::pdb.icu(${ENGLISH})),
                ((title || ' ' || search_text)::pdb.icu('alias=all_text')),
                ((title || ' ' || search_text)::pdb.icu(${ENGLISH}, 'alias=all_text_en'))${docsExtra}
              )
              WITH (key_field = 'doc_id', ${INDEXED_ON_WRITE})`,
    },
    {
      // key_field need not be unique: the index identifies a row by its ctid.
      table: "doc_chunks",
      name: `doc_chunks_bm25_v1${suffix}`,
      definition: `USING bm25 (
                doc_id,
                ((${CHUNK_TEXT})::pdb.icu(${ENGLISH}, 'alias=chunk_text'))${chunksExtra}
              )
              WITH (key_field = 'doc_id')`,
    },
  ];
}

/** A bm25 index on a searched table, as the catalog has it. */
export interface PresentSearchIndex {
  name: string;
  table: string;
  /** False while a concurrent build is under way, and after one failed. */
  valid: boolean;
  /** The comment `markBuilt` left: which pg_search built it. */
  builtBy: string | null;
}

/** Every bm25 index on the searched tables, valid or not. */
export async function listSearchIndexes(sql: Sql): Promise<PresentSearchIndex[]> {
  const tables = searchIndexShapes([]).map((i) => i.table);
  return sql<PresentSearchIndex[]>`
    SELECT c.relname AS name, t.relname AS "table", i.indisvalid AS valid,
           obj_description(c.oid, 'pg_class') AS "builtBy"
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE am.amname = 'bm25'
      AND n.nspname = 'public'
      AND t.relname = ANY(${tables})
    ORDER BY c.oid`;
}

/** Whether an index name can be written into DDL as it is; one that cannot is left alone. */
export function isPlainIndexName(name: string): boolean {
  return INDEX_NAME.test(name);
}

/** Whether an index is named as the BM25 indexes Stuga builds are, whatever its languages and version. */
export function isSearchIndexName(name: string): boolean {
  return searchIndexShapes([]).some((i) => name.startsWith(`${i.table}_bm25_`));
}

/**
 * What an index's comment says about the pg_search that built it: the installed
 * binary's version, which is what writes the index, even when the catalog entry
 * could not be brought level with it.
 */
async function builtByThisPgSearch(sql: Sql): Promise<string> {
  const [ext] = await sql<{ default_version: string }[]>`
    SELECT default_version FROM pg_available_extensions WHERE name = 'pg_search'`;
  return `pg_search ${ext?.default_version ?? "unknown"}`;
}

async function markBuilt(sql: Sql, name: string, builtBy: string): Promise<void> {
  await sql.unsafe(`COMMENT ON INDEX "${name}" IS '${builtBy.replaceAll("'", "''")}'`);
}

/** Run one statement that `signal` cancels; it then fails as cancelled, and one never sent is not sent. */
async function cancellable(signal: AbortSignal | undefined, statement: () => ReturnType<Sql["unsafe"]>): Promise<void> {
  signal?.throwIfAborted();
  const query = statement();
  const cancel = () => query.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await query;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Build one index and mark it with the pg_search that built it. Concurrently,
 * writes go on while it builds and queries keep reading the table's other
 * index until this one is valid; a failed concurrent build leaves an invalid
 * index under the name, which has to be dropped before the name is built again.
 * A plain build is refused while the table has any other bm25 index.
 */
export async function createSearchIndex(
  sql: Sql,
  index: SearchIndexShape,
  opts: { concurrently?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const concurrently = opts.concurrently ? "CONCURRENTLY " : "";
  await cancellable(opts.signal, () =>
    sql.unsafe(`CREATE INDEX ${concurrently}${index.name} ON ${index.table} ${index.definition}`),
  );
  await markBuilt(sql, index.name, await builtByThisPgSearch(sql));
}

/** Drop one index if it is there. Concurrently, queries and writes go on meanwhile. */
export async function dropSearchIndex(
  sql: Sql,
  name: string,
  opts: { concurrently?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (!isPlainIndexName(name)) throw new Error(`not an index name Stuga builds: ${JSON.stringify(name)}`);
  const concurrently = opts.concurrently ? "CONCURRENTLY " : "";
  await cancellable(opts.signal, () => sql.unsafe(`DROP INDEX ${concurrently}IF EXISTS "${name}"`));
}

export interface SearchIndexRepair {
  /** Indexes created (`+name`) or dropped (`-name`) to match the languages. */
  changes: string[];
  /**
   * Indexes rebuilt because another pg_search version built them, a build did not finish, or they
   * were built to leave writes unindexed until a query.
   */
  rebuilt: string[];
}

/** Those of the indexes named that lack INDEXED_ON_WRITE, as every index built before it did. */
async function indexedOnQuery(sql: Sql, names: readonly string[]): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${names})
      AND NOT coalesce(c.reloptions, '{}') @> ARRAY['mutable_segment_rows=0']`;
  return new Set(rows.map((r) => r.name));
}

/**
 * Make the database's BM25 indexes exactly the ones `languages` define: drop any
 * other bm25 index on the searched tables and build each missing one. Building
 * over an existing corpus is slow, and happens once per shape change. Plain
 * statements, since nothing is searching yet; a table holds only one bm25 index
 * by the time one is built.
 *
 * Each index's comment names the pg_search that built it. A release may change
 * the on-disk format and not every one says so, so an index built by any other
 * version, or by an unknown one, is rebuilt rather than trusted. So is one left
 * invalid by an online rebuild the node stopped in the middle of, and one built
 * before INDEXED_ON_WRITE, which is switched to it first.
 */
export async function reconcileSearchIndexes(sql: Sql, languages: readonly SearchLanguage[]): Promise<SearchIndexRepair> {
  const changes: string[] = [];
  const rebuilt: string[] = [];
  const indexes = searchIndexShapes(languages);
  const wanted = new Set(indexes.map((i) => i.name));
  const builtBy = await builtByThisPgSearch(sql);
  const present = await listSearchIndexes(sql);

  for (const { name } of present) {
    if (wanted.has(name) || !isPlainIndexName(name)) continue;
    await dropSearchIndex(sql, name);
    changes.push(`-${name}`);
  }

  const onQuery = await indexedOnQuery(sql, indexes.filter((i) => i.definition.includes(INDEXED_ON_WRITE)).map((i) => i.name));
  for (const { name, valid, builtBy: by } of present) {
    if (!wanted.has(name) || (valid && by === builtBy && !onQuery.has(name))) continue;
    if (onQuery.has(name)) await sql.unsafe(`ALTER INDEX "${name}" SET (${INDEXED_ON_WRITE})`);
    await sql.unsafe(`REINDEX INDEX "${name}"`);
    await markBuilt(sql, name, builtBy);
    rebuilt.push(name);
  }

  const have = new Set(present.map((p) => p.name));
  for (const index of indexes) {
    if (have.has(index.name)) continue;
    await createSearchIndex(sql, index);
    changes.push(`+${index.name}`);
  }
  return { changes, rebuilt };
}
