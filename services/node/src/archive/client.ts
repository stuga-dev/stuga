/**
 * The writes an import makes, as the person importing. Each goes through the
 * route the web app calls, so it passes the same gates and lands in the same
 * ledgers. What no route offers in bulk (rows past one write's cap, many row
 * pages at once, a body seeded as it stands, comments with their own times)
 * calls that route's own helper after the checks the route makes.
 */
import { setTimeout as wait } from "node:timers/promises";
import { type DocRow, type ImportedComment, importComments } from "@stuga/db";
import type { SafeImageMime } from "@stuga/protocol/api/media";
import type { DatabaseColumnType, DatabaseSchema, TableSchema, RowValue, ViewSpec } from "@stuga/protocol/databases/types";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { Ctx } from "../auth/context.js";
import { canCommentDoc, canWriteDoc } from "../authz/authz.js";
import { authorizedDatabase } from "../databases/gate.js";
import { insertImportedRows } from "../databases/imports/staging.js";
import { openRowPages } from "../databases/row-pages.js";
import { authorizedDoc, releaseActor } from "../documents/access.js";
import { seedBody } from "../documents/create.js";

/** A column as a create names it. */
export interface ColumnInput {
  name: string;
  type: DatabaseColumnType;
  choices?: string[];
  description?: string;
}

/** A view as a create takes it, naming columns by id. */
export type ViewInput = Pick<ViewSpec, "name" | "kind" | "position" | "filter" | "sorts" | "group_by" | "hidden_columns" | "config">;

/** The settings `PATCH /api/docs/:id/state` takes. */
export interface DocState {
  agent_mode?: ReviewMode;
  locked?: boolean;
  search_hidden?: boolean;
  agent_instructions?: string;
}

export interface ImportClient {
  setWorkspaceInstructions(text: string): Promise<void>;
  /** The new folder's id. */
  createFolder(folder: { title: string; parentId: string | null; agentInstructions: string }): Promise<string>;
  /** A prose document with an empty body; its id. */
  createDoc(doc: { title: string; parentId: string | null }): Promise<string>;
  /** A database and the table every database starts with. */
  createDatabase(db: { title: string; parentId: string | null; table: string; columns: ColumnInput[] }): Promise<{ docId: string; table: TableSchema }>;
  createTable(databaseId: string, table: { display: string; columns: ColumnInput[] }): Promise<TableSchema>;
  deleteTable(databaseId: string, tableId: string): Promise<void>;
  /** Rows by column id, as one write; the new rows' ids in the same order. */
  insertRows(databaseId: string, table: Pick<TableSchema, "table_id" | "display">, rows: Array<Record<string, RowValue>>): Promise<string[]>;
  /** The new view's id. */
  createView(databaseId: string, tableId: string, view: ViewInput): Promise<string>;
  /** A page for each row, none of which has one, linked in one mutation (so at most the actor's batch cap); the pages' ids in the same order. */
  openRowPages(databaseId: string, tableId: string, pages: Array<{ rowId: string; title: string }>): Promise<string[]>;
  /** An image stored in the workspace, as uploaded into `docId`; its SHA-256. */
  uploadImage(docId: string, bytes: Uint8Array, mime: SafeImageMime): Promise<string>;
  /** The whole body of an empty document, as it stands, saved as a version before this returns. */
  seedBody(docId: string, markdown: string): Promise<void>;
  /** A title someone gave the document, which its first line no longer sets. */
  setTitle(docId: string, title: string): Promise<void>;
  importComments(docId: string, comments: ImportedComment[]): Promise<void>;
  setDocState(docId: string, state: DocState): Promise<void>;
  /** The import is done with this document or database for now: its actor may close. */
  release(docId: string, docType: "prose" | "database"): Promise<void>;
}

/** A write the node refused, with its status and what it said. */
export class ImportWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ImportWriteError";
  }
}

/**
 * The database actor budgets each alias's mutations over a sliding minute. A
 * write it refuses for pace is tried once more after a whole minute without
 * any, when the budget is whole again: sooner could be refused again, and a
 * batch of pages is made anew on each try.
 */
const ACTOR_RATE_WAIT_MS = 61_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** How an import's writes are paced, and stopped. */
export interface WriteOptions {
  /** The wait before a write refused for pace is tried again. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Once aborted, no write is sent, and a wait for one ends at once. */
  signal?: AbortSignal;
}

/** `attempt`'s value; one the database actor refused for pace is tried once more after ACTOR_RATE_WAIT_MS. */
function pacer(opts: WriteOptions): <T>(what: string, attempt: () => Promise<Outcome<T>>) => Promise<T> {
  const sleep = opts.sleep ?? ((ms: number, signal?: AbortSignal) => wait(ms, undefined, { signal }));
  return async (what, attempt) => {
    opts.signal?.throwIfAborted();
    let out = await attempt();
    if (!out.ok && out.status === 429) {
      await sleep(ACTOR_RATE_WAIT_MS, opts.signal);
      opts.signal?.throwIfAborted();
      out = await attempt();
    }
    if (out.ok) return out.value;
    throw new ImportWriteError(out.status, `${what}: ${out.message}`);
  };
}

