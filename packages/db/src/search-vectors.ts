/**
 * What the keyword index holds for a row: a tsvector of its text's terms (search-text.ts), and the
 * number of terms, which BM25 normalises by. A word is stemmed under English and under each of the
 * node's search languages, each stem at the word's own position, so a word counts once however many
 * configurations spell it alike, and the n-th position is the n-th word of `searchTokens`; CJK and
 * Thai terms are written as they are. Titles and bodies also hold their words as written, without a
 * position, which a word being typed is matched against and a query of stopwords alone finds in a
 * title. A row records the format it was written in, and a row in another is written again in the
 * background.
 */
import type { Fragment } from "postgres";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import type { Sql } from "./client.js";
import { SEARCH_FORMAT, searchTokens } from "./search-text.js";
import type { Queryable } from "./sql.js";

/** Each search language's Postgres text search configuration. */
export const SEARCH_CONFIGS: Readonly<Record<SearchLanguage, string>> = {
  ar: "arabic",
  da: "danish",
  de: "german",
  el: "greek",
  es: "spanish",
  fi: "finnish",
  fr: "french",
  hu: "hungarian",
  it: "italian",
  nl: "dutch",
  no: "norwegian",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sv: "swedish",
  ta: "tamil",
  tr: "turkish",
};

/** The configurations words are stemmed under: English, then each chosen language's. */
export function searchConfigs(languages: readonly SearchLanguage[]): string[] {
  return ["english", ...[...new Set(languages)].sort().map((l) => SEARCH_CONFIGS[l])];
}

/** Moves when what this module writes changes. */
const VECTORS = 1;

/** The format a row's vectors are written in: the text's spelling, this module's, and the configurations. */
export function searchFormat(languages: readonly SearchLanguage[]): string {
  return `${SEARCH_FORMAT}/v${VECTORS}/${searchConfigs(languages).join("+")}`;
}

/** Postgres keeps positions up to this one, and a later word at it. */
export const MAX_POSITION = 16383;
/** Positions a lexeme keeps; Postgres drops the rest. */
const MAX_POSITIONS = 256;
/**
 * Bytes one vector is given: a tsvector holds less than 1 MiB of lexemes, each padded to an even
 * length, with two bytes for its count of positions and two for each position. A word is counted
 * once per configuration, with its positions, and once more as written; a text past this is indexed
 * from its start.
 */
const VECTOR_BYTES = 1_000_000;

/** One text's terms as the vector SQL reads them: each distinct term and its positions ("1,5,9"). */
export interface VectorTerms {
  latin: Record<string, string>;
  cjk: Record<string, string>;
  /** Terms in the text, BM25's document length. */
  length: number;
}

/** The terms of `text`, for a vector under `configs` configurations. */
export function vectorTerms(text: string, configs: number): VectorTerms {
  const at = { latin: new Map<string, number[]>(), cjk: new Map<string, number[]>() };
  const count = { latin: 0, cjk: 0 };
  let bytes = 0;
  let full = false;
  for (const token of searchTokens(text)) {
    const position = Math.min(++count[token.part], MAX_POSITION);
    const copies = token.part === "latin" ? configs : 1;
    const positions = at[token.part].get(token.term);
    if (positions) {
      if (positions.length >= MAX_POSITIONS || positions[positions.length - 1] === position) continue;
      bytes += 2 * copies;
      full ||= bytes > VECTOR_BYTES;
      if (!full) positions.push(position);
      continue;
    }
    const padded = Buffer.byteLength(token.term) + 1;
    bytes += copies * (padded + 4) + (token.part === "latin" ? padded : 0);
    full ||= bytes > VECTOR_BYTES;
    if (!full) at[token.part].set(token.term, [position]);
  }
  const record = (map: Map<string, number[]>) => Object.fromEntries([...map].map(([term, p]) => [term, p.join(",")]));
  return { latin: record(at.latin), cjk: record(at.cjk), length: count.latin + count.cjk };
}

/**
 * The tsvector of a text whose terms `latin` and `cjk` hold (jsonb, as `vectorTerms` makes them).
 * Built as tsvector text, since `||` would shift each configuration's positions past the one before.
 * With `asWritten`, each word is also there as written, without a position.
 */
export function vectorSql(sql: Queryable, latin: Fragment, cjk: Fragment, configs: readonly string[], asWritten: boolean): Fragment {
  const written = asWritten
    ? sql`UNION ALL
            SELECT s.lexeme, NULL FROM jsonb_each_text(${latin}) w, unnest(to_tsvector('simple', w.key)) s`
    : sql``;
  return sql`(
      SELECT coalesce(string_agg(
               '''' || replace(replace(x.lexeme, '\\', '\\\\'), '''', '''''') || '''' || coalesce(':' || x.at, ''), ' ')::tsvector,
             ''::tsvector)
      FROM (SELECT v.lexeme, string_agg(v.at, ',') AS at
            FROM (SELECT s.lexeme, w.value AS at
                  FROM jsonb_each_text(${latin}) w, unnest(${[...configs]}::regconfig[]) c(cfg), unnest(to_tsvector(c.cfg, w.key)) s
                  UNION ALL
                  SELECT w.key, w.value FROM jsonb_each_text(${cjk}) w
                  ${written}) v
            GROUP BY v.lexeme) x)`;
}

