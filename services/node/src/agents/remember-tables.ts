/**
 * Save to Stuga into tables: where a point goes when it is a fact a table records. It writes nothing. From the
 * databases the point's words reach that the caller can read (their names, their columns' names, their cells:
 * what their indexing wrote), each table is read as text and the point is matched against it:
 *
 * - the row it names: a row whose title cell (its first text column, what a person sees it called) holds a
 *   value the point names as written, as search normalises text ("Initech", "ＩＮＩＴＥＣＨ", 環球 for 环球);
 *   of two names one holds ("Initech", "Initech Labs"), the longer;
 * - the columns it fills: those it names by every word of their name ("refund window") or by a choice they
 *   offer ("the Pro plan"), never the title column of a row it names;
 * - each such cell as it reads now: `already_saved` when it holds what the point says and nothing in the point
 *   says another value for it ("30 days; it was 14 days before" says nothing of 14 days but that it was),
 *   `possibly_replaces` when it holds another value, or may; empty otherwise; `waiting` when a change the user
 *   asked for waits to write it.
 *
 * A row the point names, in a database the caller can change, is a candidate (`kind: "row"`): first, with the
 * pages that say the point, when every cell it fills says it already; before the pages about the point when
 * it fills a column; after them when it fills none. With no row named, a table whose name the point names with
 * one of its columns, or two of its columns alone, is a candidate for a new row (`row: null`), its title column
 * first among what it fills; the table named alone is one after the pages about the point. A new row the user
 * already asked for, named by the point, is said to wait (`waiting_row`) rather than offered again.
 * A database the caller can only read offers no candidate; its cells still say what is there.
 */
import type {
  AlreadySavedPassage,
  PlaceReview,
  RememberPoint,
  RememberRowCandidate,
  RememberRowFill,
  ReplaceablePassage,
} from "@stuga/agent-surface/backend";
import { cellSaid, longestNames, namedChoice, namedChoices, namesColumn, namesRow, questionWords, saysCell, withoutAddresses, type DocRow } from "@stuga/db";
import { cellPlainText } from "@stuga/protocol/databases/csv";
import type { RowsReadColumn, RowsReadRow, RowsReadTable } from "@stuga/protocol/databases/rows-read";
import type { Ctx } from "../auth/context.js";
import { canWriteDoc } from "../authz/authz.js";
import { databasesFor, rowsFor, waitingOnRows, type RowAdded, type RowWait, type TableCache } from "./tables.js";

/** Databases one point's plan reads. */
const PLAN_DATABASES = 3;
/** Rows of one table a point may name. */
const NAMED_ROWS_MAX = 2;
/** Row candidates one point is offered at most. */
export const ROW_CANDIDATES_MAX = 2;
/** Columns a candidate lists, for a fact it names none of. */
const COLUMNS_LISTED = 20;
const EXCERPT_CHARS = 240;

/** Where a row candidate stands among a point's places. */
export type RowTier = "holds" | "fits" | "weak";

export interface TablePlan {
  candidates: Array<{ tier: RowTier; candidate: RememberRowCandidate }>;
  alreadySaved: AlreadySavedPassage[];
  replaces: ReplaceablePassage[];
}

