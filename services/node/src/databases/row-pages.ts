/**
 * Row pages: a prose document created the first time a row is opened and linked
 * to it in the actor. The link is the actor's and the document is Postgres's;
 * the actor's inbox of row deletes and restores is the one bridge, read after
 * every route that can change rows.
 */
import type { OwnGrants } from "@stuga/auth";
import { type DocRow, detachPage, docTrashStates, getDoc, listPagesOf, updateDoc } from "@stuga/db";
import { DATABASE_MAX_DISPLAY_LENGTH, DATABASE_MAX_ROWS_PER_WRITE } from "@stuga/protocol/databases/limits";
import type { ColumnSpec, DatabaseSchema } from "@stuga/protocol/databases/types";
import { recordAudit, recordEvent } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canWriteDoc, READ_ONLY_MESSAGE } from "../authz/authz.js";
import { createProseDoc, discardCreatedDoc } from "../documents/create.js";
import { actorRefusalStatus, afterDatabaseMutation, callDatabaseActor } from "./gate.js";

/** One row → page link as the actor reports it. */
interface RowDocLink {
  doc_id: string;
  row_id: string;
  table_id: string;
}

/** A new page's title: the row's first text column, else a placeholder. Taken once; the two never sync. */
export function rowPageTitle(columns: ColumnSpec[], row: Record<string, unknown>): string {
  for (const col of [...columns].sort((a, b) => a.position - b.position)) {
    if (col.type !== "text") continue;
    const v = row[col.column_id];
    if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, DATABASE_MAX_DISPLAY_LENGTH);
  }
  return "Untitled row";
}

/**
 * A new page's direct grants: the database's own, plus the database's owner as
 * a writer, so a page a collaborator creates stays open to that owner.
 */
function pageGrantsOf(db: DocRow): OwnGrants {
  const own = db.own_grants;
  return { p: [...own.p, db.owner], w: [...own.w, db.owner], c: [...own.c] };
}

export type OpenRowPageOutcome =
  | { kind: "ok"; doc_id: string; created: boolean; restored: boolean }
  | { kind: "error"; status: number; message: string };

function pageRefusal(res: Response, body: { message?: string } | null, fallback: string): OpenRowPageOutcome {
  return { kind: "error", status: actorRefusalStatus(res), message: body?.message ?? fallback };
}

/** The table and row a page link names (`<table>.<row>`). */
function linkOf(page: { doc_id: string; page_row: string | null }): RowDocLink {
  const [table_id = "", row_id = ""] = (page.page_row ?? "").split(".");
  return { doc_id: page.doc_id, table_id, row_id };
}

/** Why this caller may not restore or create a row's page, or null. */
function pageWriteRefusal(ctx: Ctx, db: DocRow): OpenRowPageOutcome | null {
  if (ctx.scope?.readOnly) return { kind: "error", status: 403, message: READ_ONLY_MESSAGE };
  if (!canWriteDoc(ctx, db)) return { kind: "error", status: 403, message: "view-only access" };
  if (db.locked) return { kind: "error", status: 423, message: "this document is locked; unlock it to make changes" };
  if (ctx.role === "guest") return { kind: "error", status: 403, message: "guests cannot create pages in this workspace" };
  return null;
}

type PageRefusal = Extract<OpenRowPageOutcome, { kind: "error" }>;

/** The live row, never an agent's projection: a proposed row has no page. */
async function liveRow(ctx: Ctx, doc: DocRow, tableId: string, rowId: string): Promise<{ row: Record<string, unknown> } | { refused: PageRefusal }> {
  const listed = await callDatabaseActor(ctx, doc.doc_id, "rows/list", {
    table_id: tableId,
    filter: { column_id: "_id", op: "eq", value: rowId },
    limit: 1,
  });
  if (!listed.ok) {
    return { refused: pageRefusal(listed, (await listed.json().catch(() => null)) as { message?: string } | null, "could not read the row") as PageRefusal };
  }
  const page = (await listed.json().catch(() => null)) as { rows?: Array<Record<string, unknown>> } | null;
  const row = page?.rows?.[0];
  return row ? { row } : { refused: { kind: "error", status: 404, message: "no such row (a row still awaiting review has no page yet)" } };
}

