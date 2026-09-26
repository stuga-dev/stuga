/**
 * Staged imports: a caller stages a CSV/JSONL file on the node, which validates
 * every row and lands it as one reviewable rows.insert. Three keys per import in
 * the snapshots store, under one prefix so a single listing sweeps them all:
 *   db-imports/<docId>/<importId>.meta   who staged it, for which table
 *   db-imports/<docId>/<importId>.body   the bytes
 *   db-imports/<docId>/<importId>.done   the result, so a replayed commit is a no-op
 */
import type { DocRow } from "@stuga/db";
import {
  DATABASE_IMPORT_INLINE_MAX_CHARS,
  DATABASE_IMPORT_MAX_BYTES,
  DATABASE_IMPORT_MAX_ERRORS,
} from "@stuga/protocol/databases/limits";
import {
  type ColumnSpec,
  DATABASE_IMPORT_FORMATS,
  type DatabaseImportCheck,
  type DatabaseImportFormat,
  type DatabaseImportResult,
  type DatabaseImportTicket,
  type DatabaseRunSource,
  type DatabaseRunSummary,
  type RowValue,
  type TableSchema,
} from "@stuga/protocol/databases/types";
import type { Ctx } from "../../auth/context.js";
import { resolveReviewMode } from "../../authz/review-mode.js";
import { actorRefusalStatus, afterDatabaseMutation, callDatabaseActor, findTable, projectedSchema } from "../gate.js";
import {
  type DateOrder,
  csvToTable,
  importExpiry,
  jsonlToTable,
  mapHeaders,
  newImportId,
  signUpload,
  validateImportRows,
  verifyUpload,
} from "./format.js";
import { proposeDatabaseOp } from "../propose.js";
import type { NodeEnv } from "../../env.js";
import { error, json } from "../../http/respond.js";

interface ImportMeta {
  import_id: string;
  table_id: string;
  format: DatabaseImportFormat;
  created_by: string;
  created_at: number;
  expires_at: number;
}

interface ImportDone {
  import_id: string;
  mode: "proposed" | "applied";
  rows_total: number;
  rows_ingested: number;
  rows_skipped: number;
  run_id?: string;
}

const IMPORTS_PREFIX = "db-imports/";

const importKey = (docId: string, importId: string, part: "meta" | "body" | "done"): string =>
  `${IMPORTS_PREFIX}${docId}/${importId}.${part}`;

async function readImportJson<T>(env: NodeEnv, key: string): Promise<T | null> {
  const obj = await env.snapshots.get(key).catch(() => null);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as T;
  } catch {
    return null;
  }
}

