/**
 * The BM25 indexes the keyword leg of search reads. Their shape depends on
 * SEARCH_LANGUAGES, so they are reconciled on every boot rather than created by
 * a migration.
 */
import type { Sql } from "../client.js";

/**
 * A language pg_search gets a more accurate tokenizer for, beyond the generic
 * `pdb.icu` every corpus gets. ICU segments Chinese and Japanese on its own but
 * treats Korean and Arabic as already spaced, so a glued-on particle (Korean 의,
 * Arabic ل) stays attached. `ko` uses a Korean dictionary segmenter; `ar` adds
 * Arabic stemming, which strips ال but not a bare ل.
 */
export type SearchLanguage = "ko" | "ar";

export const SEARCH_LANGUAGES: readonly SearchLanguage[] = ["ko", "ar"];

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
 * The index NAME encodes its shape: reconcile drops every bm25 index on these
 * tables that is not named here, so changing a field or tokenizer means changing
 * the suffix. `all_text` keeps words as written beside the stemmed `all_text_en`,
 * so a stopword-only title still matches; `search_text` is indexed under its own
 * name because pdb.snippet() cannot highlight an aliased field.
 */
function bm25Indexes(languages: readonly SearchLanguage[]): readonly { table: string; name: string; ddl: string }[] {
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
      ddl: `CREATE INDEX docs_bm25_v1${suffix} ON docs
              USING bm25 (
                doc_id,
                (title::pdb.icu),
                (search_text::pdb.icu(${ENGLISH})),
                ((title || ' ' || search_text)::pdb.icu('alias=all_text')),
                ((title || ' ' || search_text)::pdb.icu(${ENGLISH}, 'alias=all_text_en'))${docsExtra}
              )
              WITH (key_field = 'doc_id')`,
    },
    {
      // key_field need not be unique: the index identifies a row by its ctid.
      table: "doc_chunks",
      name: `doc_chunks_bm25_v1${suffix}`,
      ddl: `CREATE INDEX doc_chunks_bm25_v1${suffix} ON doc_chunks
              USING bm25 (
                doc_id,
                ((${CHUNK_TEXT})::pdb.icu(${ENGLISH}, 'alias=chunk_text'))${chunksExtra}
              )
              WITH (key_field = 'doc_id')`,
    },
  ];
}

export interface SearchIndexRepair {
  /** Indexes created (`+name`) or dropped (`-name`) to match the languages. */
  changes: string[];
  /** Indexes rebuilt because another pg_search version built them. */
  rebuilt: string[];
}

/**
 * Make the database's BM25 indexes exactly the ones `languages` define: drop any
 * other bm25 index on the searched tables and build each missing one. Building
 * over an existing corpus is slow, and happens once per shape change.
 *
 * Each index's comment names the pg_search that built it. A release may change
 * the on-disk format and not every one says so, so an index built by any other
 * version, or by an unknown one, is rebuilt rather than trusted.
 */
export async function reconcileSearchIndexes(sql: Sql, languages: readonly SearchLanguage[]): Promise<SearchIndexRepair> {
  const changes: string[] = [];
  const rebuilt: string[] = [];
  const indexes = bm25Indexes(languages);
  const wanted = new Set(indexes.map((i) => i.name));

  // The installed binary's version, which is what writes the index, even when
  // the catalog entry could not be brought level with it.
  const [ext] = await sql<{ default_version: string }[]>`
    SELECT default_version FROM pg_available_extensions WHERE name = 'pg_search'`;
  const builtBy = `pg_search ${ext?.default_version ?? "unknown"}`;
  const markBuilt = (name: string) =>
    sql.unsafe(`COMMENT ON INDEX "${name}" IS '${builtBy.replaceAll("'", "''")}'`);

  const present = await sql<{ indexname: string; built_by: string | null }[]>`
    SELECT c.relname AS indexname, obj_description(c.oid, 'pg_class') AS built_by
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE am.amname = 'bm25'
      AND n.nspname = 'public'
      AND t.relname = ANY(${indexes.map((i) => i.table)})`;

  for (const { indexname, built_by } of present) {
    if (wanted.has(indexname)) {
      if (built_by === builtBy) continue;
      await sql.unsafe(`REINDEX INDEX "${indexname}"`);
      await markBuilt(indexname);
      rebuilt.push(indexname);
      continue;
    }
    if (!INDEX_NAME.test(indexname)) continue;
    await sql.unsafe(`DROP INDEX IF EXISTS "${indexname}"`);
    changes.push(`-${indexname}`);
  }

  const have = new Set(present.map((p) => p.indexname));
  for (const index of indexes) {
    if (have.has(index.name)) continue;
    await sql.unsafe(index.ddl);
    await markBuilt(index.name);
    changes.push(`+${index.name}`);
  }
  return { changes, rebuilt };
}
