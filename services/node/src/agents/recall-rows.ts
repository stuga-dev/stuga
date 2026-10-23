/**
 * Ask Stuga over tables: the rows whose cells hold words of a question, beside the passages an agent's
 * search or retrieval finds, cited as a passage is. Read from the databases the question's words reach that
 * the caller can read (recall's own gate: trash, kept out of search, ACL, a key's folders, a collection).
 *
 * A row counts when a cell holds a word of the question (as written or with another ending, as search
 * normalises text) and either its title cell holds one, or the question's words it accounts for come to two
 * (or all of them, for a one-word question): words its cells hold, and words naming a column of it or its
 * table ("Globex's contact": Globex in Name, contact naming Contact; "customers on the Pro plan": Pro in Plan,
 * plan and customers naming the column and the table). Stopwords count for nothing.
 *
 * Cells are the approved table's. What waits for a row is told as a document's waiting changes are: the
 * user's own listed as they would land (`approved_now` → `after_approval`, by `column`), a new row of theirs
 * listed as one waiting to be added. Anyone else's are counted for the whole database (`tables_waiting`),
 * as a reader who may not decide them is told of a run: which rows they touch is not theirs to know. When
 * more rows hold the words than are listed, `rows_more` says so, for `query` to read every one.
 */
import type { RecalledRow, RowTable, RowsMore, TablesWaiting, WaitingChanges, WaitsFor } from "@stuga/agent-surface/backend";
import { authorLabel, authorRefs, namesColumn, questionWords, stopwordsAmong, wordsInCell, type DocRow } from "@stuga/db";
import { cellPlainText } from "@stuga/protocol/databases/csv";
import type { RowsReadColumn, RowsReadRow, RowsReadTable } from "@stuga/protocol/databases/rows-read";
import type { RowValue } from "@stuga/protocol/databases/types";
import type { Ctx } from "../auth/context.js";
import { databasesFor, rowsFor, tableCache, waitingOnRows, type RowAdded, type RowWait } from "./tables.js";

/** Databases one recall reads rows of. */
const RECALL_DATABASES = 3;
/** Rows one recall lists. */
export const RECALL_ROWS = 5;
/** Cells a listed row shows, and characters of each. */
const CELLS_MAX = 12;
const CELL_CHARS = 200;
/** Characters of each side of a waiting change a row lists. */
const CHANGE_CHARS = 200;

export interface RecalledRows {
  rows: RecalledRow[];
  rows_more: RowsMore[];
  tables_waiting: TablesWaiting[];
  /** The tables the rows come from, with the names `query` reads them by. */
  tables: RowTable[];
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A row as one line: its cells by column name. */
function rowLine(columns: readonly RowsReadColumn[], cells: Record<string, string>): string {
  return columns.flatMap((c) => (cells[c.column_id] ? [`${c.display}: ${cells[c.column_id]}`] : [])).join(" · ");
}

/** A waiting new row's cells as the table would hold them. */
function cellsOfValues(columns: readonly RowsReadColumn[], values: Record<string, RowValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) {
    const text = cellPlainText(c.type, values[c.column_id]).replace(/\s*\n\s*/g, " ").trim();
    if (text !== "") out[c.column_id] = text;
  }
  return out;
}

interface Hit {
  doc: DocRow;
  table: RowsReadTable;
  row: RowsReadRow | null;
  added: RowAdded | null;
  cells: Record<string, string>;
  matched: Set<string>;
  score: number;
  titled: boolean;
  updatedAt: number;
}

