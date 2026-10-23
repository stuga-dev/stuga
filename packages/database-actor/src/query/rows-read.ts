/**
 * Rows as text, for what the node's agents read of a table (Save to Stuga's row matching, Ask Stuga's
 * rows), the wiki's Log (the rows a change touched) and its check (a link to a row that is gone). Live
 * rows only: a proposal is the run ledger's, never in here. Each row says who last wrote it, read from
 * the ledger: the op whose timestamp its `_updated_at` holds, as one commit stamps both (writerOf).
 */
import { cellPlainText } from "@stuga/protocol/databases/csv";
import {
  ROWS_READ_IDS_MAX,
  ROWS_READ_MAX,
  ROWS_READ_NEEDLES_MAX,
  type RowEditor,
  type RowsReadColumn,
  type RowsReadResponse,
  type RowsReadRow,
} from "@stuga/protocol/databases/rows-read";
import type { ColumnSpec, RowValue } from "@stuga/protocol/databases/types";
import type { ActorStorage } from "@stuga/runtime";
import { OpError, type Body } from "../request.js";
import { getColumns, ident, listTables, rowCount, type SqlHandle } from "../schema-ops.js";

/** Bound parameters per IN list, well under SQLite's variable limit. */
const IN_CHUNK = 500;
/** Characters of one needle; a longer one is no word. */
const NEEDLE_MAX_CHARS = 100;
/** Cell types a needle is looked for in: what a person writes words in. */
const WORDED = new Set(["text", "single_select", "date", "number", "files"]);

interface Parsed {
  rows: Map<string, string[]> | null;
  needles: string[];
  max: number;
  titlesOnly: boolean;
}

function parse(body: Body): Parsed {
  let rows: Map<string, string[]> | null = null;
  if (body.rows !== undefined) {
    if (!Array.isArray(body.rows) || body.rows.length > ROWS_READ_IDS_MAX) {
      throw new OpError(400, "validation", `rows must be an array of at most ${ROWS_READ_IDS_MAX} {table_id, row_id}`);
    }
    rows = new Map();
    for (const r of body.rows as unknown[]) {
      const ref = r as { table_id?: unknown; row_id?: unknown } | null;
      if (!ref || typeof ref.table_id !== "string" || typeof ref.row_id !== "string" || ref.table_id === "" || ref.row_id === "") {
        throw new OpError(400, "validation", "each row must name its table_id and row_id");
      }
      rows.set(ref.table_id, [...(rows.get(ref.table_id) ?? []), ref.row_id]);
    }
  }
  const raw = body.needles ?? [];
  if (!Array.isArray(raw) || raw.some((n) => typeof n !== "string")) throw new OpError(400, "validation", "needles must be an array of strings");
  const needles = [...new Set((raw as string[]).map((n) => n.trim().toLowerCase()).filter((n) => n !== "" && n.length <= NEEDLE_MAX_CHARS))].slice(
    0,
    ROWS_READ_NEEDLES_MAX,
  );
  const asked = body.max_rows === undefined ? ROWS_READ_MAX : Number(body.max_rows);
  if (!Number.isInteger(asked) || asked < 1) throw new OpError(400, "validation", "max_rows must be a positive integer");
  return { rows, needles, max: Math.min(asked, ROWS_READ_MAX), titlesOnly: body.titles_only === true };
}

