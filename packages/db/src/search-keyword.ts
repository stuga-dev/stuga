/**
 * The keyword legs of search, ranked by BM25 in SQL over the vectors search-vectors.ts writes: k1 1.2,
 * b 0.75, and Lucene's IDF ln(1 + (N − n + 0.5)/(n + 0.5)). A term's document frequency n is counted
 * per query over the rows the searcher may see that hold it, from the GIN indexes and the rows' gates
 * alone; N and the average length are taken over every row they may see, field by field, counting
 * rows that have the field. A row they may not see never weighs a word. Only a row that matches has
 * its vector read, for the term frequencies: the positions its lexemes hold. A score is never
 * returned to the caller.
 *
 * A word is a term found by any of its stems (English and each search language); a word some
 * configuration drops as a stopword neither narrows a match nor ranks one, so `the roadmap` finds
 * "Roadmap" and `la maison`, with French chosen, finds "une maison". A query of stopwords alone finds
 * titles holding every word as written. CJK and Thai terms are found as written (search-text.ts).
 */
import type { Fragment } from "postgres";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { queryShape, queryTerms } from "./search-text.js";
import { searchConfigs } from "./search-vectors.js";
import type { Queryable } from "./sql.js";

export const K1 = 1.2;
export const B = 0.75;

/** A document's title counts this many times its text. */
const TITLE_WEIGHT = 2;

/**
 * Below any real BM25 score, which over N visible rows is at least ln(1 + 0.5/(N + 0.5)). A title the
 * unfinished last word begins outranks a body it begins, and a typo (scored zero) ranks below both.
 */
const TITLE_PREFIX_SCORE = 0.000002;
const BODY_PREFIX_SCORE = 0.000001;

/** Scripts written without spaces between words, where a typed word is no token's prefix. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * The query's last word, lowercased as the index stores it, when it may be a word
 * still being typed: letters and digits only, in a script that spaces its words,
 * and long enough to narrow (three characters, or two Hangul syllables). Null otherwise.
 */
export function completionPrefix(query: string): { head: string; prefix: string } | null {
  const words = query.trim().split(/\s+/);
  const last = words.pop() ?? "";
  if (!/^[\p{L}\p{M}\p{N}]+$/u.test(last) || UNSPACED.test(last)) return null;
  if ([...last].length < (/\p{Script=Hangul}/u.test(last) ? 2 : 3)) return null;
  return { head: words.join(" "), prefix: last.toLowerCase() };
}

/** Characters a word needs before a title may differ from it by one edit and still match. */
const TYPO_MIN_CHARS = 4;

/**
 * Whether a one-letter typo may recall a title: every word of the query is at least
 * TYPO_MIN_CHARS long, and none is in a script written without spaces. One edit away
 * from a short word, or from one Chinese character, is any title holding a short token
 * ("3", "C", 会), so such a query would list the same unrelated documents every time.
 */
export function typoTolerant(query: string): boolean {
  if (UNSPACED.test(query)) return false;
  const words = query.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => [...w].length >= TYPO_MIN_CHARS);
}