/** The user's own waits on one row, grouped as a document's are, the colleague's level first, each as it would land. */
function groupWaits(waits: readonly RowWait[], columns: readonly RowsReadColumn[], cells: Record<string, string>): WaitingChanges[] {
  const groups = new Map<WaitsFor, WaitingChanges>();
  for (const w of waits) {
    const group = groups.get(w.waits) ?? { asked_by: "user", waits_for: w.waits, changes: 0, since: w.run.created_at };
    if (w.run.created_at < group.since) group.since = w.run.created_at;
    if (w.change.kind === "delete") {
      group.changes += 1;
      group.proposed = [...(group.proposed ?? []), { approved_now: cut(rowLine(columns, cells), CHANGE_CHARS), after_approval: "" }];
    } else {
      for (const [columnId, value] of Object.entries(w.change.values)) {
        const column = columns.find((c) => c.column_id === columnId);
        if (!column) continue;
        group.changes += 1;
        const after = cellPlainText(column.type, value).replace(/\s*\n\s*/g, " ").trim();
        group.proposed = [
          ...(group.proposed ?? []),
          { approved_now: cut(cells[columnId] ?? "", CHANGE_CHARS), after_approval: cut(after, CHANGE_CHARS), column: column.display },
        ];
      }
    }
    groups.set(w.waits, group);
  }
  return (["colleague", "review"] as const).flatMap((k) => {
    const g = groups.get(k);
    return g && g.changes > 0 ? [g] : [];
  });
}

