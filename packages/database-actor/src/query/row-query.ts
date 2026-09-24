/**
 * Row listings and saved views: filter trees, sort keys and grouping,
 * normalized to column_ids (a stored view must survive a rename) and turned
 * into SQL against today's physical names. Values always bind; only
 * identifiers reach the SQL text, through ident() or the bookkeeping allowlist.
 */
import { filterGroupParts, filterOpNeedsValue, filterTreeStats, isFilterGroup } from "@stuga/protocol/databases/filters";
import {
  DATABASE_FILTER_MAX_DEPTH,
  DATABASE_FILTER_MAX_LEAVES,
  DATABASE_MAX_DISPLAY_LENGTH,
  DATABASE_MAX_GROUPS,
  DATABASE_MAX_SORTS,
  DATABASE_ROWS_PAGE_MAX,
} from "@stuga/protocol/databases/limits";
import {
  DATABASE_VIEW_KINDS,
  ROW_FILTER_OPS,
  type ColumnSpec,
  type DatabaseViewKind,
  type RowFilter,
  type RowFilterNode,
  type RowFilterOp,
  type RowGroup,
  type RowSort,
  type RowValue,
  type ViewInput,
} from "@stuga/protocol/databases/types";
import { OpError, type Body } from "../request.js";
import { getColumns, getView, ident, resolveColRef, type SqlHandle, type TableMeta } from "../schema-ops.js";

/** Bookkeeping columns every user table has. The sanitizer never produces a leading underscore, so user columns cannot collide. */
const BOOKKEEPING: ReadonlySet<string> = new Set(["_id", "_created_at", "_updated_at", "_doc_id"]);

/**
 * A row's page as one expression. A correlated subquery rather than a JOIN:
 * `_row_docs` has column names a user table may also have (`doc_id`), and a
 * join would make every unqualified filter on such a column ambiguous.
 */
const DOC_ID_EXPR = `(SELECT d.doc_id FROM _row_docs d WHERE d.row_id = "_id")`;

function colExpr(name: string): string {
  if (name === "_doc_id") return DOC_ID_EXPR;
  return BOOKKEEPING.has(name) ? `"${name}"` : ident(name);
}

function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const FILTER_OPS: ReadonlySet<string> = new Set(ROW_FILTER_OPS);

/**
 * A column as a listing or view names it: a user column (any spelling
 * resolveColRef accepts) or a bookkeeping column. `key` is what a normalized
 * shape stores: the column_id, or the bookkeeping name.
 */
function resolveQueryColumn(columns: ColumnSpec[], ref: unknown, field: string): { key: string; spec: ColumnSpec | null } {
  if (typeof ref !== "string" || ref === "") throw new OpError(400, "validation", `${field} must be a non-empty string`);
  if (BOOKKEEPING.has(ref)) return { key: ref, spec: null };
  const spec = resolveColRef(columns, ref);
  return { key: spec.column_id, spec };
}

/** Today's SQL for a normalized key; a vanished column_id is a conflict. */
function keyExpr(columns: ColumnSpec[], key: string): string {
  if (BOOKKEEPING.has(key)) return colExpr(key);
  const spec = columns.find((c) => c.column_id === key);
  if (!spec) throw new OpError(409, "conflict", `this filter or sort refers to a column that no longer exists`);
  return colExpr(spec.name);
}

// ---- sorts ------------------------------------------------------------------------------

/** One `{column_id, dir}` or an array of them; each column at most once. */
function normalizeSorts(columns: ColumnSpec[], raw: unknown): RowSort[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > DATABASE_MAX_SORTS) throw new OpError(400, "validation", `at most ${DATABASE_MAX_SORTS} sort keys`);
  const seen = new Set<string>();
  return list.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new OpError(400, "validation", "sort must be an object");
    const sort = item as { column_id?: unknown; dir?: unknown };
    const { key } = resolveQueryColumn(columns, sort.column_id, `sorts[${i}].column_id`);
    const dir = sort.dir === "desc" ? "desc" : sort.dir === "asc" || sort.dir === undefined ? "asc" : null;
    if (dir === null) throw new OpError(400, "validation", `sort.dir must be "asc" or "desc"`);
    if (seen.has(key)) throw new OpError(400, "validation", "a column may appear once in the sort order");
    seen.add(key);
    return { column_id: key, dir };
  });
}