/** Whether `a` becomes `b` by at most one insertion, deletion, substitution or swap of neighbours. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;
  const shorter = Math.min(x.length, y.length);
  let head = 0;
  while (head < shorter && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < shorter - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  if (x.length !== y.length) return head + tail >= shorter;
  if (head + tail === x.length - 1) return true;
  return head + tail === x.length - 2 && x[head] === y[head + 1] && x[head + 1] === y[head];
}

/** A lexeme as tsquery text reads it. */
function quoted(lexeme: string): string {
  return `'${lexeme.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/** What the keyword legs search by, worked out once per query. */
export interface KeywordPlan {
  /** Pairs of a term (from 1) and one of its lexemes: a term is held by holding any of them. */
  terms: number[];
  lexemes: string[];
  /** Pairs of a group and one of its terms: a group is held by holding any of its terms. */
  groups: number[];
  groupTerms: number[];
  /** Per pair, 1 when the group is one the finished words of an unfinished query make, else 0. */
  groupHeads: number[];
  groupCount: number;
  headCount: number;
  /** Each term's lexemes, OR-ed, as tsquery text, in term order (the first is term 1); none when the query has no term. */
  queries: string[];
  /** A query of stopwords alone, matched in titles only. */
  titleOnly: boolean;
  /** The unfinished last word as a tsquery prefix, or null. */
  prefix: string | null;
  /** The words a title may hold one typo away, or null when typoTolerant says no. */
  typoWords: string[] | null;
  /** The words' stems, whose positions in a body mark its excerpt. */
  marks: string[];
  /** The CJK and Thai terms an excerpt marks: pairs, and characters searched alone. */
  cjkMarks: string[];
  /** The unfinished last word as the index spells it, for its excerpt. */
  completion: string | null;
}

/**
 * Work out a query's terms: each word's stems under the node's configurations, read from Postgres in
 * one round trip, and the CJK terms and groups of `queryShape`.
 */
export async function planKeywords(sql: Queryable, query: string, languages: readonly SearchLanguage[]): Promise<KeywordPlan> {
  const shape = queryShape(query);
  const configs = searchConfigs(languages);
  // Each word under every configuration, then as written ('simple', last).
  const rows = shape.latin.length === 0 ? [] : await sql<{ i: number; k: number; lexeme: string }[]>`
    SELECT w.i::int AS i, c.k::int AS k, s.lexeme
    FROM unnest(${shape.latin}::text[]) WITH ORDINALITY AS w(word, i)
    CROSS JOIN unnest(${[...configs, "simple"]}::regconfig[]) WITH ORDINALITY AS c(cfg, k)
    CROSS JOIN LATERAL unnest(to_tsvector(c.cfg, w.word)) AS s`;
  const stems = shape.latin.map(() => new Set<string>());
  const stemmedBy = shape.latin.map(() => new Set<number>());
  const written = shape.latin.map(() => new Set<string>());
  for (const r of rows) {
    if (r.k <= configs.length) {
      stems[r.i - 1]!.add(r.lexeme);
      stemmedBy[r.i - 1]!.add(r.k);
    } else {
      written[r.i - 1]!.add(r.lexeme);
    }
  }

  const completion = completionPrefix(query);
  const prefixWord = completion ? queryTerms(completion.prefix).latin : [];
  const headWords = new Set(completion ? queryTerms(completion.head).latin : []);

  const plan: KeywordPlan = {
    terms: [],
    lexemes: [],
    groups: [],
    groupTerms: [],
    groupHeads: [],
    groupCount: 0,
    headCount: 0,
    queries: [],
    titleOnly: false,
    prefix: prefixWord.length === 1 ? `${quoted(prefixWord[0]!)}:*` : null,
    typoWords: typoTolerant(query) && shape.latin.length > 0 && shape.cjk.length === 0 ? shape.latin : null,
    marks: [],
    cjkMarks: [],
    completion: prefixWord.length === 1 ? prefixWord[0]! : null,
  };
  let terms = 0;
  const addTerm = (lexemes: Iterable<string>): number => {
    const term = ++terms;
    for (const lexeme of lexemes) {
      plan.terms.push(term);
      plan.lexemes.push(lexeme);
    }
    return term;
  };
  const addGroup = (terms: number[], head: boolean) => {
    const group = ++plan.groupCount;
    if (head) plan.headCount++;
    for (const term of terms) {
      plan.groups.push(group);
      plan.groupTerms.push(term);
      plan.groupHeads.push(head ? 1 : 0);
    }
  };

  shape.latin.forEach((word, i) => {
    if (stemmedBy[i]!.size < configs.length || stems[i]!.size === 0) return;
    addGroup([addTerm(stems[i]!)], headWords.has(word));
    plan.marks.push(...stems[i]!);
  });
  const cjkTerms = shape.cjk.map((term) => addTerm([term]));
  for (const group of shape.cjkGroups) addGroup(group.map((k) => cjkTerms[k]!), true);
  plan.cjkMarks = [...new Set(shape.cjkGroups.flat().map((k) => shape.cjk[k]!))];

  if (plan.terms.length === 0 && shape.latin.length > 0) {
    plan.titleOnly = true;
    shape.latin.forEach((word, i) => {
      if (written[i]!.size > 0) addGroup([addTerm(written[i]!)], headWords.has(word));
    });
  }
  for (let term = 1; term <= terms; term++) {
    plan.queries.push(plan.lexemes.filter((_, k) => plan.terms[k] === term).map(quoted).join(" | "));
  }
  return plan;
}

/** BM25 of one field's hit, from its columns `tf`, `dl`, `df`, the field's `n` and `avg`. */
function bm25(sql: Queryable): Fragment {
  return sql`ln(1 + (n - df + 0.5) / (df + 0.5)) * tf * ${K1 + 1}::float8 / (tf + ${K1}::float8 * (${1 - B}::float8 + ${B}::float8 * dl / avg))`;
}

/** The plan's terms, `kw_lex(term, lexeme)`, and each term's query, `kw_query(term, tq)`. */
function termCtes(sql: Queryable, plan: KeywordPlan): Fragment {
  return sql`
    kw_lex AS (
      SELECT * FROM unnest(${plan.terms}::int[], ${plan.lexemes}::text[]) AS l(term, lexeme)
    ),
    kw_query AS (
      SELECT * FROM unnest(${plan.queries.map((_, k) => k + 1)}::int[], ${plan.queries}::tsquery[]) AS q(term, tq)
    )`;
}

/**
 * Document-level candidates `kw_candidates(doc_id, kw_rank, kw_whole)`, as CTEs after `q`. `visible`
 * gates `docs d` (tenant, trash, hidden, ACL and scope), inside every scan, ahead of any LIMIT. A
 * document must hold every group, in its title or its text (`kw_whole`), unless `anyWord`, when one
 * holding any group is a candidate too, ranked by the BM25 of the terms it holds, so one holding more
 * of them, or rarer ones, ranks first; it scores its title's BM25 TITLE_WEIGHT times beside its
 * text's. A title one typo away (`typoIds`) is a candidate scored zero, so it is found but never
 * outranks a match; a title or body the unfinished last word begins is one scored just above zero,
 * holding the finished words as a whole query must.
 */
export function keywordCtes(
  sql: Queryable,
  plan: KeywordPlan,
  visible: Fragment,
  candidates: number,
  typoIds: string[],
  anyWord = false,
): Fragment {
  const none = sql`SELECT NULL::text AS doc_id, 0::float8 AS s WHERE FALSE`;
  const field = (name: "title" | "search") => sql.unsafe(`${name}_tsv`);
  const holding = (name: "title" | "search") =>
    sql`SELECT q.term, ${name}::text AS field, d.doc_id FROM kw_query q JOIN docs d ON ${visible} AND d.${field(name)} @@ q.tq`;
  const prefixLeg = (name: "title" | "search", score: number) =>
    sql`SELECT d.doc_id, ${score}::float8 AS s FROM docs d WHERE ${visible} AND d.${field(name)} @@ ${plan.prefix}::tsquery`;
  const prefix =
    plan.prefix === null
      ? none
      : sql`SELECT x.doc_id, sum(x.s) AS s
            FROM (${prefixLeg("title", TITLE_PREFIX_SCORE)} UNION ALL ${prefixLeg("search", BODY_PREFIX_SCORE)}) x
            ${plan.headCount > 0 ? sql`WHERE x.doc_id IN (SELECT doc_id FROM kw_held WHERE head)` : sql``}
            GROUP BY x.doc_id`;
  const typo = typoIds.length === 0 ? none : sql`SELECT d.doc_id, 0::float8 AS s FROM docs d WHERE ${visible} AND d.doc_id = ANY(${typoIds})`;
  return sql`
    ${termCtes(sql, plan)},
    kw_need AS (
      SELECT * FROM unnest(${plan.groups}::int[], ${plan.groupTerms}::int[], ${plan.groupHeads}::int[]) AS g(grp, term, head)
    ),
    -- Each field's N and average length, over the visible documents that have it.
    kw_n AS MATERIALIZED (
      SELECT count(*) FILTER (WHERE d.title_dl > 0)::float8 AS title_n,
             coalesce(avg(d.title_dl) FILTER (WHERE d.title_dl > 0), 1)::float8 AS title_avg,
             count(*) FILTER (WHERE d.search_dl > 0)::float8 AS search_n,
             coalesce(avg(d.search_dl) FILTER (WHERE d.search_dl > 0), 1)::float8 AS search_avg
      FROM docs d
      WHERE ${plan.queries.length === 0 ? sql`FALSE` : visible}
    ),
    -- Every visible field holding a term, from the indexes: document frequencies, and who holds what.
    kw_hold AS MATERIALIZED (
      ${holding("title")}
      ${plan.titleOnly ? sql`` : sql`UNION ALL ${holding("search")}`}
    ),
    kw_df AS (
      SELECT term, field, count(*)::float8 AS df FROM kw_hold GROUP BY term, field
    ),
    -- Whether each document holds every group, and every group of the finished words.
    kw_held AS (
      SELECT h.doc_id,
             count(DISTINCT g.grp) = ${plan.groupCount} AS whole,
             count(DISTINCT g.grp) FILTER (WHERE g.head = 1) = ${plan.headCount} AS head
      FROM kw_hold h
      JOIN kw_need g ON g.term = h.term
      GROUP BY h.doc_id
    ),
    -- Term frequencies, read from the vectors of the matching documents' fields that hold a term.
    kw_tf AS MATERIALIZED (
      SELECT h.doc_id, h.field, max(CASE h.field WHEN 'title' THEN d.title_dl ELSE d.search_dl END) AS dl, l.term,
             greatest(count(DISTINCT p.p), 1)::float8 AS tf
      FROM (SELECT DISTINCT k.doc_id, k.field FROM kw_hold k JOIN kw_held w ON w.doc_id = k.doc_id AND (w.whole OR ${anyWord})) h
      JOIN docs d ON d.doc_id = h.doc_id
      CROSS JOIN LATERAL unnest(CASE h.field WHEN 'title' THEN d.title_tsv ELSE d.search_tsv END) AS u
      JOIN kw_lex l ON l.lexeme = u.lexeme
      LEFT JOIN LATERAL unnest(u.positions) AS p(p) ON TRUE
      GROUP BY h.doc_id, h.field, l.term
    ),
    kw_scored AS (
      SELECT t.doc_id, sum(t.weight * ${bm25(sql)}) AS s
      FROM (SELECT t.doc_id, t.tf, t.dl, f.df,
                   CASE t.field WHEN 'title' THEN ${TITLE_WEIGHT}::float8 ELSE 1::float8 END AS weight,
                   CASE t.field WHEN 'title' THEN n.title_n ELSE n.search_n END AS n,
                   CASE t.field WHEN 'title' THEN n.title_avg ELSE n.search_avg END AS avg
            FROM kw_tf t
            JOIN kw_df f ON f.term = t.term AND f.field = t.field
            CROSS JOIN kw_n n) t
      GROUP BY t.doc_id
    ),
    kw_prefix AS (${prefix}),
    kw_typo AS (${typo}),
    kw_candidates AS (
      SELECT x.doc_id, sum(x.s)::float8 AS kw_rank, coalesce(bool_or(w.whole), FALSE) AS kw_whole
      FROM (SELECT doc_id, s FROM kw_scored UNION ALL SELECT doc_id, s FROM kw_prefix UNION ALL SELECT doc_id, s FROM kw_typo) x
      LEFT JOIN kw_held w ON w.doc_id = x.doc_id
      GROUP BY x.doc_id
      ORDER BY kw_rank DESC, x.doc_id
      LIMIT ${candidates}
    )`;
}

/**
 * Passages whose term frequencies one query reads at most: those holding the rarest of its terms, by
 * the sum of their IDF. A question of common words (in Korean, 인가 or 수도) is held by thousands.
 */
const PASSAGES_SCORED = 1000;

/**
 * Passage-level candidates `kw_hits(doc_id, chunk_index, kw_rank)`, as CTEs. A passage matches on any
 * group, so a question in natural language finds a passage on any significant word; it is ranked by
 * every term it holds, a character of a longer CJK word too. The opening passage carries the title, so
 * a title-only match cites it. `visible` gates `docs d`, whose passages in `workspaceId` are searched.
 */
export function chunkKeywordCtes(sql: Queryable, plan: KeywordPlan, visible: Fragment, workspaceId: string, candidates: number): Fragment {
  if (plan.queries.length === 0 || plan.titleOnly) {
    return sql`kw_hits AS (SELECT NULL::text AS doc_id, 0 AS chunk_index, 0::float8 AS kw_rank WHERE FALSE)`;
  }
  return sql`
    ${termCtes(sql, plan)},
    -- The visible documents, once: every passage below is gated by joining them.
    kw_docs AS MATERIALIZED (
      SELECT d.doc_id FROM docs d WHERE ${visible}
    ),
    kw_n AS MATERIALIZED (
      SELECT count(*) FILTER (WHERE c.dl > 0)::float8 AS n, coalesce(avg(c.dl) FILTER (WHERE c.dl > 0), 1)::float8 AS avg
      FROM doc_chunks c JOIN kw_docs v ON v.doc_id = c.doc_id
      WHERE c.workspace_id = ${workspaceId}
    ),
    -- Every visible passage holding a term, from the index: document frequencies, and who holds what.
    kw_hold AS MATERIALIZED (
      SELECT q.term, c.doc_id, c.chunk_index
      FROM kw_query q
      JOIN doc_chunks c ON c.tsv @@ q.tq AND c.workspace_id = ${workspaceId}
      JOIN kw_docs v ON v.doc_id = c.doc_id
    ),
    kw_df AS (
      SELECT term, count(*)::float8 AS df FROM kw_hold GROUP BY term
    ),
    -- The passages holding a group's term whose frequencies are read: the rarest terms' first.
    kw_match AS (
      SELECT h.doc_id, h.chunk_index
      FROM kw_hold h JOIN kw_df f ON f.term = h.term CROSS JOIN kw_n n
      GROUP BY h.doc_id, h.chunk_index
      HAVING bool_or(h.term = ANY(${plan.groupTerms}::int[]))
      ORDER BY sum(ln(1 + (n.n - f.df + 0.5) / (f.df + 0.5))) DESC, h.doc_id, h.chunk_index
      LIMIT ${PASSAGES_SCORED}
    ),
    kw_tf AS MATERIALIZED (
      SELECT c.doc_id, c.chunk_index, c.dl, l.term, greatest(count(DISTINCT p.p), 1)::float8 AS tf
      FROM kw_match m
      JOIN doc_chunks c ON c.doc_id = m.doc_id AND c.chunk_index = m.chunk_index
      CROSS JOIN LATERAL unnest(c.tsv) AS u
      JOIN kw_lex l ON l.lexeme = u.lexeme
      LEFT JOIN LATERAL unnest(u.positions) AS p(p) ON TRUE
      GROUP BY c.doc_id, c.chunk_index, c.dl, l.term
    ),
    kw_hits AS (
      SELECT t.doc_id, t.chunk_index, sum(${bm25(sql)}) AS kw_rank
      FROM (SELECT t.*, f.df, n.n, n.avg FROM kw_tf t JOIN kw_df f ON f.term = t.term CROSS JOIN kw_n n) t
      GROUP BY t.doc_id, t.chunk_index
      ORDER BY kw_rank DESC, t.doc_id, t.chunk_index
      LIMIT ${candidates}
    )`;
}

/** Candidate titles a typo leg reads, the most alike first. */
const TYPO_CANDIDATES = 200;
/** How alike a title's trigrams must be to a word's: one edit to a four-letter word leaves 0.4. */
const TYPO_SIMILARITY = 0.3;

/**
 * The visible documents whose titles hold, for every word the plan allows a typo in, one within one
 * edit of it: titles alike by trigrams (pg_trgm's index), then checked here as the index spells them.
 * Runs in a transaction, whose similarity threshold it sets.
 */
export async function typoMatches(tx: Queryable, plan: KeywordPlan, visible: Fragment): Promise<string[]> {
  const words = plan.typoWords ?? [];
  if (words.length === 0) return [];
  await tx`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(TYPO_SIMILARITY)}, true)`;
  // A title holding every word as the query has it is a match of its own, and not spent from the candidates.
  let alike = plan.queries.length > 0 && !plan.titleOnly ? tx`AND NOT d.title_tsv @@ ${plan.queries.map((q) => `(${q})`).join(" & ")}::tsquery` : tx``;
  let likeness = tx`0`;
  for (const word of words) {
    alike = tx`${alike} AND d.title %> ${word}`;
    likeness = tx`${likeness} + word_similarity(${word}, d.title)`;
  }
  const rows = await tx<{ doc_id: string; title: string }[]>`
    SELECT d.doc_id, d.title FROM docs d
    WHERE ${visible} ${alike}
    ORDER BY ${likeness} DESC, d.doc_id
    LIMIT ${TYPO_CANDIDATES}`;
  return rows
    .filter((r) => {
      const title = queryTerms(r.title).latin;
      return words.every((w) => title.some((t) => withinOneEdit(w, t)));
    })
    .map((r) => r.doc_id);
}
