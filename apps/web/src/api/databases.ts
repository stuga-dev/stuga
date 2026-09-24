import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import type {
  ColumnSpec,
  DatabaseColumnType,
  DatabaseImportCheck,
  DatabaseImportFormat,
  DatabaseImportResult,
  DatabaseImportTicket,
  DatabaseOpSummary,
  DatabaseRunSummary,
  DatabaseSchema,
  RowFilterNode,
  RowGroup,
  RowInputValue,
  RowRecord,
  RowSort,
  TableSchema,
  ViewInput,
  ViewSpec,
} from "@stuga/protocol/databases/types";
import { api, apiFailure, type ApiError } from "../lib/http/client";
import { openSse } from "../lib/http/sse";

/**
 * A database's data plane. `:id` is the docs row id; rename, trash, share and move
 * stay on `Docs`. Cells arrive stored-normalized (checkbox 0/1, date "YYYY-MM-DD").
 */
export const Databases = {
  /** `can_write` is false for viewers and while the item is locked. */
  schema: (id: string) => api<DatabaseSchema & { can_write: boolean }>(`/api/databases/${id}/schema`),
  createTable: (id: string, display: string) =>
    api<{ table: TableSchema }>(`/api/databases/${id}/tables`, {
      method: "POST",
      body: JSON.stringify({ display }),
    }),
  renameTable: (id: string, tableId: string, display: string) =>
    api<{ table: TableSchema }>(`/api/databases/${id}/tables/${tableId}`, {
      method: "PATCH",
      body: JSON.stringify({ display }),
    }),
  deleteTable: (id: string, tableId: string) =>
    api<{ deleted: true }>(`/api/databases/${id}/tables/${tableId}`, { method: "DELETE" }),
  addColumn: (
    id: string,
    tableId: string,
    spec: { display: string; type: DatabaseColumnType; choices?: string[]; description?: string },
  ) =>
    api<{ column: ColumnSpec }>(`/api/databases/${id}/tables/${tableId}/columns`, {
      method: "POST",
      body: JSON.stringify(spec),
    }),
  renameColumn: (id: string, tableId: string, columnId: string, display: string) =>
    api<{ column: ColumnSpec }>(`/api/databases/${id}/tables/${tableId}/columns/${columnId}`, {
      method: "PATCH",
      body: JSON.stringify({ display }),
    }),
  /** Values that do not fit the new type become empty; `coerced` counts them. */
  setColumnType: (id: string, tableId: string, columnId: string, type: DatabaseColumnType, choices?: string[]) =>
    api<{ column: ColumnSpec; coerced?: number }>(`/api/databases/${id}/tables/${tableId}/columns/${columnId}`, {
      method: "PATCH",
      body: JSON.stringify({ type, choices }),
    }),
  /** What the column holds, in prose: shown to readers and read by the AI. Sent alone — the route refuses a body that mixes it with `type` or `display` — and empty clears it. People only. */
  setColumnDescription: (id: string, tableId: string, columnId: string, description: string) =>
    api<{ column: ColumnSpec }>(`/api/databases/${id}/tables/${tableId}/columns/${columnId}`, {
      method: "PATCH",
      body: JSON.stringify({ description }),
    }),
  deleteColumn: (id: string, tableId: string, columnId: string) =>
    api<{ deleted: true }>(`/api/databases/${id}/tables/${tableId}/columns/${columnId}`, { method: "DELETE" }),
  /** A POST because filters do not fit a query string. Grouped listings come back ordered by the key, with counts over the whole filtered set. */
  listRows: (
    id: string,
    tableId: string,
    opts: { limit?: number; offset?: number; sort?: RowSort | RowSort[]; filter?: RowFilterNode | null; group_by?: string | null; view_id?: string } = {},
  ) =>
    api<{ rows: RowRecord[]; total: number; groups?: RowGroup[]; groups_truncated?: boolean; group_by?: string }>(
      `/api/databases/${id}/tables/${tableId}/rows/list`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    ),
  /** Views are shared; anyone with write access may change them. */
  createView: (id: string, tableId: string, input: ViewInput & { name: string }) =>
    api<{ view: ViewSpec }>(`/api/databases/${id}/tables/${tableId}/views`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateView: (id: string, tableId: string, viewId: string, changes: ViewInput) =>
    api<{ view: ViewSpec }>(`/api/databases/${id}/tables/${tableId}/views/${viewId}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),
  deleteView: (id: string, tableId: string, viewId: string) =>
    api<{ deleted: true }>(`/api/databases/${id}/tables/${tableId}/views/${viewId}`, { method: "DELETE" }),
  /** Rows keyed by column_id; `{}` is an empty row. */
  insertRows: (id: string, tableId: string, rows: Array<Record<string, RowInputValue>>) =>
    api<{ inserted: number; row_ids: string[] }>(`/api/databases/${id}/tables/${tableId}/rows`, {
      method: "POST",
      body: JSON.stringify({ rows }),
    }),
  /** `missing`: rows deleted underneath the caller, a reason to refetch rather than an error. */
  updateRows: (id: string, tableId: string, updates: Array<{ _id: string; values: Record<string, RowInputValue> }>) =>
    api<{ updated: number; missing: string[] }>(`/api/databases/${id}/tables/${tableId}/rows`, {
      method: "PATCH",
      body: JSON.stringify({ updates }),
    }),
  deleteRows: (id: string, tableId: string, rowIds: string[]) =>
    api<{ deleted: number }>(`/api/databases/${id}/tables/${tableId}/rows/delete`, {
      method: "POST",
      body: JSON.stringify({ row_ids: rowIds }),
    }),
  /** The row's page document, created on first open or restored from Trash. Rows carry it as `_doc_id`. */
  /** `replaceTrashed` gives a row whose page is in the Trash a new page rather than restoring the old one. */
  openRowPage: (id: string, tableId: string, rowId: string, opts: { replaceTrashed?: boolean } = {}) =>
    api<{ doc_id: string; created: boolean; restored?: boolean }>(`/api/databases/${id}/tables/${tableId}/rows/${rowId}/page`, {
      method: "POST",
      ...(opts.replaceTrashed ? { body: JSON.stringify({ replace_trashed: true }) } : {}),
    }),
  createImport: (id: string, tableId: string, format: DatabaseImportFormat) =>
    api<DatabaseImportTicket>(`/api/databases/${id}/imports`, {
      method: "POST",
      body: JSON.stringify({ table_id: tableId, format }),
    }),
  /** Lands the staged file as one change; a 422 carries the row-level report in `ApiError.report`. */
  commitImport: (
    id: string,
    importId: string,
    opts: { column_map?: Record<string, string | null>; on_error?: "abort" | "skip_bad_rows"; max_bad_rows?: number; date_order?: "mdy" | "dmy" } = {},
  ) =>
    api<DatabaseImportResult>(`/api/databases/${id}/imports/${importId}/commit`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),
  /** A dry run of the commit. */
  checkImport: (id: string, importId: string, opts: { column_map?: Record<string, string | null>; date_order?: "mdy" | "dmy" } = {}) =>
    api<DatabaseImportCheck>(`/api/databases/${id}/imports/${importId}/commit`, {
      method: "POST",
      body: JSON.stringify({ ...opts, dry_run: true }),
    }),
  /** Stage and upload a file. The PUT is a plain fetch: the signed upload path is the credential. */
  stageImport: async (id: string, tableId: string, file: File): Promise<DatabaseImportTicket> => {
    const format: DatabaseImportFormat = /\.(jsonl|ndjson|json)$/i.test(file.name) ? "jsonl" : "csv";
    const ticket = await Databases.createImport(id, tableId, format);
    if (file.size > ticket.max_bytes) {
      const e = new Error(`This file is too large (max ${Math.floor(ticket.max_bytes / (1024 * 1024))} MB).`) as ApiError;
      e.status = 413;
      throw e;
    }
    const put = await fetch(ticket.upload_path, { method: "PUT", body: file, headers: { "content-type": "application/octet-stream" } });
    if (!put.ok) throw await apiFailure(ticket.upload_path, "PUT", put);
    return ticket;
  },
  /** Stage, upload and commit in one call. */
  importFile: async (
    id: string,
    tableId: string,
    file: File,
    opts: { on_error?: "abort" | "skip_bad_rows"; date_order?: "mdy" | "dmy" } = {},
  ): Promise<DatabaseImportResult> => {
    const ticket = await Databases.stageImport(id, tableId, file);
    return Databases.commitImport(id, ticket.import_id, opts);
  },
  /** Every write, newest first; page back with the smallest seq shown as `before_seq`. */
  ops: (id: string, opts: { limit?: number; before_seq?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.before_seq !== undefined) qs.set("before_seq", String(opts.before_seq));
    const q = qs.toString();
    return api<{ ops: DatabaseOpSummary[] }>(`/api/databases/${id}/ops${q ? `?${q}` : ""}`);
  },
  /** People only. Restores what still exists and reports what did not. */
  revertOp: (id: string, opId: string) =>
    api<{ reverted: true; restored: number; missing: number }>(`/api/databases/${id}/ops/${opId}/revert`, {
      method: "POST",
    }),
};

/** The database twin of `Runs`. */
export const DatabaseRuns = {
  list: (id: string, limit?: number) =>
    api<{ runs: DatabaseRunSummary[] }>(`/api/databases/${id}/runs${limit ? `?limit=${limit}` : ""}`),
  /** `full` ships every payload whole; `sample` cuts a rows.insert to its first N rows. */
  detail: (id: string, runId: string, opts: { full?: boolean; sample?: number } = {}) =>
    api<{ run: DatabaseRunSummary }>(
      `/api/databases/${id}/runs/${runId}${opts.full ? "?full=1" : opts.sample !== undefined ? `?sample=${opts.sample}` : ""}`,
    ),
  decide: (id: string, runId: string, decision: "accept" | "reject", opIds?: string[]) =>
    api<{ run: DatabaseRunSummary; applied: number; rejected: number; conflicts: number; blocked: number; deferred: number }>(
      `/api/databases/${id}/runs/${runId}/decision`,
      { method: "POST", body: JSON.stringify({ decision, op_ids: opIds }) },
    ),
  revert: (id: string, runId: string) =>
    api<{ run: DatabaseRunSummary; reverted: number; skipped: number; restored: number; missing: number }>(
      `/api/databases/${id}/runs/${runId}/revert`,
      { method: "POST" },
    ),
  ack: (id: string, runId: string) =>
    api<{ run: DatabaseRunSummary }>(`/api/databases/${id}/runs/${runId}/ack`, { method: "POST" }),
};

interface TableAiCallbacks {
  onToken: (text: string) => void;
  onStatus: (label: string) => void;
  /** `notice` marks a turn that ended incomplete yet staged work; show it even when `staged` is 0. */
  onDone: (staged: number, runId: string | null, citations: AiCitation[], notice: string | null) => void;
  onError: (message: string) => void;
}

/** A table co-author turn over SSE. Staged changes arrive as run frames on the database socket; `onDone` only counts them. */
export const TableAi = {
  stream: (
    databaseId: string,
    input: {
      prompt: string;
      activeTable?: string | null;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
      /** Omit for "auto". */
      model?: string;
      /** Knowledge-base scope; without one the model gets no search tool. */
      collectionId?: string | null;
    },
    cb: TableAiCallbacks,
  ): AbortController =>
    openSse(
      `/api/databases/${databaseId}/ai`,
      {
        prompt: input.prompt,
        active_table: input.activeTable ?? undefined,
        history: input.history ?? [],
        model: input.model ?? "auto",
        collection_id: input.collectionId ?? undefined,
      },
      {
        onEvent: (ev, data) => {
          if (ev === "token") cb.onToken(data.text as string);
          else if (ev === "status") cb.onStatus(data.label as string);
          else if (ev === "done")
            cb.onDone(
              data.staged as number,
              (data.run_id as string | null) ?? null,
              data.citations as AiCitation[],
              (data.notice as string | undefined) ?? null,
            );
          else if (ev === "error") cb.onError(data.message as string);
        },
        onError: cb.onError,
      },
      "request failed",
    ),
};
