/**
 * The schema an op is validated against. A direct write sees the live tables
 * and names its target by id. A proposal sees the live tables plus what this
 * agent's still-pending ops will create, and may name a table by id, physical
 * name or display name, so a table, its columns and its rows can be proposed
 * across consecutive calls.
 */
import { sanitizeIdentifier } from "@stuga/protocol/databases/identifiers";
import type {
  ColumnSpec,
  DatabaseRunOpPayload,
  DbRunOpColumnsAdd,
  DbRunOpRowsInsert,
  DbRunOpTablesCreate,
  DbRunOpViewsCreate,
} from "@stuga/protocol/databases/types";
import { OpError, type Body } from "../request.js";
import {
  existingRowIds,
  findTable,
  getColumns,
  getTable,
  getView,
  listTables,
  listViews,
  rowCount,
  tableCount,
  type SqlHandle,
  type TableMeta,
} from "../schema-ops.js";

interface TableView {
  readonly table_id: string;
  readonly display: string;
  /** Live columns, then this run's pending ones. */
  readonly columns: ColumnSpec[];
  rowCount(): number;
  viewCount(): number;
  /** The view the input names. */
  view(input: Body): { view_id: string; name: string };
  /** Refuse row ids that are neither live nor minted by a pending insert. */
  checkRows(ids: string[]): void;
}

export class SchemaView {
  private constructor(
    readonly sql: SqlHandle,
    private readonly pending: DatabaseRunOpPayload[],
    readonly proposal: boolean,
  ) {}

  static live(sql: SqlHandle): SchemaView {
    return new SchemaView(sql, [], false);
  }

  static projected(sql: SqlHandle, pending: DatabaseRunOpPayload[]): SchemaView {
    return new SchemaView(sql, pending, true);
  }

  private pendingOf<K extends DatabaseRunOpPayload["kind"]>(kind: K): Array<Extract<DatabaseRunOpPayload, { kind: K }>> {
    return this.pending.filter((p): p is Extract<DatabaseRunOpPayload, { kind: K }> => p.kind === kind);
  }

  tableCount(): number {
    return tableCount(this.sql) + this.pendingOf("tables.create").length;
  }

  table(input: Body): TableView {
    if (!this.proposal) return this.tableView(getTable(this.sql, input.table_id), null);
    const ref = input.table;
    if (typeof ref !== "string" || ref === "") throw new OpError(400, "bad_request", "op.table is required");
    const live = resolveLiveTable(this.sql, ref);
    if (live) return this.tableView(live, null);
    const created = this.pendingOf("tables.create").find((p) => p.table_id === ref || p.display === ref || sanitizeIdentifier(p.display) === ref);
    if (!created) throw new OpError(404, "table_not_found", `no table "${ref}"`);
    return this.tableView(null, created);
  }

  /** A table's display name, live or pending. */
  displayOf(tableId: string): string {
    return findTable(this.sql, tableId)?.display ?? this.pendingOf("tables.create").find((p) => p.table_id === tableId)?.display ?? tableId;
  }

  /** A view's name, live or pending. */
  viewNameOf(tableId: string, viewId: string): string {
    return (
      listViews(this.sql, tableId).find((v) => v.view_id === viewId)?.name ??
      this.pendingOf("views.create").find((p) => p.view_id === viewId)?.view.name ??
      viewId
    );
  }

  private tableView(live: TableMeta | null, created: DbRunOpTablesCreate | null): TableView {
    const sql = this.sql;
    const tableId = live?.table_id ?? created!.table_id;
    const display = live?.display ?? created!.display;
    const columns = live ? getColumns(sql, tableId) : [];
    for (const p of this.pendingOf("columns.add").filter((c: DbRunOpColumnsAdd) => c.table_id === tableId)) {
      columns.push({
        column_id: p.column_id,
        name: sanitizeIdentifier(p.display),
        display: p.display,
        type: p.type,
        position: columns.length,
        options: p.options,
        ...(p.description ? { description: p.description } : {}),
        pending: true,
      });
    }
    const inserts = this.pendingOf("rows.insert").filter((p: DbRunOpRowsInsert) => p.table_id === tableId);
    const pendingRowIds = new Set(inserts.flatMap((p) => p.row_ids));
    const pendingViews = this.pendingOf("views.create").filter((p: DbRunOpViewsCreate) => p.table_id === tableId);
    const proposal = this.proposal;
    return {
      table_id: tableId,
      display,
      columns,
      rowCount: () => (live ? rowCount(sql, live.name) : 0) + pendingRowIds.size,
      viewCount: () => (live ? listViews(sql, tableId).length : 0) + pendingViews.length,
      view(input) {
        if (!proposal) return getView(sql, tableId, input.view_id);
        const ref = input.view;
        if (typeof ref !== "string" || ref === "") throw new OpError(400, "bad_request", "op.view is required");
        const liveView = live ? resolveViewRef(listViews(sql, tableId), ref) : null;
        if (liveView) return liveView;
        const minted = pendingViews.find((p) => p.view_id === ref || p.view.name === ref);
        if (!minted) throw new OpError(404, "view_not_found", `no view "${ref}" on "${display}"`);
        return { view_id: minted.view_id, name: minted.view.name };
      },
      checkRows(ids) {
        const liveIds = live ? existingRowIds(sql, live.name, ids) : new Set<string>();
        const unknown = ids.filter((id) => !liveIds.has(id) && !pendingRowIds.has(id));
        if (unknown.length > 0) {
          throw new OpError(409, "row_not_found", `no such row(s) in "${display}": ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}`);
        }
      },
    };
  }
}

/** A live table by id, then physical name, then unique display name. */
function resolveLiveTable(sql: SqlHandle, ref: string): TableMeta | null {
  const tables = listTables(sql);
  const byId = tables.find((t) => t.table_id === ref) ?? tables.find((t) => t.name === ref);
  if (byId) return byId;
  const byDisplay = tables.filter((t) => t.display === ref);
  if (byDisplay.length > 1) throw new OpError(400, "ambiguous_table", `table reference "${ref}" is ambiguous; use a table_id`);
  return byDisplay[0] ?? null;
}

/** A live view by id, then unique name; null when none matches. */
function resolveViewRef(views: Array<{ view_id: string; name: string }>, ref: string): { view_id: string; name: string } | null {
  const byId = views.find((v) => v.view_id === ref);
  if (byId) return byId;
  const byName = views.filter((v) => v.name === ref);
  if (byName.length > 1) {
    throw new OpError(400, "ambiguous_view", `view reference "${ref}" is ambiguous; use a view_id (candidates: ${byName.map((v) => v.view_id).join(", ")})`);
  }
  return byName[0] ?? null;
}
