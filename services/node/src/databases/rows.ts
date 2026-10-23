/**
 * A database's live rows as text, read through the gate for a caller who may read the database: what an
 * agent's recall and its Save to Stuga plan read of a table, the rows the Log names and the rows a check
 * finds gone. Best-effort for the callers that only add to an answer: an actor that fails reads as null.
 */
import type { DocRow } from "@stuga/db";
import type { RowsReadRequest, RowsReadResponse } from "@stuga/protocol/databases/rows-read";
import type { Ctx } from "../auth/context.js";
import { callDatabaseActor } from "./gate.js";

/** The rows `body` asks for, of a database the caller was already let read; null when the actor could not answer. */
export async function readDatabaseRows(ctx: Ctx, doc: Pick<DocRow, "doc_id">, body: RowsReadRequest): Promise<RowsReadResponse | null> {
  try {
    const res = await callDatabaseActor(ctx, doc.doc_id, "rows/read", { ...body });
    if (!res.ok) return null;
    const out = (await res.json().catch(() => null)) as RowsReadResponse | null;
    return out && Array.isArray(out.tables) ? out : null;
  } catch (e) {
    console.warn("[node] a database's rows are unavailable", { docId: doc.doc_id, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Of `refs`, the rows still there, as `<table_id>.<row_id>` with each one's title; null when the actor could not answer. */
export async function existingRows(
  ctx: Ctx,
  docId: string,
  refs: ReadonlyArray<{ table_id: string; row_id: string }>,
): Promise<Map<string, { title: string; table: string }> | null> {
  if (refs.length === 0) return new Map();
  const out = await readDatabaseRows(ctx, { doc_id: docId }, { rows: [...refs], titles_only: true });
  if (!out) return null;
  const there = new Map<string, { title: string; table: string }>();
  for (const t of out.tables) for (const r of t.rows) there.set(`${t.table_id}.${r.row_id}`, { title: r.title, table: t.display });
  return there;
}
