import { DATABASE_MAX_VIEWS } from "@stuga/protocol/databases/limits";
import type { DbRunOpViewsCreate, DbRunOpViewsUpdate, ViewInput, ViewSpec } from "@stuga/protocol/databases/types";
import { describeViewShape, normalizeViewInput, viewColumnRefs } from "../query/row-query.js";
import { OpError, conflict, type Body } from "../request.js";
import { deleteView, findView, getColumns, getTable, getView, insertView, listViews, newId, writeView, type SqlHandle } from "../schema-ops.js";
import type { OpDef } from "./registry.js";
import type { SchemaView } from "./schema-view.js";

/** `position` rides only a direct create. */
type ViewsCreate = DbRunOpViewsCreate & { position?: number };
type ViewsDelete = { kind: "views.delete"; table_id: string; view_id: string };

function viewCapError(tableDisplay: string, count: number): OpError {
  return new OpError(409, "view_cap", `table "${tableDisplay}" already has ${count} views (max ${DATABASE_MAX_VIEWS})`);
}

/** A view shape must still name live columns when it lands. */
function requireLiveColumns(sql: SqlHandle, tableId: string, shape: Parameters<typeof viewColumnRefs>[0]): void {
  const live = new Set(getColumns(sql, tableId).map((c) => c.column_id));
  if (viewColumnRefs(shape).some((ref) => !live.has(ref))) {
    throw conflict("a column this view refers to no longer exists — the schema changed after the change was made");
  }
}

/** A proposal carries the view kind as `view_kind`, since `kind` names the op. */
function viewFields(input: Body, view: SchemaView): Body {
  return view.proposal ? { ...input, kind: input.view_kind } : input;
}

export const viewsCreate: OpDef<ViewsCreate> = {
  parse(input, view) {
    const table = view.table(input);
    const shape = normalizeViewInput(table.columns, viewFields(input, view));
    if (shape.name === undefined) throw new OpError(400, "validation", "name is required");
    const count = table.viewCount();
    if (count >= DATABASE_MAX_VIEWS) throw viewCapError(table.display, count);
    const p: ViewsCreate = {
      kind: "views.create",
      table_id: table.table_id,
      view_id: newId("view_"),
      view: {
        kind: shape.kind ?? "table",
        name: shape.name,
        filter: shape.filter ?? null,
        sorts: shape.sorts ?? [],
        group_by: shape.group_by ?? null,
        hidden_columns: shape.hidden_columns ?? [],
        config: shape.config ?? {},
      },
    };
    if (!view.proposal && shape.position !== undefined) p.position = shape.position;
    return p;
  },
  capture: (_sql, p) => ({ kind: "views.create", table_id: p.table_id, view_id: p.view_id }),
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    if (findView(sql, p.view_id)) throw conflict("this view was already created");
    const count = listViews(sql, meta.table_id).length;
    if (count >= DATABASE_MAX_VIEWS) throw viewCapError(meta.display, count);
    requireLiveColumns(sql, meta.table_id, p.view);
    const view = insertView(sql, meta.table_id, { viewId: p.view_id, kind: p.view.kind, name: p.view.name, position: p.position, shape: p.view }, now);
    return { result: { view }, summary: `Created view "${p.view.name}" on "${meta.display}"` };
  },
  proposal: {
    describe: (p, view) => `Create view "${p.view.name}" on "${view.displayOf(p.table_id)}" (${describeViewShape(p.view)})`,
    minted: (p) => ({ view_id: p.view_id }),
    references: (p) => [p.table_id, ...viewColumnRefs(p.view)],
  },
};

function mergeView(cur: ViewSpec, changes: ViewInput): ViewSpec {
  return {
    ...cur,
    kind: changes.kind ?? cur.kind,
    name: changes.name ?? cur.name,
    position: changes.position ?? cur.position,
    filter: changes.filter !== undefined ? changes.filter : cur.filter,
    sorts: changes.sorts ?? cur.sorts,
    group_by: changes.group_by !== undefined ? changes.group_by : cur.group_by,
    hidden_columns: changes.hidden_columns ?? cur.hidden_columns,
    config: changes.config ?? cur.config,
  };
}

export const viewsUpdate: OpDef<DbRunOpViewsUpdate> = {
  parse(input, view) {
    const table = view.table(input);
    const target = table.view(input);
    const changes = normalizeViewInput(table.columns, viewFields(input, view));
    if (Object.keys(changes).length === 0) throw new OpError(400, "validation", "nothing to change");
    return { kind: "views.update", table_id: table.table_id, view_id: target.view_id, changes };
  },
  capture: (sql, p) => ({ kind: "views.update", table_id: p.table_id, view: getView(sql, p.table_id, p.view_id) }),
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    const cur = getView(sql, meta.table_id, p.view_id);
    requireLiveColumns(sql, meta.table_id, p.changes);
    const renamed = p.changes.name !== undefined && p.changes.name !== cur.name ? ` (renamed to "${p.changes.name}")` : "";
    return {
      result: { view: writeView(sql, mergeView(cur, p.changes), now) },
      summary: `Changed view "${cur.name}" on "${meta.display}"${renamed}`,
    };
  },
  proposal: {
    describe: (p, view) =>
      `Change view "${view.viewNameOf(p.table_id, p.view_id)}" on "${view.displayOf(p.table_id)}" (${describeViewShape(p.changes) || "rename"})`,
    minted: () => ({}),
    references: (p) => [p.table_id, p.view_id, ...viewColumnRefs(p.changes)],
  },
};

export const viewsDelete: OpDef<ViewsDelete> = {
  parse(input, view) {
    const table = view.table(input);
    return { kind: "views.delete", table_id: table.table_id, view_id: table.view(input).view_id };
  },
  capture: (sql, p) => ({ kind: "views.delete", table_id: p.table_id, view: getView(sql, p.table_id, p.view_id) }),
  apply(sql, p) {
    const meta = getTable(sql, p.table_id);
    const view = getView(sql, meta.table_id, p.view_id);
    deleteView(sql, view.view_id);
    return { result: { deleted: true }, summary: `Deleted view "${view.name}" from "${meta.display}"` };
  },
};