// ---- filters ----------------------------------------------------------------------------

/**
 * Refs become column_ids and comparison values against number/checkbox columns
 * become numbers: SQLite orders TEXT above every number, so a bound "100" would
 * match nothing. Size is bounded before any column resolves.
 */
function normalizeFilter(columns: ColumnSpec[], raw: unknown): RowFilterNode {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new OpError(400, "validation", "filter must be an object");
  const stats = filterTreeStats(raw as RowFilterNode);
  if (stats.leaves.length === 0) throw new OpError(400, "validation", "filter must hold at least one condition");
  if (stats.leaves.length > DATABASE_FILTER_MAX_LEAVES) {
    throw new OpError(400, "validation", `a filter may hold at most ${DATABASE_FILTER_MAX_LEAVES} conditions`);
  }
  if (stats.depth > DATABASE_FILTER_MAX_DEPTH) throw new OpError(400, "validation", `filter groups nest at most ${DATABASE_FILTER_MAX_DEPTH} deep`);
  return normalizeNode(columns, raw as Body);
}

function normalizeNode(columns: ColumnSpec[], node: Body): RowFilterNode {
  if ("and" in node || "or" in node) {
    const key = "and" in node ? "and" : "or";
    const children = node[key];
    if (!Array.isArray(children)) throw new OpError(400, "validation", `filter.${key} must be an array`);
    const out = children.map((c) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) throw new OpError(400, "validation", "each filter condition must be an object");
      return normalizeNode(columns, c as Body);
    });
    return key === "and" ? { and: out } : { or: out };
  }
  return normalizeLeaf(columns, node);
}

function normalizeLeaf(columns: ColumnSpec[], leaf: Body): RowFilter {
  const { key, spec } = resolveQueryColumn(columns, leaf.column_id, "filter.column_id");
  const op = leaf.op;
  if (typeof op !== "string" || !FILTER_OPS.has(op)) {
    throw new OpError(400, "validation", `filter.op must be one of ${[...FILTER_OPS].join(", ")}`);
  }
  if (!filterOpNeedsValue(op as RowFilterOp)) return { column_id: key, op: op as RowFilterOp };
  let value = leaf.value;
  if (typeof value === "boolean") value = value ? 1 : 0;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new OpError(400, "validation", `filter.op "${op}" needs a string or number value`);
  }
  const textual = op === "contains" || op === "not_contains";
  if (!textual && spec !== null && (spec.type === "number" || spec.type === "checkbox") && typeof value === "string") {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new OpError(400, "validation", `column "${spec.display}" is ${spec.type}; filter value "${value}" is not a number`);
    }
    value = n;
  }
  return { column_id: key, op: op as RowFilterOp, value: value as RowValue };
}

function filterSql(columns: ColumnSpec[], node: RowFilterNode): { where: string; params: unknown[] } {
  if (isFilterGroup(node)) {
    const { op, children: kids } = filterGroupParts(node);
    const children = kids.map((c) => filterSql(columns, c));
    if (children.length === 0) return { where: op === "and" ? "1" : "0", params: [] };
    return {
      where: `(${children.map((c) => c.where).join(op === "and" ? " AND " : " OR ")})`,
      params: children.flatMap((c) => c.params),
    };
  }
  const q = keyExpr(columns, node.column_id);
  switch (node.op) {
    case "empty":
      return { where: `${q} IS NULL`, params: [] };
    case "not_empty":
      return { where: `${q} IS NOT NULL`, params: [] };
    case "contains":
      return { where: `${q} LIKE '%' || ? || '%' ESCAPE '\\'`, params: [escapeLike(String(node.value))] };
    case "not_contains":
      // An empty cell contains nothing, so it counts as not containing.
      return { where: `(${q} IS NULL OR ${q} NOT LIKE '%' || ? || '%' ESCAPE '\\')`, params: [escapeLike(String(node.value))] };
    case "eq":
      return { where: `${q} = ?`, params: [node.value] };
    case "ne":
      return { where: `(${q} IS NULL OR ${q} <> ?)`, params: [node.value] };
    case "gt":
      return { where: `${q} > ?`, params: [node.value] };
    case "gte":
      return { where: `${q} >= ?`, params: [node.value] };
    case "lt":
      return { where: `${q} < ?`, params: [node.value] };
    case "lte":
      return { where: `${q} <= ?`, params: [node.value] };
  }
}