/** The live page a row has, or null: a read, so a page in the trash or gone counts as none and nothing is made. */
export async function findRowPage(
  ctx: Ctx,
  doc: DocRow,
  tableId: string,
  rowId: string,
): Promise<{ kind: "ok"; doc_id: string | null } | PageRefusal> {
  const found = await liveRow(ctx, doc, tableId, rowId);
  if ("refused" in found) return found.refused;
  const linked = typeof found.row._doc_id === "string" && found.row._doc_id !== "" ? found.row._doc_id : null;
  if (!linked) return { kind: "ok", doc_id: null };
  const pageDoc = await getDoc(ctx.sql, linked);
  return { kind: "ok", doc_id: pageDoc && !pageDoc.trashed && pageDoc.workspace_id === ctx.workspaceId ? linked : null };
}

/**
 * Open a row's page: the one it has, restored from the trash if need be, or a
 * new document filed beside the database with its sharing and linked to the
 * row. Handing back a live page only reads, so anyone who can read the
 * database gets it; restoring and creating are writes. `replaceTrashed` gives a
 * row whose page is in the trash a new page instead of restoring that one.
 */
export async function openRowPage(
  ctx: Ctx,
  doc: DocRow,
  tableId: string,
  rowId: string,
  opts: { replaceTrashed?: boolean } = {},
): Promise<OpenRowPageOutcome> {
  const found = await liveRow(ctx, doc, tableId, rowId);
  if ("refused" in found) return found.refused;
  const { row } = found;

  const existing = typeof row._doc_id === "string" && row._doc_id !== "" ? row._doc_id : null;
  if (existing) {
    const pageDoc = await getDoc(ctx.sql, existing);
    if (pageDoc && pageDoc.workspace_id === ctx.workspaceId) {
      if (!pageDoc.trashed) return { kind: "ok", doc_id: existing, created: false, restored: false };
      if (!opts.replaceTrashed) return restoreRowPage(ctx, doc, pageDoc, tableId, rowId);
    }
    // Deleted for good, or in the trash with a new page asked for: a new page takes over the link.
  }
  const refused = pageWriteRefusal(ctx, doc);
  if (refused) return refused;

  const schemaRes = await callDatabaseActor(ctx, doc.doc_id, "schema", null, "GET");
  const schema = schemaRes.ok ? ((await schemaRes.json().catch(() => null)) as DatabaseSchema | null) : null;
  const table = schema?.tables.find((t) => t.table_id === tableId);
  if (!table) return { kind: "error", status: 502, message: "could not load the database schema" };

  const pageDoc = await createProseDoc(ctx, {
    title: rowPageTitle(table.columns, row),
    parentId: doc.parent_id,
    ownGrants: pageGrantsOf(doc),
    inheritsPerms: doc.inherits_perms,
    page: { of: doc.doc_id, row: `${tableId}.${rowId}` },
    detail: { database_id: doc.doc_id, table_id: tableId, row_id: rowId, ...(existing ? { replaces: existing } : {}) },
  });
  const linked = await callDatabaseActor(ctx, doc.doc_id, "rows/link-doc", {
    table_id: tableId,
    row_id: rowId,
    doc_id: pageDoc.doc_id,
    ...(existing ? { replaces: existing } : {}),
  });
  if (!linked.ok) {
    // The row got a page from someone else meanwhile, or vanished: drop ours and hand over theirs, if any.
    await discardCreatedDoc(ctx, pageDoc);
    const body = (await linked.json().catch(() => null)) as { message?: string; doc_id?: string } | null;
    if (linked.status === 409 && typeof body?.doc_id === "string") return { kind: "ok", doc_id: body.doc_id, created: false, restored: false };
    return pageRefusal(linked, body, "could not link the page");
  }
  // A replaced page left in the trash stops naming the row, so restoring it
  // brings back an ordinary document rather than a second page nobody can
  // reach. Best-effort: the new page is already the row's.
  if (existing) await detachPage(ctx.sql, ctx.workspaceId, doc.doc_id, existing).catch(() => undefined);
  await afterDatabaseMutation(ctx, doc, `Created a page for a row.`);
  return { kind: "ok", doc_id: pageDoc.doc_id, created: true, restored: false };
}

