import { validateSelectChoices } from "@stuga/protocol/databases/cells";
import { DATABASE_MAX_COLUMNS } from "@stuga/protocol/databases/limits";
import type { ColumnOptions, DatabaseColumnType, DbRunOpColumnsAdd } from "@stuga/protocol/databases/types";
import { OpError, conflict, parseDescription, plural, requireDisplay, requireObject } from "../request.js";
import {
  addColumn,
  captureNonConforming,
  coerceNonConforming,
  dropColumn,
  getColumn,
  getColumns,
  getTable,
  isColumnType,
  newId,
  renameColumn,
  selectNonNullCells,
  setColumnDescriptionMeta,
  setColumnTypeMeta,
  type CreateColumnInput,
} from "../schema-ops.js";
import type { OpDef } from "./registry.js";

type ColumnsRename = { kind: "columns.rename"; table_id: string; column_id: string; display: string };
type ColumnsSetType = { kind: "columns.set_type"; table_id: string; column_id: string; type: DatabaseColumnType; options: ColumnOptions | null };
/** `null` clears the description. People only: an agent describes a column when it adds it, and not after. */
type ColumnsSetDescription = { kind: "columns.set_description"; table_id: string; column_id: string; description: string | null };
type ColumnsDelete = { kind: "columns.delete"; table_id: string; column_id: string };

function requireColumnType(type: unknown, label = "unknown column type: "): DatabaseColumnType {
  if (!isColumnType(type)) throw new OpError(400, "validation", `${label}${String(type)}`);
  return type;
}

/**
 * single_select needs a valid choice list; other types carry no options. A
 * description is not part of the options: it travels on its own, may sit on a
 * column of any type, and survives a retype (see setColumnTypeMeta).
 */
function optionsFor(type: DatabaseColumnType, choices: unknown): ColumnOptions | null {
  if (type !== "single_select") return null;
  const v = validateSelectChoices(choices);
  if (!v.ok) throw new OpError(400, "validation", v.reason);
  return { choices: v.choices };
}

function columnCapError(tableDisplay: string, count: number): OpError {
  return new OpError(409, "column_cap", `table "${tableDisplay}" already has ${count} columns (max ${DATABASE_MAX_COLUMNS})`);
}

/** A declarative create's `[{display|name, type, choices?, description?}]`, all checked before anything is written. */
export function parseColumnSpecs(raw: unknown): CreateColumnInput[] {
  if (!Array.isArray(raw)) throw new OpError(400, "validation", "columns must be an array");
  if (raw.length > DATABASE_MAX_COLUMNS) throw new OpError(409, "column_cap", `too many columns (max ${DATABASE_MAX_COLUMNS})`);
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const spec = requireObject(c, `columns[${i}] must be an object`);
    const display = requireDisplay(spec.display ?? spec.name, `columns[${i}].name`);
    const type = requireColumnType(spec.type, `columns[${i}] "${display}": unknown column type `);
    const key = display.toLowerCase();
    if (seen.has(key)) throw new OpError(400, "validation", `column "${display}" is listed twice`);
    seen.add(key);
    const description = parseDescription(spec.description, `columns[${i}].description`);
    return { display, type, options: optionsFor(type, spec.choices), ...(description ? { description } : {}) };
  });
}

export const columnsAdd: OpDef<DbRunOpColumnsAdd> = {
  parse(input, view) {
    const table = view.table(input);
    const display = requireDisplay(input.display);
    const type = requireColumnType(input.type);
    const options = optionsFor(type, input.choices);
    const description = parseDescription(input.description);
    if (table.columns.length >= DATABASE_MAX_COLUMNS) throw columnCapError(table.display, table.columns.length);
    return {
      kind: "columns.add",
      table_id: table.table_id,
      column_id: newId("col_"),
      display,
      type,
      options,
      ...(description ? { description } : {}),
    };
  },
  capture: (_sql, p) => ({ kind: "columns.add", table_id: p.table_id, column_id: p.column_id }),
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    const columns = getColumns(sql, meta.table_id);
    if (columns.some((c) => c.column_id === p.column_id)) throw conflict("this column was already added");
    if (columns.length >= DATABASE_MAX_COLUMNS) throw columnCapError(meta.display, columns.length);
    return {
      result: {
        column: addColumn(
          sql,
          meta.table_id,
          { columnId: p.column_id, display: p.display, type: p.type, options: p.options, ...(p.description ? { description: p.description } : {}) },
          now,
        ),
      },
      summary: `Added column "${p.display}" to "${meta.display}"`,
    };
  },
  proposal: {
    describe: (p, view) => `Add ${p.type} column "${p.display}" to "${view.displayOf(p.table_id)}"`,
    minted: (p) => ({ column_id: p.column_id }),
    references: (p) => [p.table_id],
  },
};