/** ORDER BY for normalized sorts, led by the group key and ending on rowid so pages are stable. */
function orderSql(columns: ColumnSpec[], sorts: RowSort[], groupBy: string | null): string {
  const keys: string[] = [];
  if (groupBy !== null) keys.push(`${keyExpr(columns, groupBy)} ASC`);
  for (const s of sorts) {
    if (s.column_id === groupBy) continue;
    keys.push(`${keyExpr(columns, s.column_id)} ${s.dir === "desc" ? "DESC" : "ASC"}`);
  }
  // Insertion order; rowid breaks ties between rows inserted in the same millisecond.
  if (keys.length === 0) keys.push(`"_created_at" ASC`);
  keys.push("rowid ASC");
  return keys.join(", ");
}

// ---- listings -----------------------------------------------------------------------------

/** A stored row as a listing returns it: bookkeeping fields, and user cells keyed by column_id. */
export type ListedRow = Record<string, unknown> & { _id: string };

export interface RowPage {
  rows: ListedRow[];
  total: number;
  groups?: RowGroup[];
  groups_truncated?: true;
  group_by?: string;
}

/**
 * One page of a table. `sort`, `filter` and `group_by` shape it; `view_id`
 * seeds all three from a saved view, and any of them named in the body wins. A
 * grouped page orders by the group key first and counts every group over the
 * whole filtered set.
 */
export function listRowPage(sql: SqlHandle, meta: TableMeta, body: Body): { page: RowPage; offset: number } {
  const columns = getColumns(sql, meta.table_id);
  const rawLimit = body.limit === undefined ? DATABASE_ROWS_PAGE_MAX : Number(body.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) throw new OpError(400, "validation", "limit must be a positive integer");
  const limit = Math.min(rawLimit, DATABASE_ROWS_PAGE_MAX);
  const offset = body.offset === undefined ? 0 : Number(body.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new OpError(400, "validation", "offset must be a non-negative integer");

  const view = body.view_id === undefined || body.view_id === null ? null : getView(sql, meta.table_id, body.view_id);
  const sorts = body.sort !== undefined && body.sort !== null ? normalizeSorts(columns, body.sort) : (view?.sorts ?? []);
  const filter = body.filter !== undefined ? (body.filter === null ? null : normalizeFilter(columns, body.filter)) : (view?.filter ?? null);
  const groupBy =
    body.group_by !== undefined
      ? body.group_by === null
        ? null
        : resolveQueryColumn(columns, body.group_by, "group_by").key
      : (view?.group_by ?? null);

  const built = filter === null ? { where: "", params: [] as unknown[] } : filterSql(columns, filter);
  const whereSql = built.where === "" ? "" : ` WHERE ${built.where}`;
  const t = ident(meta.name);
  const stored = sql
    .exec(`SELECT *, ${DOC_ID_EXPR} AS "_doc_id" FROM ${t}${whereSql} ORDER BY ${orderSql(columns, sorts, groupBy)} LIMIT ? OFFSET ?`, ...built.params, limit, offset)
    .toArray();
  const rows = stored.map((row) => {
    const out: ListedRow = { _id: String(row._id), _created_at: row._created_at, _updated_at: row._updated_at, _doc_id: row._doc_id ?? null };
    for (const c of columns) out[c.column_id] = row[c.name] ?? null;
    return out;
  });
  const total = Number(sql.exec(`SELECT COUNT(*) AS n FROM ${t}${whereSql}`, ...built.params).one().n);

  const page: RowPage = { rows, total };
  if (groupBy !== null) {
    const g = keyExpr(columns, groupBy);
    const found = sql
      .exec(`SELECT ${g} AS value, COUNT(*) AS count FROM ${t}${whereSql} GROUP BY ${g} ORDER BY ${g} ASC LIMIT ?`, ...built.params, DATABASE_MAX_GROUPS + 1)
      .toArray();
    page.groups = found.slice(0, DATABASE_MAX_GROUPS).map((r) => ({ value: (r.value ?? null) as RowValue, count: Number(r.count) }));
    if (found.length > DATABASE_MAX_GROUPS) page.groups_truncated = true;
    page.group_by = groupBy;
  }
  return { page, offset };
}

// ---- views ----------------------------------------------------------------------------------

/** Bytes of opaque `config` a view may carry. */
const VIEW_CONFIG_MAX_BYTES = 16 * 1024;

/**
 * Validate the settable fields of a view. Only fields present in `raw` come
 * back, so create fills defaults and update merges. Column refs become column_ids.
 */
export function normalizeViewInput(columns: ColumnSpec[], raw: Body): ViewInput {
  const out: ViewInput = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") throw new OpError(400, "validation", "name must not be empty");
    if (raw.name.trim().length > DATABASE_MAX_DISPLAY_LENGTH) throw new OpError(400, "validation", `name too long (max ${DATABASE_MAX_DISPLAY_LENGTH} chars)`);
    out.name = raw.name.trim();
  }
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string" || !(DATABASE_VIEW_KINDS as readonly string[]).includes(raw.kind)) {
      throw new OpError(400, "validation", `kind must be one of ${DATABASE_VIEW_KINDS.join(", ")}`);
    }
    out.kind = raw.kind as DatabaseViewKind;
  }
  if (raw.position !== undefined) {
    if (!Number.isInteger(raw.position) || (raw.position as number) < 0) throw new OpError(400, "validation", "position must be a non-negative integer");
    out.position = raw.position as number;
  }
  if (raw.filter !== undefined) out.filter = raw.filter === null ? null : normalizeFilter(columns, raw.filter);
  if (raw.sorts !== undefined) {
    if (raw.sorts !== null && !Array.isArray(raw.sorts)) throw new OpError(400, "validation", "sorts must be an array");
    out.sorts = normalizeSorts(columns, raw.sorts);
  }
  if (raw.group_by !== undefined) {
    out.group_by = raw.group_by === null ? null : resolveQueryColumn(columns, raw.group_by, "group_by").key;
  }
  if (raw.hidden_columns !== undefined) {
    if (raw.hidden_columns !== null && !Array.isArray(raw.hidden_columns)) throw new OpError(400, "validation", "hidden_columns must be an array");
    const seen = new Set<string>();
    for (const ref of (raw.hidden_columns ?? []) as unknown[]) {
      const { key, spec } = resolveQueryColumn(columns, ref, "hidden_columns[]");
      if (spec === null) throw new OpError(400, "validation", "only user columns can be hidden");
      seen.add(key);
    }
    out.hidden_columns = [...seen];
  }
  if (raw.config !== undefined) {
    if (raw.config === null || typeof raw.config !== "object" || Array.isArray(raw.config)) throw new OpError(400, "validation", "config must be an object");
    const json = JSON.stringify(raw.config);
    if (new TextEncoder().encode(json).length > VIEW_CONFIG_MAX_BYTES) throw new OpError(400, "validation", "config is too large");
    out.config = JSON.parse(json) as Record<string, unknown>;
  }
  return out;
}