/**
 * New pages for many rows that have none, titled by the caller: filed and
 * shared as openRowPage files one, and linked a batch at a time in one
 * mutation each, so a bulk import does not spend the actor's per-alias budget
 * one page at a time. A batch that cannot be linked discards its pages and
 * fails the call; pages linked before it stay. The ids come back in order.
 */
export async function openRowPages(
  ctx: Ctx,
  db: DocRow,
  tableId: string,
  pages: Array<{ rowId: string; title: string }>,
): Promise<{ kind: "ok"; doc_ids: string[] } | PageRefusal> {
  const refused = pageWriteRefusal(ctx, db);
  if (refused) return refused as PageRefusal;
  const docIds: string[] = [];
  for (let at = 0; at < pages.length; at += DATABASE_MAX_ROWS_PER_WRITE) {
    const batch = pages.slice(at, at + DATABASE_MAX_ROWS_PER_WRITE);
    const created: DocRow[] = [];
    for (const page of batch) {
      created.push(
        await createProseDoc(ctx, {
          title: page.title.trim().slice(0, DATABASE_MAX_DISPLAY_LENGTH) || "Untitled row",
          parentId: db.parent_id,
          ownGrants: pageGrantsOf(db),
          inheritsPerms: db.inherits_perms,
          page: { of: db.doc_id, row: `${tableId}.${page.rowId}` },
          detail: { database_id: db.doc_id, table_id: tableId, row_id: page.rowId },
        }),
      );
    }
    const linked = await callDatabaseActor(ctx, db.doc_id, "rows/link-docs", {
      table_id: tableId,
      links: batch.map((page, i) => ({ row_id: page.rowId, doc_id: created[i]!.doc_id })),
    });
    if (!linked.ok) {
      for (const doc of created) await discardCreatedDoc(ctx, doc);
      return pageRefusal(linked, (await linked.json().catch(() => null)) as { message?: string } | null, "could not link the pages") as PageRefusal;
    }
    docIds.push(...created.map((doc) => doc.doc_id));
    await afterDatabaseMutation(ctx, db, `Created ${batch.length} page${batch.length === 1 ? "" : "s"} for rows.`);
  }
  return { kind: "ok", doc_ids: docIds };
}

/** Bring a row's page back out of the trash, as the row's page. */
async function restoreRowPage(ctx: Ctx, db: DocRow, page: DocRow, tableId: string, rowId: string): Promise<OpenRowPageOutcome> {
  const refused = pageWriteRefusal(ctx, db);
  if (refused) return refused;
  // A lock freezes the trash state too.
  if (page.locked) return { kind: "error", status: 423, message: "this row's page is locked in the trash; unlock it to restore it" };
  const restored = await updateDoc(ctx.sql, page.doc_id, { trashed: false });
  if (restored) {
    recordAudit(ctx, {
      action: "doc.restore",
      targetKind: "doc",
      targetId: page.doc_id,
      targetLabel: restored.title,
      detail: { database_id: db.doc_id, table_id: tableId, row_id: rowId, reason: "row opened" },
    });
  }
  return { kind: "ok", doc_id: page.doc_id, created: false, restored: true };
}

/**
 * Lay Postgres's view of each linked page over an actor listing: a trashed page
 * is marked `_doc_trashed`, a deleted one becomes `_doc_id: null`. A failed
 * lookup leaves the listing as the actor gave it.
 */