/** Rows of the tables `q`'s words reach whose cells hold them, best first, at most `limit`. */
export async function recallRows(ctx: Ctx, q: string, opts: { scopeDocIds?: string[] | null; limit?: number } = {}): Promise<RecalledRows> {
  const limit = opts.limit ?? RECALL_ROWS;
  const said = q.trim().slice(0, 4000);
  const all = questionWords(said);
  const stop = await stopwordsAmong(ctx.sql, all, ctx.env.searchLanguages.current());
  const words = all.filter((w) => !stop.has(w));
  if (words.length === 0) return { rows: [], rows_more: [], tables_waiting: [], tables: [] };
  const docs = await databasesFor(ctx, said, { limit: RECALL_DATABASES, scopeDocIds: opts.scopeDocIds ?? null });
  const cache = tableCache();
  const hits: Hit[] = [];
  const counts = new Map<string, { hits: number; partial: boolean }>();
  // Two of the words, or all of them when the question has one.
  const enough = Math.min(2, words.length);
  for (const doc of docs) {
    const read = await rowsFor(ctx, cache, doc, words);
    if (!read) continue;
    const waiting = await waitingOnRows(ctx, cache, doc);
    for (const table of read.tables) {
      const named = table.columns.filter((c) => namesColumn(said, c.display));
      // Words naming a column of it, its table or its database stand for themselves.
      const context = new Set([
        ...named.flatMap((c) => wordsInCell(words, c.display)),
        ...(namesColumn(said, table.display) ? wordsInCell(words, table.display) : []),
        ...(namesColumn(said, doc.title) ? wordsInCell(words, doc.title) : []),
      ]);
      const titleColumn = table.columns.find((c) => c.type === "text")?.column_id ?? null;
      const consider = (cells: Record<string, string>, row: RowsReadRow | null, added: RowAdded | null) => {
        const held = new Set<string>();
        const matched = new Set<string>();
        let titled = false;
        for (const c of table.columns) {
          const cell = cells[c.column_id];
          if (!cell) continue;
          const found = wordsInCell(words, cell);
          if (found.length === 0) continue;
          matched.add(c.column_id);
          if (c.column_id === titleColumn) titled = true;
          for (const w of found) held.add(w);
        }
        if (held.size === 0) return;
        const accounted = new Set([...held, ...context]);
        if (!titled && accounted.size < enough) return;
        for (const c of named) if (cells[c.column_id]) matched.add(c.column_id);
        const key = `${doc.doc_id}\u0000${table.table_id}`;
        const count = counts.get(key) ?? { hits: 0, partial: table.partial };
        count.hits += 1;
        counts.set(key, count);
        hits.push({
          doc,
          table,
          row,
          added,
          cells,
          matched,
          score: accounted.size + (titled ? 0.5 : 0),
          titled,
          updatedAt: row ? row.updated_at : Date.parse(added?.run.created_at ?? "") || 0,
        });
      };
      for (const row of table.rows) consider(row.cells, row, null);
      for (const added of waiting.added) if (added.table_id === table.table_id) consider(cellsOfValues(table.columns, added.values), null, added);
    }
  }
  hits.sort((a, b) => b.score - a.score || Number(b.titled) - Number(a.titled) || b.updatedAt - a.updatedAt);
  const listed = hits.slice(0, limit);
  const editors = await authorRefs(ctx.sql, [...new Set(listed.flatMap((h) => (h.row?.updated_by ? [h.row.updated_by.alias] : [])))]);
  const rows: RecalledRow[] = [];
  for (const h of listed) {
    const waiting = await waitingOnRows(ctx, cache, h.doc);
    const shown: Record<string, string> = {};
    for (const c of h.table.columns) {
      if (Object.keys(shown).length >= CELLS_MAX) break;
      const cell = h.cells[c.column_id];
      if (cell) shown[c.display] = cut(cell, CELL_CHARS);
    }
    const base = {
      database_id: h.doc.doc_id,
      title: h.doc.title,
      table_id: h.table.table_id,
      table: h.table.display,
      table_name: h.table.name,
      matched: h.table.columns.filter((c) => h.matched.has(c.column_id)).map((c) => c.display),
    };
    if (h.row) {
      const ref = h.row.updated_by ? editors.get(h.row.updated_by.alias) : undefined;
      const pending = groupWaits(waiting.byRow.get(`${h.table.table_id}.${h.row.row_id}`) ?? [], h.table.columns, h.cells);
      rows.push({
        ...base,
        row_id: h.row.row_id,
        row_title: h.row.title,
        cells: shown,
        updated_at: new Date(h.row.updated_at).toISOString(),
        ...(ref ? { last_edited_by: [authorLabel(ref)] } : {}),
        ...(pending.length > 0 ? { pending_changes: pending } : {}),
      });
    } else if (h.added) {
      const titleColumn = h.table.columns.find((c) => c.type === "text" && h.cells[c.column_id]);
      rows.push({
        ...base,
        row_id: h.added.row_id,
        row_title: titleColumn ? h.cells[titleColumn.column_id]! : "",
        cells: {},
        waiting_row: true,
        pending_changes: [
          {
            asked_by: "user",
            waits_for: h.added.waits,
            changes: 1,
            since: h.added.run.created_at,
            proposed: [{ approved_now: "", after_approval: cut(rowLine(h.table.columns, h.cells), CHANGE_CHARS) }],
          },
        ],
      });
    }
  }
  const shownBy = new Map<string, number>();
  for (const h of listed) shownBy.set(`${h.doc.doc_id}\u0000${h.table.table_id}`, (shownBy.get(`${h.doc.doc_id}\u0000${h.table.table_id}`) ?? 0) + 1);
  const rows_more: RowsMore[] = [];
  for (const h of hits) {
    const key = `${h.doc.doc_id}\u0000${h.table.table_id}`;
    const count = counts.get(key)!;
    if (count.hits <= (shownBy.get(key) ?? 0) && !count.partial) continue;
    if (rows_more.some((m) => m.database_id === h.doc.doc_id && m.table === h.table.display)) continue;
    rows_more.push({ database_id: h.doc.doc_id, table: h.table.display, table_name: h.table.name, rows: count.hits });
  }
  // Other people's changes, counted for each database a row was listed from: never tied to a row.
  const tables_waiting: TablesWaiting[] = [];
  for (const doc of new Map(listed.map((h) => [h.doc.doc_id, h.doc])).values()) {
    for (const o of (await waitingOnRows(ctx, cache, doc)).others) {
      tables_waiting.push({ database_id: doc.doc_id, title: doc.title, asked_by: "others", waits_for: o.waits, changes: o.changes, since: o.since });
    }
  }
  const tables: RowTable[] = [];
  for (const h of listed) {
    if (tables.some((t) => t.database_id === h.doc.doc_id && t.table_id === h.table.table_id)) continue;
    tables.push({
      database_id: h.doc.doc_id,
      title: h.doc.title,
      table_id: h.table.table_id,
      table: h.table.display,
      table_name: h.table.name,
      columns: Object.fromEntries(h.table.columns.map((c) => [c.display, c.name])),
    });
  }
  return { rows, rows_more, tables_waiting, tables };
}
