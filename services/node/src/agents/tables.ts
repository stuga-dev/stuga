/**
 * The tables an agent reads for Save to Stuga and Ask Stuga: the databases a text's words reach, gated by
 * the caller's reach as a search is (tenant, trash, kept out of search, ACL, a key's folders, a collection),
 * their live rows as text, and the changes that wait for those rows. A person's own waiting changes are
 * read whole, to tell as they would land; anyone else's are counted for the whole database from the run
 * index, never read. Nothing here reaches a database the caller cannot read.
 */
import { databasesByWords, databasesWaitingFor, getDoc, type DocRow, type WaitingRun, waitingRuns } from "@stuga/db";
import type { RowsReadResponse } from "@stuga/protocol/databases/rows-read";
import type { DatabaseRunSummary, RowValue } from "@stuga/protocol/databases/types";
import type { WaitsFor } from "@stuga/agent-surface/backend";
import type { Ctx } from "../auth/context.js";
import { canReadDoc, canWriteDoc, personOf, scopeFolderIds } from "../authz/authz.js";
import { effectiveReviewLevel } from "../authz/review-mode.js";
import { callDatabaseActor } from "../databases/gate.js";
import { readDatabaseRows } from "../databases/rows.js";
import { waitsFor } from "../mcp/waiting.js";

/** The user's own waiting runs on one database read for their changes, the latest: each change is a run of its own. */
const OWN_RUNS_READ_MAX = 100;

/** What one call reads once, however many points or databases need it. */
export interface TableCache {
  /** A database's rows, read whole: every point of a plan reads them again from here. */
  whole: Map<string, Promise<RowsReadResponse | null>>;
  waiting: Map<string, Promise<WaitingOnRows>>;
}

export function tableCache(): TableCache {
  return { whole: new Map(), waiting: new Map() };
}

/**
 * The databases `query`'s words reach that the caller can read, best first, at most `limit`; then, up to as
 * many again, those where changes the user asked for wait, whose new rows no word of the approved table names
 * yet. With `writable`, only those they can change. Out of the trash, not kept out of search, within a key's
 * folders and `scopeDocIds`.
 */
export async function databasesFor(
  ctx: Ctx,
  query: string,
  opts: { limit: number; scopeDocIds?: string[] | null; writable?: boolean },
): Promise<DocRow[]> {
  const scope = scopeFolderIds(ctx);
  const [found, waiting] = await Promise.all([
    databasesByWords(ctx.sql, {
      principals: ctx.principals,
      workspaceId: ctx.workspaceId,
      query,
      scopeDocIds: opts.scopeDocIds ?? null,
      scopeFolderIds: scope,
      searchLanguages: () => ctx.env.searchLanguages.current(),
      limit: opts.limit * 2,
    }),
    databasesWaitingFor(ctx.sql, ctx.workspaceId, personOf(ctx), opts.limit),
  ]);
  const usable = async (docId: string): Promise<DocRow | null> => {
    const doc = await getDoc(ctx.sql, docId);
    if (!doc || doc.trashed || doc.search_hidden || doc.doc_type !== "database" || doc.workspace_id !== ctx.workspaceId || !canReadDoc(ctx, doc)) return null;
    if (opts.scopeDocIds && !opts.scopeDocIds.includes(doc.doc_id)) return null;
    if (opts.writable && (!canWriteDoc(ctx, doc) || doc.locked)) return null;
    return doc;
  };
  const out: DocRow[] = [];
  for (const f of found) {
    if (out.length >= opts.limit) break;
    const doc = await usable(f.doc_id);
    if (doc) out.push(doc);
  }
  for (const docId of waiting) {
    if (out.some((d) => d.doc_id === docId)) continue;
    const doc = await usable(docId);
    if (doc) out.push(doc);
  }
  return out;
}

/**
 * A database's rows for a text: read whole when it holds no more than one read gives, and kept for the rest of
 * the call; else the rows holding one of `needles`, as the grid's search finds them.
 */
export async function rowsFor(ctx: Ctx, cache: TableCache, doc: DocRow, needles: readonly string[]): Promise<RowsReadResponse | null> {
  const kept = cache.whole.get(doc.doc_id);
  if (kept) {
    const whole = await kept;
    if (whole && !whole.tables.some((t) => t.partial)) return whole;
  }
  const read = readDatabaseRows(ctx, doc, { needles: [...needles] });
  if (!kept) cache.whole.set(doc.doc_id, read);
  return read;
}