/** Delete every expired staging on the node, across all databases. Returns how many keys went. */
export async function sweepExpiredImports(env: Pick<NodeEnv, "snapshots">, now: number): Promise<number> {
  let swept = 0;
  let cursor: string | undefined;
  do {
    const page = await env.snapshots.list({ prefix: IMPORTS_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    const stale = page.objects
      .map((o) => o.key)
      .filter((key) => {
        const id = (key.split("/")[2] ?? "").replace(/\.(meta|body|done)$/, "");
        const exp = importExpiry(id);
        return exp !== null && exp < now;
      });
    if (stale.length > 0) await env.snapshots.delete(stale);
    swept += stale.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return swept;
}

interface CommitImportOptions {
  columnMap: Record<string, string | null>;
  onError: "abort" | "skip_bad_rows";
  maxBadRows: number;
  /** Day/month order for ambiguous `1/4/26` dates; inferred per column when unset. */
  dateOrder?: DateOrder;
  /** Validate and report only; write nothing, keep the staging. */
  dryRun?: boolean;
}

/** Shape-check a commit body; every field is optional. */
export function parseCommitOptions(b: Record<string, unknown>): CommitImportOptions | { error: string } {
  const columnMap: Record<string, string | null> = {};
  if (b.column_map !== undefined) {
    if (b.column_map === null || typeof b.column_map !== "object" || Array.isArray(b.column_map)) {
      return { error: "column_map must be an object of file header → column (or null to skip the header)" };
    }
    for (const [k, v] of Object.entries(b.column_map as Record<string, unknown>)) {
      if (v !== null && typeof v !== "string") return { error: `column_map["${k}"] must be a column name or null` };
      columnMap[k] = v;
    }
  }
  const onError = b.on_error === undefined ? "abort" : b.on_error;
  if (onError !== "abort" && onError !== "skip_bad_rows") return { error: "on_error must be abort or skip_bad_rows" };
  const maxBadRows = b.max_bad_rows === undefined ? Number.POSITIVE_INFINITY : Number(b.max_bad_rows);
  if (!(Number.isInteger(maxBadRows) || maxBadRows === Number.POSITIVE_INFINITY) || maxBadRows < 0) {
    return { error: "max_bad_rows must be a non-negative integer" };
  }
  const dateOrder = b.date_order;
  if (dateOrder !== undefined && dateOrder !== "mdy" && dateOrder !== "dmy") return { error: "date_order must be mdy or dmy" };
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") return { error: "dry_run must be true or false" };
  return { columnMap, onError, maxBadRows, ...(dateOrder ? { dateOrder } : {}), ...(b.dry_run === true ? { dryRun: true } : {}) };
}

/** The web app's Import dialog for one table. The table is always named, so the link keeps its meaning when a second one appears. */
export function importPageUrl(origin: string, docId: string, tableId: string): string {
  return `${origin}/doc/${encodeURIComponent(docId)}?table=${encodeURIComponent(tableId)}&import`;
}

/**
 * Reserve an import: resolve the table, record who is staging it, and hand back
 * the signed single-use upload URL, which is the whole credential for the upload.
 */
export async function createDatabaseImport(
  ctx: Ctx,
  doc: DocRow,
  tableRef: unknown,
  formatRaw: unknown,
): Promise<{ ticket: DatabaseImportTicket } | { status: number; error: string }> {
  const format = formatRaw === undefined ? "csv" : formatRaw;
  if (typeof format !== "string" || !(DATABASE_IMPORT_FORMATS as readonly string[]).includes(format)) {
    return { status: 400, error: `format must be one of ${DATABASE_IMPORT_FORMATS.join(", ")}` };
  }
  if (typeof tableRef !== "string" || tableRef === "") return { status: 400, error: "table_id is required" };
  const schema = await projectedSchema(ctx, doc.doc_id);
  if (!schema) return { status: 502, error: "could not load the database schema" };
  const found = findTable(schema, tableRef);
  if ("error" in found) return found;
  const table = found.table;
  const now = Date.now();
  const importId = newImportId(now);
  const meta: ImportMeta = {
    import_id: importId,
    table_id: table.table_id,
    format: format as DatabaseImportFormat,
    created_by: ctx.alias,
    created_at: now,
    expires_at: importExpiry(importId)!,
  };
  await ctx.env.snapshots.put(importKey(doc.doc_id, importId, "meta"), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  const sig = signUpload(ctx.env.internalSecret, doc.doc_id, importId);
  const uploadPath = `/api/databases/${encodeURIComponent(doc.doc_id)}/imports/${importId}/upload?sig=${sig}`;
  const review = ctx.isAgent ? resolveReviewMode(ctx, doc).mode : "direct";
  return {
    ticket: {
      import_id: importId,
      table_id: table.table_id,
      format: meta.format,
      upload_url: `${ctx.env.publicOrigin}${uploadPath}`,
      upload_path: uploadPath,
      upload_method: "PUT",
      max_bytes: Math.min(DATABASE_IMPORT_MAX_BYTES, ctx.env.settings.current().maxBodyBytes),
      expires_at: new Date(meta.expires_at).toISOString(),
      review,
      import_page_url: importPageUrl(ctx.env.publicOrigin, doc.doc_id, table.table_id),
    },
  };
}

/** `PUT …/imports/:importId/upload?sig=…`, answered without a bearer: the signature grants one write of one blob. */
export async function handleDatabaseImportUpload(
  env: NodeEnv,
  req: Request,
  docId: string,
  importId: string,
  sig: string | null,
): Promise<Response> {
  if (!verifyUpload(env.internalSecret, docId, importId, sig)) {
    return error(403, "invalid upload signature");
  }
  const exp = importExpiry(importId);
  if (exp === null || exp < Date.now()) return error(410, "this import has expired — stage a new one");
  const meta = await readImportJson<ImportMeta>(env, importKey(docId, importId, "meta"));
  if (!meta) return error(404, "no such import");
  const bodyKey = importKey(docId, importId, "body");
  if (await env.snapshots.head(bodyKey).catch(() => null)) {
    return error(409, "this import already has a file — stage a new import to upload another");
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  const max = Math.min(DATABASE_IMPORT_MAX_BYTES, env.settings.current().maxBodyBytes);
  if (bytes.byteLength === 0) return error(400, "the uploaded file is empty");
  if (bytes.byteLength > max) return error(413, `file too large (max ${Math.floor(max / (1024 * 1024))} MB)`);
  await env.snapshots.put(bodyKey, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return json({ import_id: importId, bytes: bytes.byteLength }, { status: 201 });
}

/**
 * Inline staging: the file's text arrives in the tool call itself. Bounded,
 * because every byte costs a model turn; larger files go through the person
 * (import_page_url).
 */
export async function stageInlineImport(
  ctx: Ctx,
  doc: DocRow,
  importId: string,
  content: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = ctx.env;
  const refuse = (status: number, message: string) => ({ status, body: { error: message } });
  if (typeof content !== "string" || content === "") return refuse(400, "content must be a non-empty string");
  if (content.length > DATABASE_IMPORT_INLINE_MAX_CHARS) {
    return refuse(413, `content may carry at most ${DATABASE_IMPORT_INLINE_MAX_CHARS} characters — hand a larger file to the user (import_page_url)`);
  }
  const exp = importExpiry(importId);
  const meta = exp === null ? null : await readImportJson<ImportMeta>(env, importKey(doc.doc_id, importId, "meta"));
  if (!meta) return refuse(404, "no such import");
  if (meta.created_by !== ctx.alias) return refuse(403, "this import was staged by another credential");
  const bytes = new TextEncoder().encode(content);
  const max = Math.min(DATABASE_IMPORT_MAX_BYTES, env.settings.current().maxBodyBytes);
  if (bytes.byteLength > max) return refuse(413, `file too large (max ${Math.floor(max / (1024 * 1024))} MB)`);
  await env.snapshots.put(importKey(doc.doc_id, importId, "body"), bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return { status: 200, body: { import_id: importId, bytes: bytes.byteLength } };
}

/**
 * Validate the staged file whole, then land it as one rows.insert (proposed for
 * an agent, direct for a person). Nothing is written until every row passed; a
 * replayed commit answers from the `.done` marker.
 */
export async function commitDatabaseImport(
  ctx: Ctx,
  doc: DocRow,
  importId: string,
  opts: CommitImportOptions,
  source: DatabaseRunSource,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = ctx.env;
  const refuse = (status: number, message: string) => ({ status, body: { error: message } });
  const done = await readImportJson<ImportDone>(env, importKey(doc.doc_id, importId, "done"));
  if (done) {
    const replay: DatabaseImportResult = { ...done, errors: [], errors_truncated: false, ignored_columns: [], already_applied: true };
    return { status: 200, body: replay as unknown as Record<string, unknown> };
  }
  const exp = importExpiry(importId);
  const meta = exp === null ? null : await readImportJson<ImportMeta>(env, importKey(doc.doc_id, importId, "meta"));
  if (!meta) return refuse(404, "no such import — it was never staged here, has expired, or the id is wrong");
  if (meta.created_by !== ctx.alias) return refuse(403, "this import was staged by another credential");
  if (exp! < Date.now()) return refuse(410, "this import has expired — stage a new one");
  const blob = await env.snapshots.get(importKey(doc.doc_id, importId, "body")).catch(() => null);
  if (!blob) return refuse(409, "nothing has been uploaded to this import yet — PUT the file to upload_url first");

  const schema = await projectedSchema(ctx, doc.doc_id);
  const table = schema?.tables.find((t) => t.table_id === meta.table_id);
  if (!table) return refuse(404, "the table this import was staged for no longer exists");

  const text = await blob.text();
  const parsed = meta.format === "jsonl" ? jsonlToTable(text) : csvToTable(text);
  if (parsed.headers.length === 0) return refuse(400, "the file has no header row");
  const mapping = mapHeaders(parsed.headers, table.columns as ColumnSpec[], opts.columnMap);
  const failure = (message: string, extra: Record<string, unknown>) => ({
    status: 422,
    body: { error: "import_validation_failed", message, import_id: importId, ignored_columns: mapping.ignored, ...extra },
  });
  if (opts.dryRun) {
    // Header and row problems are report lines here, and the staging survives.
    const validated = mapping.errors.length > 0 || mapping.targets.every((t) => t === null)
      ? null
      : validateImportRows(parsed, mapping, { dateOrder: opts.dateOrder });
    const errors = [...mapping.errors, ...(validated?.errors ?? [])];
    const check: DatabaseImportCheck = {
      import_id: importId,
      dry_run: true,
      rows_total: parsed.rows.length,
      rows_ready: validated ? validated.rows.length : 0,
      rows_failed: validated ? validated.rows_failed : parsed.rows.length,
      errors: errors.slice(0, DATABASE_IMPORT_MAX_ERRORS),
      errors_truncated: (validated?.errors_truncated ?? false) || errors.length > DATABASE_IMPORT_MAX_ERRORS,
      matched_columns: mapping.targets.flatMap((t) => (t ? [t.display] : [])),
      ignored_columns: mapping.ignored,
      notes: validated?.notes ?? [],
      ...(validated?.guessedDateOrder ? { guessed_date_order: validated.guessedDateOrder } : {}),
    };
    return { status: 200, body: check as unknown as Record<string, unknown> };
  }
  if (mapping.errors.length > 0) {
    return failure("the file's headers do not match the table; nothing was loaded", {
      rows_total: parsed.rows.length,
      rows_failed: 0,
      errors: mapping.errors.slice(0, DATABASE_IMPORT_MAX_ERRORS),
      errors_truncated: mapping.errors.length > DATABASE_IMPORT_MAX_ERRORS,
    });
  }
  if (mapping.targets.every((t) => t === null)) return refuse(400, "no header maps to a column of this table");

  const validated = validateImportRows(parsed, mapping, { dateOrder: opts.dateOrder });
  const report = {
    rows_total: validated.rows_total,
    rows_failed: validated.rows_failed,
    errors: validated.errors,
    errors_truncated: validated.errors_truncated,
    notes: validated.notes,
    ...(validated.guessedDateOrder ? { guessed_date_order: validated.guessedDateOrder } : {}),
  };
  if (validated.rows_failed > 0 && opts.onError === "abort") {
    return failure(`${validated.rows_failed} of ${validated.rows_total} rows failed validation; nothing was loaded`, report);
  }
  if (validated.rows_failed > opts.maxBadRows) {
    return failure(`${validated.rows_failed} rows failed validation, more than max_bad_rows (${opts.maxBadRows}); nothing was loaded`, report);
  }
  if (validated.rows.length === 0) return refuse(400, "the file has no data rows");

  const rows: Array<Record<string, RowValue>> = validated.rows;
  let mode: "proposed" | "applied";
  let run: DatabaseRunSummary | undefined;
  let pending: number | undefined;
  if (ctx.isAgent) {
    const outcome = await proposeDatabaseOp(ctx, doc, { kind: "rows.insert", table: table.table_id, rows, import: true }, source);
    if (outcome.kind === "error") return refuse(outcome.status, outcome.message);
    mode = outcome.kind;
    run = outcome.run;
    if (outcome.kind === "proposed") pending = outcome.pending;
  } else {
    const inserted = await insertImportedRows(ctx, doc, table, rows);
    if (!inserted.ok) return refuse(inserted.status, inserted.message);
    mode = "applied";
  }

  const marker: ImportDone = {
    import_id: importId,
    mode,
    rows_total: validated.rows_total,
    rows_ingested: rows.length,
    rows_skipped: validated.rows_failed,
    ...(run ? { run_id: run.id } : {}),
  };
  await env.snapshots.delete([importKey(doc.doc_id, importId, "body"), importKey(doc.doc_id, importId, "meta")]).catch(() => {});
  await env.snapshots.put(importKey(doc.doc_id, importId, "done"), JSON.stringify(marker), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
  const result: DatabaseImportResult = {
    import_id: importId,
    mode,
    rows_total: validated.rows_total,
    rows_ingested: rows.length,
    rows_skipped: validated.rows_failed,
    errors: validated.errors,
    errors_truncated: validated.errors_truncated,
    ignored_columns: mapping.ignored,
    notes: validated.notes,
    ...(validated.guessedDateOrder ? { guessed_date_order: validated.guessedDateOrder } : {}),
    ...(run ? { run } : {}),
    ...(pending !== undefined ? { pending } : {}),
  };
  return { status: 200, body: result as unknown as Record<string, unknown> };
}

/**
 * A person's validated rows, landed as one rows.insert past the per-write cap
 * (the table's own cap still holds): one revertible op, one Activity entry.
 * The new rows' ids come back in the order of `rows`.
 */
export async function insertImportedRows(
  ctx: Ctx,
  doc: DocRow,
  table: Pick<TableSchema, "table_id" | "display">,
  rows: Array<Record<string, RowValue>>,
): Promise<{ ok: true; row_ids: string[] } | { ok: false; status: number; message: string }> {
  const res = await callDatabaseActor(ctx, doc.doc_id, "rows/insert", { table_id: table.table_id, rows, import: true });
  const body = (await res.json().catch(() => null)) as { row_ids?: string[]; message?: string } | null;
  if (!res.ok) return { ok: false, status: actorRefusalStatus(res), message: body?.message ?? "could not import rows" };
  if (!Array.isArray(body?.row_ids)) return { ok: false, status: 502, message: "could not import rows" };
  await afterDatabaseMutation(ctx, doc, `Imported ${rows.length} row${rows.length === 1 ? "" : "s"} into "${table.display}".`);
  return { ok: true, row_ids: body.row_ids };
}