/** What remember.ts reads once per plan and hands over: a place's folder path, its instructions' labels, its review. */
export interface PlacesOf {
  folderPath(folderId: string | null): Promise<string[]>;
  instructionLabels(doc: DocRow): Promise<string[]>;
  review(doc: DocRow): PlaceReview;
  origin: string;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quoted = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(", ");

function rowUrl(origin: string, doc: DocRow, table: RowsReadTable, rowId: string | null): string {
  return `${origin}/doc/${doc.doc_id}?table=${encodeURIComponent(table.table_id)}${rowId ? `&row=${encodeURIComponent(rowId)}` : ""}`;
}

/** A row as one line: its cells by column name. */
function rowLine(columns: readonly RowsReadColumn[], cells: Record<string, string>): string {
  return columns.flatMap((c) => (cells[c.column_id] ? [`${c.display}: ${cells[c.column_id]}`] : [])).join(" · ");
}

/** The value a waiting change of the user's would write in a cell, and whom it waits for; the latest one. */
function waitingIn(waits: readonly RowWait[], column: RowsReadColumn): RememberRowFill["waiting"] | undefined {
  let out: RememberRowFill["waiting"] | undefined;
  for (const w of waits) {
    if (w.change.kind !== "update" || !(column.column_id in w.change.values)) continue;
    const value = cellPlainText(column.type, w.change.values[column.column_id]).replace(/\s*\n\s*/g, " ").trim();
    out = { after_approval: cut(value, EXCERPT_CHARS), waits_for: w.waits };
  }
  return out;
}

/** A waiting new row's title: its first non-empty text value, by column order. */
function titleOfAdded(columns: readonly RowsReadColumn[], added: RowAdded): string {
  for (const c of columns) {
    if (c.type !== "text") continue;
    const v = added.values[c.column_id];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/** One point's rows: the candidates it has in tables, and the cells that say it or that it may change. */
export async function planTables(ctx: Ctx, cache: TableCache, point: RememberPoint, places: PlacesOf, stop: ReadonlySet<string>): Promise<TablePlan> {
  const out: TablePlan = { candidates: [], alreadySaved: [], replaces: [] };
  // An address says where to send something, not what the point is about; the source never steers it.
  const said = withoutAddresses(point.text);
  const text = [point.topic, said].filter(Boolean).join("\n");
  const docs = await databasesFor(ctx, text, { limit: PLAN_DATABASES });
  const needles = questionWords(text).filter((w) => !stop.has(w));
  for (const doc of docs) {
    const read = await rowsFor(ctx, cache, doc, needles);
    if (!read) continue;
    const waiting = await waitingOnRows(ctx, cache, doc);
    const writable = canWriteDoc(ctx, doc) && !doc.locked;
    const review = places.review(doc);
    for (const table of read.tables) {
      const titleColumn = table.columns.find((c) => c.type === "text") ?? null;
      // The columns it names, and the single-select ones whose choice it names: never the title column.
      const named: Array<{ column: RowsReadColumn; choice?: string }> = [];
      for (const c of table.columns) {
        if (c.column_id === titleColumn?.column_id) continue;
        // The one choice it says ("the Team plan, not Pro"); several named, none said for sure, still name the column.
        const choice = c.type === "single_select" && c.choices ? namedChoice(said, c.choices) : null;
        if (choice) named.push({ column: c, choice });
        else if (namesColumn(text, c.display) || (c.choices && namedChoices(said, c.choices).length > 0)) named.push({ column: c });
      }
      const tableNamed = namesColumn(text, table.display) || namesColumn(text, doc.title);
      const names = longestNames(table.rows.map((r) => r.title).filter((t) => namesRow(text, t)));
      const rows = table.rows.filter((r) => names.includes(r.title)).slice(0, NAMED_ROWS_MAX);
      const place = async (): Promise<Pick<RememberRowCandidate, "database_id" | "title" | "folder_path" | "table_id" | "table" | "table_name" | "title_column" | "columns" | "review"> & { instructions_labels?: string[] }> => {
        const labels = await places.instructionLabels(doc);
        return {
          database_id: doc.doc_id,
          title: doc.title,
          folder_path: await places.folderPath(doc.parent_id),
          table_id: table.table_id,
          table: table.display,
          table_name: table.name,
          title_column: titleColumn?.display ?? null,
          columns: table.columns.slice(0, COLUMNS_LISTED).map((c) => ({ column_id: c.column_id, name: c.display, type: c.type, ...(c.choices ? { choices: c.choices } : {}) })),
          review,
          ...(labels.length > 0 ? { instructions_labels: labels } : {}),
        };
      };
      const pending: Array<{ tier: RowTier; row: RowsReadRow | null; fills: RememberRowFill[]; why: string; url: string; waitingRow?: RememberRowCandidate["waiting_row"] }> = [];
      const planRow = (row: RowsReadRow): void => {
        const waits = waiting.byRow.get(`${table.table_id}.${row.row_id}`) ?? [];
        const context = [row.title, table.display, doc.title, ...named.map((n) => n.column.display)];
        const fills: RememberRowFill[] = named.map(({ column, choice }) => {
          const now = row.cells[column.column_id] ?? null;
          // Said only when nothing in the point says another value for it (cellSaid): in doubt, the agent compares.
          const holds = now !== null && (choice ? saysCell(choice, now) && saysCell(now, choice) : cellSaid(text, now, context));
          const wait = waitingIn(waits, column);
          return {
            column_id: column.column_id,
            column: column.display,
            type: column.type,
            now,
            ...(column.choices ? { choices: column.choices } : {}),
            ...(choice ? { choice } : {}),
            ...(holds ? { already_saved: true as const } : now !== null ? { possibly_replaces: true as const } : {}),
            ...(wait ? { waiting: wait } : {}),
          };
        });
        const ref = { table_id: table.table_id, table: table.display, row_id: row.row_id, row: row.title };
        const url = rowUrl(places.origin, doc, table, row.row_id);
        for (const f of fills) {
          const cell = { ...ref, column_id: f.column_id, column: f.column };
          const sentence = `${row.title} · ${f.column}: ${f.now}`;
          if (f.already_saved) {
            out.alreadySaved.push({ doc_id: doc.doc_id, title: doc.title, heading_path: null, sentence, excerpt: cut(rowLine(table.columns, row.cells), EXCERPT_CHARS), ...cell, url });
          } else if (f.possibly_replaces) {
            out.replaces.push({ doc_id: doc.doc_id, title: doc.title, heading_path: null, sentence, hint: "possibly_replaces", can_edit: writable, review, ...cell, url });
          }
        }
        if (!writable) return;
        // Waiting to say it already: a change the user asked for writes what the point says.
        const waitingSays = fills.length > 0 && fills.every((f) => f.already_saved || (f.waiting && cellSaid(text, f.waiting.after_approval, context)));
        const tier: RowTier = fills.length > 0 && (fills.every((f) => f.already_saved) || waitingSays) ? "holds" : fills.length > 0 ? "fits" : "weak";
        const why = [
          `its row "${row.title}" in ${table.display} is the one the point names`,
          ...named.filter((n) => !n.choice).length > 0 ? [`the point names its column(s) ${quoted(named.filter((n) => !n.choice).map((n) => n.column.display))}`] : [],
          ...named.filter((n) => n.choice).map((n) => `the point names "${n.choice}", a choice of ${n.column.display}`),
          ...fills.filter((f) => f.already_saved).map((f) => `its ${f.column} says the point already`),
          ...fills.filter((f) => f.possibly_replaces).map((f) => `its ${f.column} holds "${cut(f.now ?? "", 80)}", which the point may change: update that cell`),
          ...fills.filter((f) => f.waiting).map((f) => `a change the user asked for already writes ${f.column}: "${cut(f.waiting!.after_approval, 80)}", waiting for approval`),
          ...(fills.length === 0 ? ["the point names none of its columns: pick the one it fills from `columns`, or a page if none fits"] : []),
        ];
        pending.push({ tier, row, fills, why: why.join("; "), url });
      };
      for (const row of rows) planRow(row);
      if (rows.length === 0 && writable && titleColumn) {
        const plain = named.filter((n) => !n.choice).length;
        const fitsNew = (tableNamed && named.length >= 1) || plain >= 2;
        // A new row the user already asked for, the point naming it: it waits, never added twice.
        const added = waiting.added.filter((a) => a.table_id === table.table_id).find((a) => namesRow(text, titleOfAdded(table.columns, a)));
        if (fitsNew || tableNamed || added) {
          const fills: RememberRowFill[] = [
            { column_id: titleColumn.column_id, column: titleColumn.display, type: titleColumn.type, now: null },
            ...named.map(({ column, choice }) => ({
              column_id: column.column_id,
              column: column.display,
              type: column.type,
              now: null,
              ...(column.choices ? { choices: column.choices } : {}),
              ...(choice ? { choice } : {}),
            })),
          ];
          const what = [tableNamed ? `its table ${table.display}` : null, named.length > 0 ? `its column(s) ${quoted(named.map((n) => n.column.display))}` : null]
            .filter((w): w is string => w !== null)
            .join(" and ");
          const why = [
            what ? `the point names ${what} and none of its rows: a new row, named in its column "${titleColumn.display}"` : null,
            table.partial ? "the table holds more rows than one plan reads: `query` it for the name before you add a row" : null,
            added ? `a new row "${titleOfAdded(table.columns, added)}" the user asked for already waits for approval: never add it again` : null,
          ].filter((r): r is string => r !== null);
          pending.push({
            tier: added ? "holds" : fitsNew ? "fits" : "weak",
            row: null,
            fills,
            why: why.join("; "),
            url: rowUrl(places.origin, doc, table, null),
            ...(added ? { waitingRow: { title: titleOfAdded(table.columns, added), waits_for: added.waits } } : {}),
          });
        }
      }
      if (pending.length === 0) continue;
      const base = await place();
      for (const p of pending) {
        out.candidates.push({
          tier: p.tier,
          candidate: {
            kind: "row",
            ...base,
            row: p.row ? { row_id: p.row.row_id, title: p.row.title } : null,
            fills: p.fills,
            ...(p.waitingRow ? { waiting_row: p.waitingRow } : {}),
            why: p.why,
            url: p.url,
          },
        });
      }
    }
  }
  const order: Record<RowTier, number> = { holds: 0, fits: 1, weak: 2 };
  out.candidates.sort((a, b) => order[a.tier] - order[b.tier]);
  out.candidates.splice(ROW_CANDIDATES_MAX);
  return out;
}
