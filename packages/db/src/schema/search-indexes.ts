/**
 * The BM25 indexes the keyword leg of search reads. Their shape depends on the
 * node's search languages, so they are reconciled on every boot rather than
 * created by a migration, and rebuilt online when the setting changes.
 */
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

// A per-language column only sees text containing its script: lindera(korean)
// mis-segments Chinese, which would reintroduce character-level false positives.
const LANG_SCRIPT_RANGE: Record<SearchLanguage, string> = {
  ko: "가-힣",
  ar: "؀-ۿ",
};

const LANG_CAST: Record<SearchLanguage, (alias: string) => string> = {
  ko: (alias) => `pdb.lindera(korean, 'alias=${alias}')`,
  ar: (alias) => `pdb.icu('stemmer=arabic', 'alias=${alias}')`,
};

function gated(lang: SearchLanguage, expr: string): string {
  return `(CASE WHEN (${expr}) ~ '[${LANG_SCRIPT_RANGE[lang]}]' THEN (${expr}) ELSE '' END)`;
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
  const suffix = langs.length ? `_${langs.join("_")}` : "";
  const docsExtra = langs
    .map((l) => `,\n              (${gated(l, "title || ' ' || search_text")}::${LANG_CAST[l](`all_text_${l}`)})`)
    .join("");
  const chunksExtra = langs
    .map((l) => `,\n              (${gated(l, CHUNK_TEXT)}::${LANG_CAST[l](`chunk_text_${l}`)})`)
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