/** `%`, `_` and the escape itself, taken as written in a LIKE pattern. */
function likeOf(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** An op that wrote rows of a table at an instant, and what its inverse names, to tell two at one instant apart. */
interface Writer {
  editor: RowEditor;
  /** The inverse as the ledger keeps it inline: the ids of the rows it wrote are in it. Null when kept apart. */
  inverse: string | null;
}

/** The ops of each table by the instant they stamped, newest first. */
function writersOf(sql: SqlHandle): Map<string, Writer[]> {
  const out = new Map<string, Writer[]>();
  for (const op of sql.exec(`SELECT table_id, ts, actor, is_agent, on_behalf_of, inverse FROM _ops WHERE table_id IS NOT NULL ORDER BY seq DESC`)) {
    const key = `${String(op.table_id)}\u0000${Number(op.ts)}`;
    const editor = { alias: String(op.actor), is_agent: Number(op.is_agent) === 1, on_behalf_of: op.on_behalf_of == null ? null : String(op.on_behalf_of) };
    out.set(key, [...(out.get(key) ?? []), { editor, inverse: op.inverse == null ? null : String(op.inverse) }]);
  }
  return out;
}

/**
 * Who last wrote a row: the op of its table that stamped its `_updated_at`, the one commit stamping both; of
 * two at that instant, the one whose inverse names the row. Null when the ledger no longer holds it, or cannot
 * tell which of two it was.
 */
function writerOf(writers: Map<string, Writer[]>, tableId: string, rowId: string, updatedAt: number): RowEditor | null {
  const at = writers.get(`${tableId}\u0000${updatedAt}`) ?? [];
  if (at.length === 1) return at[0]!.editor;
  // Newest first: of two that wrote the row in one instant, the later one's value stands.
  return at.find((w) => rowsOfInverse(w.inverse).has(rowId))?.editor ?? null;
}

/** The ids of the rows an inline inverse names: the rows an op updated, inserted or deleted. */
function rowsOfInverse(inverse: string | null): Set<string> {
  const out = new Set<string>();
  if (inverse === null) return out;
  let parsed: { cells?: unknown; row_ids?: unknown; rows?: unknown; row_id?: unknown };
  try {
    parsed = JSON.parse(inverse) as typeof parsed;
  } catch {
    return out;
  }
  const idOf = (v: unknown) => (v && typeof v === "object" && typeof (v as { _id?: unknown })._id === "string" ? [(v as { _id: string })._id] : []);
  if (Array.isArray(parsed.cells)) for (const c of parsed.cells) for (const id of idOf(c)) out.add(id);
  if (Array.isArray(parsed.rows)) for (const r of parsed.rows) for (const id of idOf(r)) out.add(id);
  if (Array.isArray(parsed.row_ids)) for (const id of parsed.row_ids) if (typeof id === "string") out.add(id);
  if (typeof parsed.row_id === "string") out.add(parsed.row_id);
  return out;
}

function columnOf(c: ColumnSpec): RowsReadColumn {
  return {
    column_id: c.column_id,
    name: c.name,
    display: c.display,
    type: c.type,
    ...(c.options?.choices?.length ? { choices: c.options.choices } : {}),
    ...(c.description ? { description: c.description } : {}),
  };
}

/** The first non-empty text cell by column order: what a person sees a row called, and what its page is titled. */
export function titleOfRow(columns: readonly ColumnSpec[], row: Record<string, unknown>): string {
  for (const c of columns) {
    if (c.type !== "text") continue;
    const v = row[c.name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

export function readRows(storage: Pick<ActorStorage, "sql" | "transactionSync">, body: Body): RowsReadResponse {
  const sql = storage.sql;
  const req = parse(body);
  const writers = req.titlesOnly ? null : writersOf(sql);
  let budget = req.max;
  const tables: RowsReadResponse["tables"] = [];
  for (const table of listTables(sql)) {
    const ids = req.rows?.get(table.table_id) ?? null;
    if (req.rows && !ids) continue;
    // By position, as a person reads them and as a row's title is read.
    const columns = getColumns(sql, table.table_id);
    const count = rowCount(sql, table.name);
    const t = ident(table.name);
    const out: RowsReadRow[] = [];
    let partial = false;
    const take = (row: Record<string, unknown>) => {
      const cells: Record<string, string> = {};
      if (!req.titlesOnly) {
        for (const c of columns) {
          const text = cellPlainText(c.type, row[c.name] as RowValue | undefined).replace(/\s*\n\s*/g, " ").trim();
          if (text !== "") cells[c.column_id] = text;
        }
      }
      const updatedAt = Number(row._updated_at);
      out.push({
        row_id: String(row._id),
        created_at: Number(row._created_at),
        updated_at: updatedAt,
        updated_by: writers ? writerOf(writers, table.table_id, String(row._id), updatedAt) : null,
        title: titleOfRow(columns, row),
        cells,
      });
    };
    storage.transactionSync(() => {
      if (ids) {
        for (let i = 0; i < ids.length; i += IN_CHUNK) {
          const chunk = ids.slice(i, i + IN_CHUNK);
          for (const row of sql.exec(`SELECT * FROM ${t} WHERE _id IN (${chunk.map(() => "?").join(", ")})`, ...chunk)) take(row);
        }
        return;
      }
      if (budget <= 0) {
        partial = count > 0;
        return;
      }
      const worded = columns.filter((c) => WORDED.has(c.type));
      let where = "";
      const params: unknown[] = [];
      if (count > budget) {
        partial = true;
        // More rows than the read has left: those holding a word, as the grid's search finds them.
        if (req.needles.length > 0 && worded.length > 0) {
          const ors: string[] = [];
          for (const needle of req.needles) {
            for (const c of worded) {
              ors.push(`lower(CAST(${ident(c.name)} AS TEXT)) LIKE ? ESCAPE '\\'`);
              params.push(likeOf(needle));
            }
          }
          where = `WHERE ${ors.join(" OR ")}`;
        }
      }
      // Row at a time, so a large table is read only as far as the budget.
      const stream = sql.iterate(`SELECT * FROM ${t} ${where} ORDER BY "_created_at", rowid LIMIT ?`, ...params, budget);
      for (const row of stream.rows) take(row);
    });
    budget -= ids ? 0 : out.length;
    tables.push({
      table_id: table.table_id,
      name: table.name,
      display: table.display,
      row_count: count,
      columns: req.titlesOnly ? [] : columns.map(columnOf),
      rows: out,
      partial,
    });
  }
  return { tables };
}

/** Ops that change no row, column or table a reader reads: a row's page linked, a view saved, a number's format. */
const NOT_CONTENT = ["rows.link_page", "rows.link_pages", "views.create", "views.update", "views.delete", "columns.set_format"];

/**
 * The database's last change to what it holds (its rows, columns and tables): when, and by whom, as its ledger's
 * newest such op records it; null before any.
 */
export function lastChange(sql: SqlHandle): { at: number; by: string } | null {
  // A revert changes what the op it undid changed: a view's revert, no more than the view.
  for (const op of sql.exec(`SELECT ts, actor, kind, detail FROM _ops ORDER BY seq DESC`)) {
    const kind = String(op.kind);
    if (NOT_CONTENT.includes(kind)) continue;
    if (kind === "revert") {
      const of = op.detail == null ? null : (JSON.parse(String(op.detail)) as { of?: { kind?: string } | null }).of;
      if (of?.kind && NOT_CONTENT.includes(of.kind)) continue;
    }
    return { at: Number(op.ts), by: String(op.actor) };
  }
  return null;
}

/** Every row of every table. */
export function totalRows(sql: SqlHandle): number {
  return listTables(sql).reduce((n, t) => n + rowCount(sql, t.name), 0);
}