/** The vector of one text, bound as parameters. */
export function textVectorSql(sql: Queryable, terms: VectorTerms, configs: readonly string[], asWritten: boolean): Fragment {
  // Bound as text: a parameter Postgres reads as jsonb would be sent as a JSON string.
  const latin = sql`${JSON.stringify(terms.latin)}::text::jsonb`;
  return vectorSql(sql, latin, sql`${JSON.stringify(terms.cjk)}::text::jsonb`, configs, asWritten);
}

/** A passage's searchable text: the document title (the opening passage only), its heading and the passage. */
export function chunkText(title: string | null, headingPath: string | null, content: string): string {
  return `${title ?? ""} ${headingPath ?? ""} ${content}`;
}

/**
 * The `SET` list writing a document's title vector, and its text's unless `text` is null. The row's
 * format is kept only when it is the one written: under another, its other vectors are older and the
 * background pass writes them all again.
 */
export function docVectorsSet(
  sql: Queryable,
  input: { title: string; text: string | null; languages: readonly SearchLanguage[]; whole: boolean },
): Fragment {
  const configs = searchConfigs(input.languages);
  const format = searchFormat(input.languages);
  const title = vectorTerms(input.title, configs.length);
  const titleSet = sql`title_tsv = ${textVectorSql(sql, title, configs, true)}, title_dl = ${title.length}`;
  const formatSet = input.whole
    ? sql`search_format = ${format}`
    : sql`search_format = CASE WHEN search_format = ${format} THEN search_format END`;
  if (input.text === null) return sql`${titleSet}, ${formatSet}`;
  const text = vectorTerms(input.text, configs.length);
  return sql`${titleSet}, search_tsv = ${textVectorSql(sql, text, configs, true)}, search_dl = ${text.length}, ${formatSet}`;
}

/**
 * Write the vectors that read a document's title after a rename, its own and its opening passage's,
 * with the docs row already locked by the rename. The passage is read after that lock, so it is the
 * one an index job that held the lock first wrote.
 */
export async function writeTitleVectors(
  tx: Queryable,
  docId: string,
  title: string,
  languages: readonly SearchLanguage[],
): Promise<void> {
  await tx`UPDATE docs SET ${docVectorsSet(tx, { title, text: null, languages, whole: false })} WHERE doc_id = ${docId}`;
  const [first] = await tx<{ content: string; heading_path: string | null }[]>`
    SELECT content, heading_path FROM doc_chunks WHERE doc_id = ${docId} AND chunk_index = 0`;
  if (!first) return;
  const configs = searchConfigs(languages);
  const terms = vectorTerms(chunkText(title, first.heading_path, first.content), configs.length);
  await tx`
    UPDATE doc_chunks SET tsv = ${textVectorSql(tx, terms, configs, false)}, dl = ${terms.length}
    WHERE doc_id = ${docId} AND chunk_index = 0`;
}

/** Documents whose vectors were written in another format than `languages`' (or never), a page at a time after `after`. */
export async function listDocsToReindex(
  sql: Queryable,
  languages: readonly SearchLanguage[],
  limit: number,
  after: string | null = null,
): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM docs
    WHERE search_format IS DISTINCT FROM ${searchFormat(languages)}
      AND (${after}::text IS NULL OR doc_id > ${after})
    ORDER BY doc_id
    LIMIT ${limit}`;
  return rows.map((r) => r.doc_id);
}

/**
 * Write a document's vectors and its passages' again from the text they hold, under `languages`. The
 * row is locked first, as every write of it does, and one already in that format is left alone.
 * Nothing else moves: not `updated_at`, nor the text.
 */
export async function reindexDocVectors(sql: Sql, docId: string, languages: readonly SearchLanguage[]): Promise<void> {
  const format = searchFormat(languages);
  const configs = searchConfigs(languages);
  await sql.begin(async (tx) => {
    const [doc] = await tx<{ title: string; search_text: string; search_format: string | null }[]>`
      SELECT title, search_text, search_format FROM docs WHERE doc_id = ${docId} FOR UPDATE`;
    if (!doc || doc.search_format === format) return;
    await tx`UPDATE docs SET ${docVectorsSet(tx, { title: doc.title, text: doc.search_text, languages, whole: true })} WHERE doc_id = ${docId}`;
    const chunks = await tx<{ chunk_index: number; content: string; heading_path: string | null }[]>`
      SELECT chunk_index, content, heading_path FROM doc_chunks WHERE doc_id = ${docId} ORDER BY chunk_index`;
    if (chunks.length === 0) return;
    const terms = chunks.map((c) => vectorTerms(chunkText(c.chunk_index === 0 ? doc.title : null, c.heading_path, c.content), configs.length));
    await tx`
      UPDATE doc_chunks c SET tsv = ${vectorSql(tx, tx`t.latin::jsonb`, tx`t.cjk::jsonb`, configs, false)}, dl = t.dl
      FROM unnest(${chunks.map((c) => c.chunk_index)}::int[], ${terms.map((t) => JSON.stringify(t.latin))}::text[],
                  ${terms.map((t) => JSON.stringify(t.cjk))}::text[], ${terms.map((t) => t.length)}::int[]) AS t(chunk_index, latin, cjk, dl)
      WHERE c.doc_id = ${docId} AND c.chunk_index = t.chunk_index`;
  });
}