/** One of the user's own waiting changes to a row, and whom it waits for. */
export interface RowWait {
  run: WaitingRun;
  waits: WaitsFor;
  change: { kind: "update"; values: Record<string, RowValue> } | { kind: "delete" };
}

/** A row the user's own waiting change would add. */
export interface RowAdded {
  run: WaitingRun;
  waits: WaitsFor;
  table_id: string;
  row_id: string;
  values: Record<string, RowValue>;
}

/** Changes other people asked for that wait in the database, counted by whom they wait for. */
export interface OthersWaiting {
  waits: WaitsFor;
  changes: number;
  since: string;
}

export interface WaitingOnRows {
  /** The user's own, by `<table_id>.<row_id>`, oldest run first. */
  byRow: Map<string, RowWait[]>;
  /** Rows the user's own waiting changes would add; another person's new rows are nobody's to see yet. */
  added: RowAdded[];
  /**
   * Everyone else's, counted for the whole database, as a reader who may not decide them is told of a run:
   * which rows they touch is for whoever asked and whoever decides.
   */
  others: OthersWaiting[];
}

/** The changes that wait for a database's rows, once per call. Best-effort: a run whose changes cannot be read is left out. */
export function waitingOnRows(ctx: Ctx, cache: TableCache, doc: DocRow): Promise<WaitingOnRows> {
  let kept = cache.waiting.get(doc.doc_id);
  if (!kept) {
    kept = readWaiting(ctx, doc);
    cache.waiting.set(doc.doc_id, kept);
  }
  return kept;
}

async function readWaiting(ctx: Ctx, doc: DocRow): Promise<WaitingOnRows> {
  const out: WaitingOnRows = { byRow: new Map(), added: [], others: [] };
  try {
    const runs = (await waitingRuns(ctx.sql, ctx.workspaceId, [doc.doc_id])).get(doc.doc_id) ?? [];
    const person = personOf(ctx);
    const itemNow = effectiveReviewLevel(doc);
    // Another person's runs are counted from the run index, never read: their rows are not the caller's to know.
    const others = new Map<WaitsFor, OthersWaiting>();
    for (const run of runs) {
      if (run.reviewer === person) continue;
      const waits = waitsFor(run.review_mode, itemNow);
      const group = others.get(waits) ?? { waits, changes: 0, since: run.created_at };
      group.changes += run.pending;
      if (run.created_at < group.since) group.since = run.created_at;
      others.set(waits, group);
    }
    out.others = (["colleague", "review"] as const).flatMap((w) => (others.get(w)?.changes ? [others.get(w)!] : []));
    // The user's own are read whole, the latest first when there are more than one call reads.
    const own = runs.filter((r) => r.reviewer === person).slice(-OWN_RUNS_READ_MAX);
    await Promise.all(
      own.map(async (run) => {
        const res = await callDatabaseActor(ctx, doc.doc_id, `runs/detail?runId=${encodeURIComponent(run.run_id)}&full=1`, null, "GET");
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { run?: DatabaseRunSummary } | null;
        const waits = waitsFor(run.review_mode, itemNow);
        for (const op of body?.run?.ops ?? []) {
          if (op.status !== "pending" || !op.payload) continue;
          const p = op.payload;
          if (p.kind === "rows.update") {
            for (const u of p.updates) add(out, `${p.table_id}.${u._id}`, { run, waits, change: { kind: "update", values: u.values } });
          } else if (p.kind === "rows.delete") {
            for (const id of p.row_ids) add(out, `${p.table_id}.${id}`, { run, waits, change: { kind: "delete" } });
          } else if (p.kind === "rows.insert") {
            p.rows.forEach((values, i) => out.added.push({ run, waits, table_id: p.table_id, row_id: p.row_ids[i]!, values }));
          }
        }
      }),
    );
    for (const list of out.byRow.values()) list.sort((a, b) => a.run.created_at.localeCompare(b.run.created_at));
  } catch (e) {
    console.warn("[node] the changes waiting in a database are unavailable", { docId: doc.doc_id, err: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

function add(out: WaitingOnRows, key: string, wait: RowWait): void {
  out.byRow.set(key, [...(out.byRow.get(key) ?? []), wait]);
}