export const columnsRename: OpDef<ColumnsRename> = {
  parse(input, view) {
    const table = view.table(input);
    const col = getColumn(view.sql, table.table_id, input.column_id);
    return { kind: "columns.rename", table_id: table.table_id, column_id: col.column_id, display: requireDisplay(input.display) };
  },
  capture: (sql, p) => ({
    kind: "columns.rename",
    table_id: p.table_id,
    column_id: p.column_id,
    prev_display: getColumn(sql, p.table_id, p.column_id).display,
  }),
  apply(sql, p) {
    const meta = getTable(sql, p.table_id);
    const prev = getColumn(sql, p.table_id, p.column_id);
    return {
      result: { column: renameColumn(sql, p.table_id, p.column_id, p.display) },
      summary: `Renamed column "${prev.display}" to "${p.display}" in "${meta.display}"`,
    };
  },
};

/**
 * The column's help text, written after the fact. It lives in the options blob,
 * so setting it touches no cell and its inverse is the previous text.
 */
export const columnsSetDescription: OpDef<ColumnsSetDescription> = {
  parse(input, view) {
    const table = view.table(input);
    const col = getColumn(view.sql, table.table_id, input.column_id);
    return { kind: "columns.set_description", table_id: table.table_id, column_id: col.column_id, description: parseDescription(input.description) };
  },
  capture: (sql, p) => ({
    kind: "columns.set_description",
    table_id: p.table_id,
    column_id: p.column_id,
    prev_description: getColumn(sql, p.table_id, p.column_id).description ?? null,
  }),
  unchanged(sql, p) {
    const col = getColumn(sql, p.table_id, p.column_id);
    return (col.description ?? null) === p.description ? { column: col } : null;
  },
  apply(sql, p) {
    const meta = getTable(sql, p.table_id);
    const col = getColumn(sql, p.table_id, p.column_id);
    return {
      result: { column: setColumnDescriptionMeta(sql, p.table_id, p.column_id, p.description) },
      summary:
        p.description === null
          ? `Cleared the description of column "${col.display}" in "${meta.display}"`
          : `Described column "${col.display}" in "${meta.display}"`,
    };
  },
};

/**
 * A type change is metadata plus one UPDATE over the cells that do not conform.
 * The inverse holds exactly those cells and the previous type.
 */
export const columnsSetType: OpDef<ColumnsSetType> = {
  parse(input, view) {
    const table = view.table(input);
    const col = getColumn(view.sql, table.table_id, input.column_id);
    const type = requireColumnType(input.type);
    return { kind: "columns.set_type", table_id: table.table_id, column_id: col.column_id, type, options: optionsFor(type, input.choices) };
  },
  capture(sql, p) {
    const meta = getTable(sql, p.table_id);
    const col = getColumn(sql, p.table_id, p.column_id);
    return {
      kind: "columns.set_type",
      table_id: p.table_id,
      column_id: p.column_id,
      prev_type: col.type,
      prev_options: col.options,
      cells: captureNonConforming(sql, meta.name, col.name, p.type, p.options?.choices ?? null),
    };
  },
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    const col = getColumn(sql, p.table_id, p.column_id);
    const choices = p.options?.choices ?? null;
    const cells = captureNonConforming(sql, meta.name, col.name, p.type, choices);
    setColumnTypeMeta(sql, col.column_id, p.type, p.options);
    const coerced = coerceNonConforming(sql, meta.name, col.name, p.type, choices, cells, now);
    return {
      result: { column: getColumn(sql, p.table_id, p.column_id), coerced },
      summary: `Changed column "${col.display}" in "${meta.display}" to ${p.type} (${plural(coerced, "cell")} coerced)`,
    };
  },
};

export const columnsDelete: OpDef<ColumnsDelete> = {
  parse(input, view) {
    const table = view.table(input);
    return { kind: "columns.delete", table_id: table.table_id, column_id: getColumn(view.sql, table.table_id, input.column_id).column_id };
  },
  capture(sql, p) {
    const meta = getTable(sql, p.table_id);
    const col = getColumn(sql, p.table_id, p.column_id);
    return { kind: "columns.delete", table_id: p.table_id, column: col, cells: selectNonNullCells(sql, meta.name, col.name) };
  },
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    const col = getColumn(sql, p.table_id, p.column_id);
    dropColumn(sql, p.table_id, p.column_id, now);
    return { result: { deleted: true }, summary: `Deleted column "${col.display}" from "${meta.display}"` };
  },
};