export async function annotateRowPages(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<void> {
  const ids = [...new Set(rows.map((r) => r._doc_id).filter((id): id is string => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return;
  let states: Map<string, boolean>;
  try {
    states = new Map((await docTrashStates(ctx.sql, ctx.workspaceId, ids)).map((s) => [s.doc_id, s.trashed]));
  } catch {
    return;
  }
  for (const row of rows) {
    const id = row._doc_id;
    if (typeof id !== "string" || id === "") continue;
    const trashed = states.get(id);
    if (trashed === undefined) row._doc_id = null;
    else if (trashed) row._doc_trashed = true;
  }
}

/** Why a page moved, for the ledger. */
type PageMoveReason = "row deleted" | "row restored" | "database trashed" | "database restored" | "database deleted";

/** Move pages to the trash or back, skipping one that is gone, in another workspace, already there, or locked. */
async function setPagesTrashed(ctx: Ctx, db: DocRow, links: RowDocLink[], trashed: boolean, reason: PageMoveReason): Promise<void> {
  for (const link of links) {
    const page = await getDoc(ctx.sql, link.doc_id).catch(() => null);
    if (!page || page.workspace_id !== ctx.workspaceId || page.trashed === trashed || page.locked) continue;
    const updated = await updateDoc(ctx.sql, link.doc_id, { trashed }).catch(() => null);
    if (!updated) continue;
    if (trashed) recordEvent(ctx, "doc.trashed", link.doc_id, { title: updated.title, doc_type: updated.doc_type });
    recordAudit(ctx, {
      action: trashed ? "doc.trash" : "doc.restore",
      targetKind: "doc",
      targetId: link.doc_id,
      targetLabel: updated.title,
      detail: {
        database_id: db.doc_id,
        table_id: link.table_id,
        row_id: link.row_id,
        reason,
      },
    });
  }
}

/**
 * Act on the actor's inbox: pages of deleted rows go to the trash, pages of
 * restored rows come back. Best-effort: a note that could not be acted on is
 * gone with the take, and nothing here fails the write it follows.
 */
export async function reconcileDocLinks(ctx: Ctx, doc: DocRow): Promise<void> {
  const res = await callDatabaseActor(ctx, doc.doc_id, "doc-links/take", {}).catch(() => null);
  if (!res || !res.ok) return;
  const inbox = (await res.json().catch(() => null)) as { trash?: RowDocLink[]; restore?: RowDocLink[] } | null;
  if (!inbox) return;
  await setPagesTrashed(ctx, doc, inbox.trash ?? [], true, "row deleted");
  await setPagesTrashed(ctx, doc, inbox.restore ?? [], false, "row restored");
}

/** A database's pages go to the trash when it does, and before it is deleted for good. */
export async function trashDatabasePages(ctx: Ctx, doc: DocRow, reason: "database trashed" | "database deleted"): Promise<void> {
  const pages = await listPagesOf(ctx.sql, ctx.workspaceId, doc.doc_id).catch(() => []);
  await setPagesTrashed(ctx, doc, pages.map(linkOf), true, reason);
}

/**
 * The pages that went into the trash with a database, asked before it is
 * restored, since the restore clears the `trashed_at` they are compared with.
 * A failed lookup restores no pages.
 */
export async function pagesTrashedWithDatabase(ctx: Ctx, doc: DocRow): Promise<RowDocLink[]> {
  const pages = await listPagesOf(ctx.sql, ctx.workspaceId, doc.doc_id, { trashed: true, trashedWithDatabase: true }).catch(
    () => [],
  );
  return pages.map(linkOf);
}

/** Bring back the pages pagesTrashedWithDatabase found; a page trashed on its own stays where it is. */
export async function restoreDatabasePages(ctx: Ctx, doc: DocRow, pages: RowDocLink[]): Promise<void> {
  await setPagesTrashed(ctx, doc, pages, false, "database restored");
}
