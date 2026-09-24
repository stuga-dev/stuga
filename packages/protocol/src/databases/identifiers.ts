/**
 * Physical SQLite table/column names are the only strings interpolated into SQL;
 * values are always bound. Names are validated, never escaped: `isSafeIdentifier`
 * is asserted at every interpolation site.
 */

/** Lowercase snake_case, letter-initial (so never a `_meta`-style table), ≤40 chars. */
const IDENT_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function isSafeIdentifier(s: string): boolean {
  return IDENT_RE.test(s) && !s.startsWith("sqlite_") && !SQLITE_RESERVED.has(s);
}

/** Derive a safe physical name from a display name. Total; collisions are `uniquifyIdentifier`'s job. */
export function sanitizeIdentifier(display: string): string {
  const base = display
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    // Room within 40 chars for a c_ prefix, an _x suffix and a _NN uniquify suffix.
    .slice(0, 34)
    .replace(/_+$/, "");
  const body = /^[a-z]/.test(base) ? base : base ? `c_${base}` : "c";
  // Break the sqlite_ prefix rather than suffixing: isSafeIdentifier rejects the prefix.
  const deprefixed = body.startsWith("sqlite_") ? `c_${body}` : body;
  return SQLITE_RESERVED.has(deprefixed) ? `${deprefixed}_x` : deprefixed;
}

/** tasks, tasks_2, tasks_3, … against the set of names already taken. */
export function uniquifyIdentifier(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** SQLite keywords (https://sqlite.org/lang_keywords.html); the sanitizer suffixes them (`select` → `select_x`). */
const SQLITE_RESERVED: ReadonlySet<string> = new Set([
  "abort", "action", "add", "after", "all", "alter", "always", "analyze", "and",
  "as", "asc", "attach", "autoincrement", "before", "begin", "between", "by",
  "cascade", "case", "cast", "check", "collate", "column", "commit", "conflict",
  "constraint", "create", "cross", "current", "current_date", "current_time",
  "current_timestamp", "database", "default", "deferrable", "deferred", "delete",
  "desc", "detach", "distinct", "do", "drop", "each", "else", "end", "escape",
  "except", "exclude", "exclusive", "exists", "explain", "fail", "filter",
  "first", "following", "for", "foreign", "from", "full", "generated", "glob",
  "group", "groups", "having", "if", "ignore", "immediate", "in", "index",
  "indexed", "initially", "inner", "insert", "instead", "intersect", "into",
  "is", "isnull", "join", "key", "last", "left", "like", "limit", "match",
  "materialized", "natural", "no", "not", "nothing", "notnull", "null", "nulls",
  "of", "offset", "on", "or", "order", "others", "outer", "over", "partition",
  "plan", "pragma", "preceding", "primary", "query", "raise", "range",
  "recursive", "references", "regexp", "reindex", "release", "rename", "replace",
  "restrict", "returning", "right", "rollback", "row", "rowid", "rows",
  "savepoint", "select", "set", "table", "temp", "temporary", "then", "ties",
  "to", "transaction", "trigger", "unbounded", "union", "unique", "update",
  "using", "vacuum", "values", "view", "virtual", "when", "where", "window",
  "with", "without",
]);