type ViewColumns = Pick<ViewInput, "filter" | "sorts" | "group_by" | "hidden_columns">;

/** Every user column_id a normalized view shape refers to. */
export function viewColumnRefs(shape: ViewColumns): string[] {
  const refs = new Set<string>();
  if (shape.filter) for (const leaf of filterTreeStats(shape.filter).leaves) refs.add(leaf.column_id);
  for (const s of shape.sorts ?? []) refs.add(s.column_id);
  if (shape.group_by) refs.add(shape.group_by);
  for (const c of shape.hidden_columns ?? []) refs.add(c);
  return [...refs].filter((r) => !BOOKKEEPING.has(r));
}

/** A stored view's reference is kept when it is bookkeeping or `live` holds it. */
export function isLiveViewRef(live: ReadonlySet<string>, columnId: string): boolean {
  return BOOKKEEPING.has(columnId) || live.has(columnId);
}

/** One line describing a view shape, for proposal summaries. */
export function describeViewShape(shape: ViewColumns): string {
  const parts: string[] = [];
  if (shape.filter !== undefined) parts.push(shape.filter === null ? "no filter" : `${filterTreeStats(shape.filter).leaves.length} condition(s)`);
  if (shape.sorts !== undefined) parts.push(shape.sorts.length === 0 ? "no sort" : `${shape.sorts.length} sort key(s)`);
  if (shape.group_by !== undefined) parts.push(shape.group_by === null ? "ungrouped" : "grouped");
  if (shape.hidden_columns !== undefined) parts.push(`${shape.hidden_columns.length} hidden column(s)`);
  return parts.join(", ");
}
