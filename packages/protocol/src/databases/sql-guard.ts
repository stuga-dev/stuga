/**
 * Static SELECT-only guard for agent SQL. After stripping comment and literal
 * bodies the statement is token-scanned for write/DDL verbs anywhere, since a
 * `WITH` prefix proves nothing. The actor also runs every agent query in a
 * transaction that is always rolled back.
 */
import { DATABASE_QUERY_MAX_BYTES } from "./limits.js";

/**
 * Blank out comment bodies and string/quoted-identifier bodies, keeping the
 * surrounding structure, so keywords inside literals pass and keywords split by
 * comments cannot hide. With `keepIdentifiers`, quoted identifier bodies are
 * kept (literals are still blanked). An unterminated construct blanks to the end.
 */
export function stripCommentsAndStrings(sql: string, keepIdentifiers = false): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1]! : "";
    if (c === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      // A doubled quote is an escaped quote.
      const quote = c;
      let inner = "";
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            inner += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        inner += sql[i];
        i++;
      }
      out += keepIdentifiers && quote !== "'" ? inner : `${quote}${quote}`;
    } else if (c === "[") {
      const start = i + 1;
      i++;
      while (i < n && sql[i] !== "]") i++;
      const inner = sql.slice(start, i);
      i = Math.min(i + 1, n);
      out += keepIdentifiers ? inner : '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Write/DDL verbs refused anywhere. `replace(...)` is a string function; only `REPLACE INTO` is a write. */
const BANNED_TOKEN_RE =
  /\b(insert|update|delete|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b|\breplace\s+into\b/i;

/**
 * Recursive CTEs are refused, bounded or not. The reader caps rows, bytes and
 * time between rows, but an unterminated recursion under an aggregate never
 * yields a row, and node:sqlite cannot interrupt a native step. Actors share
 * the node's event loop, so one such query hangs the whole process, and a
 * supervisor restarts a process that exits, not one that is wedged.
 *
 * Detection is structural: SQLite recurses whenever a CTE body names itself
 * (through identifier quoting too), with or without the RECURSIVE keyword.
 */
const RECURSIVE_CTE_RE = /\bwith\s+recursive\b/i;

const RECURSIVE_CTE_MESSAGE =
  "a recursive CTE is not allowed: a recursive query that never terminates cannot be stopped once it starts. Express the traversal with joins, or fetch the rows and walk them yourself";

/**
 * The CTE names a leading WITH clause defines, each with its body. Returns null
 * when the clause cannot be read confidently; the caller refuses it.
 */
function cteDefinitions(sql: string): Array<{ name: string; body: string }> | null {
  let i = 0;
  const skipSpace = () => {
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
  };
  /** Consume a balanced (...) group starting at `i`, or null if unbalanced. */
  const takeParenGroup = (): string | null => {
    if (sql[i] !== "(") return null;
    const start = i;
    let depth = 0;
    while (i < sql.length) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          return sql.slice(start, i);
        }
      }
      i++;
    }
    return null;
  };
  const eat = (re: RegExp): boolean => {
    const m = re.exec(sql.slice(i));
    if (!m) return false;
    i += m[0].length;
    return true;
  };

  skipSpace();
  if (!eat(/^with\b/i)) return null;
  skipSpace();
  eat(/^recursive\b/i);

  const defs: Array<{ name: string; body: string }> = [];
  for (;;) {
    skipSpace();
    const name = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (!name) return null;
    i += name[0].length;
    skipSpace();
    if (sql[i] === "(" && takeParenGroup() === null) return null; // optional column list
    skipSpace();
    if (!eat(/^as\b/i)) return null;
    skipSpace();
    eat(/^(not\s+)?materialized\b/i);
    skipSpace();
    const body = takeParenGroup();
    if (body === null) return null;
    defs.push({ name: name[0], body });
    skipSpace();
    if (sql[i] === ",") {
      i++;
      continue;
    }
    return defs;
  }
}

const NESTED_CTE_MESSAGE =
  "a WITH clause is only allowed at the start of the query: a nested one cannot be proven non-recursive, and a recursive query that never terminates cannot be stopped once it starts. Lift the CTE to the front, or express it with joins";