async function route<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Outcome<T>> {
  // Imported here: the route table reaches this module through the workspace routes.
  const { routeWorkspaceRequest } = await import("../http/dispatch.js");
  const init: RequestInit =
    body instanceof FormData
      ? { method, body }
      : { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const res = await routeWorkspaceRequest(ctx, new Request(`http://node.internal${path}`, init));
  const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && answer) return { ok: true, value: answer as T };
  const message = typeof answer?.error === "string" ? answer.error : `answered ${res.status}`;
  return { ok: false, status: res.ok ? 502 : res.status, message };
}

/** Calls to the web app's workspace routes as `ctx`, each paced as an import's writes are; the answer's JSON. */
export function routeCaller(ctx: Ctx, opts: WriteOptions = {}): <T>(method: string, path: string, body?: unknown) => Promise<T> {
  const paced = pacer(opts);
  return (method, path, body) => paced(`${method} ${path}`, () => route(ctx, method, path, body));
}

const enc = encodeURIComponent;

/** The writes of an import into the workspace `ctx` names, as the person `ctx` is. */
export function workspaceImportClient(ctx: Ctx, opts: WriteOptions = {}): ImportClient {
  const paced = pacer(opts);
  const call = routeCaller(ctx, opts);

  /** A database this person may write, as the database routes' write gate decides. */
  async function writableDatabase(id: string): Promise<DocRow> {
    const doc = await authorizedDatabase(ctx, id);
    if (!doc) throw new ImportWriteError(404, `database ${id}: not found`);
    if (!canWriteDoc(ctx, doc) || doc.locked) throw new ImportWriteError(403, `database ${id}: not writable`);
    return doc;
  }

  return {
    async setWorkspaceInstructions(text) {
      await call("PATCH", `/api/workspaces/${enc(ctx.workspaceId)}`, { agent_instructions: text });
    },
    async createFolder(folder) {
      const body = { title: folder.title, parent_id: folder.parentId, agent_instructions: folder.agentInstructions };
      return (await call<{ folder_id: string }>("POST", "/api/folders", body)).folder_id;
    },
    async createDoc(doc) {
      return (await call<DocRow>("POST", "/api/docs", { title: doc.title, doc_type: "prose", parent_id: doc.parentId })).doc_id;
    },
    async createDatabase(db) {
      const body = { title: db.title, doc_type: "database", parent_id: db.parentId, table: db.table, columns: db.columns };
      const doc = await call<DocRow>("POST", "/api/docs", body);
      const schema = await call<DatabaseSchema>("GET", `/api/databases/${enc(doc.doc_id)}/schema`);
      const table = schema.tables[0];
      if (!table) throw new ImportWriteError(502, `database ${doc.doc_id}: created without a table`);
      return { docId: doc.doc_id, table };
    },
    async createTable(databaseId, table) {
      return (await call<{ table: TableSchema }>("POST", `/api/databases/${enc(databaseId)}/tables`, table)).table;
    },
    async deleteTable(databaseId, tableId) {
      await call("DELETE", `/api/databases/${enc(databaseId)}/tables/${enc(tableId)}`);
    },
    async insertRows(databaseId, table, rows) {
      const doc = await writableDatabase(databaseId);
      return paced(`rows of ${table.table_id}`, async () => {
        const out = await insertImportedRows(ctx, doc, table, rows);
        return out.ok ? { ok: true, value: out.row_ids } : out;
      });
    },
    async createView(databaseId, tableId, view) {
      return (await call<{ view: ViewSpec }>("POST", `/api/databases/${enc(databaseId)}/tables/${enc(tableId)}/views`, view)).view.view_id;
    },
    async openRowPages(databaseId, tableId, pages) {
      const db = await writableDatabase(databaseId);
      return paced(`pages of ${tableId}`, async () => {
        const out = await openRowPages(ctx, db, tableId, pages);
        return out.kind === "ok" ? { ok: true, value: out.doc_ids } : { ok: false, status: out.status, message: out.message };
      });
    },
    async uploadImage(docId, bytes, mime) {
      const form = new FormData();
      form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
      return (await call<{ hash: string }>("POST", `/api/docs/${enc(docId)}/media`, form)).hash;
    },
    async seedBody(docId, markdown) {
      const doc = await authorizedDoc(ctx, docId);
      if (!doc || doc.doc_type !== "prose") throw new ImportWriteError(404, `document ${docId}: not found`);
      if (!canWriteDoc(ctx, doc) || doc.locked) throw new ImportWriteError(403, `document ${docId}: not writable`);
      if (!(await seedBody(ctx, docId, markdown, { flush: true }))) throw new ImportWriteError(502, `document ${docId}: could not write the body`);
    },
    async setTitle(docId, title) {
      await call("PATCH", `/api/docs/${enc(docId)}`, { title });
    },
    async importComments(docId, comments) {
      const doc = await authorizedDoc(ctx, docId);
      if (!doc) throw new ImportWriteError(404, `document ${docId}: not found`);
      if (!canCommentDoc(ctx, doc)) throw new ImportWriteError(403, `document ${docId}: no comment access`);
      await importComments(ctx.sql, docId, comments);
    },
    async setDocState(docId, state) {
      await call("PATCH", `/api/docs/${enc(docId)}/state`, state);
    },
    async release(docId, docType) {
      await releaseActor(ctx.env, docId, docType);
    },
  };
}
