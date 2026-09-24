import type { DatabaseSchema, TableSchema, ViewSpec } from "@stuga/protocol/databases/types";

/**
 * An agent's table reference (table_id, physical name or display name), against
 * its projected schema so a table it proposed moments ago resolves.
 */
export function resolveTable(schema: DatabaseSchema, ref: string | undefined): { table: TableSchema } | { error: string } {
  if (!ref) return { error: "this action requires `table`" };
  const hits = schema.tables.filter((t) => t.table_id === ref || t.name === ref || t.display === ref);
  if (hits.length === 1) return { table: hits[0]! };
  if (hits.length > 1) {
    return { error: `"${ref}" is ambiguous — use a table_id: ${hits.map((t) => `${t.table_id} (${t.display})`).join(", ")}` };
  }
  return { error: `no table "${ref}" — tables here: ${schema.tables.map((t) => `${t.name} (${t.table_id})`).join(", ") || "none"}` };
}

/** A view reference (view_id or name) against one table's saved views. */
export function resolveView(table: TableSchema, ref: string | undefined): { view: ViewSpec } | { error: string } {
  if (!ref) return { error: "update_view requires `view` (a view_id or name from action:schema)" };
  const hits = table.views.filter((v) => v.view_id === ref || v.name === ref);
  if (hits.length === 1) return { view: hits[0]! };
  if (hits.length > 1) return { error: `"${ref}" is ambiguous — use a view_id: ${hits.map((v) => `${v.view_id} (${v.name})`).join(", ")}` };
  return { error: `no view "${ref}" on ${table.name} — views here: ${table.views.map((v) => `${v.name} (${v.view_id})`).join(", ") || "none"}` };
}

/** SQLite has no boolean storage class and the actor refuses boolean bindings. */
export function normalizeQueryParams(params: Array<string | number | boolean | null> | undefined): Array<string | number | null> {
  return (params ?? []).map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
}