/**
 * Both arguments are the same query: `stripped` erases quoted identifiers (so
 * `SELECT "with" FROM t` is not a CTE), `withIdents` keeps them (so `FROM "c"`
 * is seen as a self-reference). A WITH anywhere but the front is refused, since
 * SQLite allows one at the head of any nested select.
 */
function recursiveCteViolation(stripped: string, withIdents: string): string | null {
  if (RECURSIVE_CTE_RE.test(stripped)) return RECURSIVE_CTE_MESSAGE;
  const leading = /^with\b/i.test(stripped);
  const firstWith = /\bwith\b/i.exec(stripped);
  if (firstWith && (!leading || /\bwith\b/i.test(stripped.slice(firstWith.index + 4)))) {
    return NESTED_CTE_MESSAGE;
  }
  if (!leading) return null;
  const defs = cteDefinitions(withIdents);
  if (defs === null) {
    return "this WITH clause could not be parsed well enough to prove it is not recursive — simplify it, or express the query without a CTE";
  }
  for (const { name, body } of defs) {
    if (new RegExp(`\\b${name.replace(/[$]/g, "\\$&")}\\b`, "i").test(body)) return RECURSIVE_CTE_MESSAGE;
  }
  return null;
}

/**
 * The `pragma_*` table-valued functions an agent may read. These describe the
 * tenant's own schema, so their cost is bounded by its data. Others (e.g.
 * pragma_function_list) have rows on an empty database, and a self-join of them
 * returns one row after billions. An allowlist, so functions added by a future
 * SQLite are refused.
 */
const PRAGMA_FN_ALLOWED = new Set([
  "pragma_table_info",
  "pragma_table_xinfo",
  "pragma_table_list",
  "pragma_index_list",
  "pragma_index_info",
  "pragma_index_xinfo",
  "pragma_foreign_key_list",
]);

const PRAGMA_FN_RE = /\bpragma_[a-z_]+/gi;

/**
 * `json_each`/`json_tree` over a string literal: rows come from the query text,
 * not stored data, so self-joins blow up like the pragma family. Over a column
 * they stay allowed. Matched on stripped text, where every literal is `''`.
 */
const JSON_TVF_LITERAL_RE = /\bjson_(?:each|tree)\s*\(\s*''/i;

/** A human-readable violation for an agent query, or null when it is acceptable. */
export function selectOnlyViolation(raw: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return "empty query";
  if (utf8Length(raw) > DATABASE_QUERY_MAX_BYTES) {
    return `query too long (max ${DATABASE_QUERY_MAX_BYTES} bytes)`;
  }
  const stripped = stripCommentsAndStrings(raw).trim().replace(/;\s*$/, "");
  if (stripped === "") return "empty query";
  if (stripped.includes(";")) return "one statement per query";
  if (!/^(select|with)\b/i.test(stripped)) return "only SELECT queries are allowed";
  const m = BANNED_TOKEN_RE.exec(stripped);
  if (m) return `disallowed keyword: ${(m[1] ?? "REPLACE INTO").toUpperCase()}`;
  for (const fn of stripped.match(PRAGMA_FN_RE) ?? []) {
    if (!PRAGMA_FN_ALLOWED.has(fn.toLowerCase())) {
      return `${fn}() is not available: only the table, index and foreign-key introspection pragmas can be queried`;
    }
  }
  if (JSON_TVF_LITERAL_RE.test(stripped)) {
    return "json_each() and json_tree() can only expand a column, not a literal: a literal list joined to itself costs nothing to write and cannot be stopped once it starts";
  }
  const recursive = recursiveCteViolation(stripped, stripCommentsAndStrings(raw, true).trim().replace(/;\s*$/, ""));
  if (recursive) return recursive;
  return null;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * How a table's values are stored, for any prompt that asks a model to write
 * SQL against one. Guessing these wrong is the quiet failure: a WHERE that
 * matches nothing reads as "no rows", not as an error.
 */
export const SQL_VALUE_CONVENTIONS =
  "Stored values: a date column is TEXT 'YYYY-MM-DD', so lexical order is chronological and date() works on it; a " +
  "checkbox is 0 or 1; a number may be integer or real; a single-select column holds exactly one of the values listed " +
  "for it, matched exactly, so copy them as given rather than guessing the wording or the case; every row also has " +
  "_id TEXT and _created_at / _updated_at in epoch milliseconds.";
