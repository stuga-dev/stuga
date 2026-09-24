/**
 * Audit ledger vocabulary for the node's streaming export. NDJSON exports
 * write stored rows whole and use neither `AUDIT_EXPORT_COLUMNS` nor `csvCell`.
 */

/** Whether the thing an audit row describes was allowed. */
export type AuditStatus = "ok" | "denied";

export const AUDIT_STATUSES: readonly AuditStatus[] = ["ok", "denied"];

export function isAuditStatus(v: unknown): v is AuditStatus {
  return typeof v === "string" && (AUDIT_STATUSES as readonly string[]).includes(v);
}

/** Canonical CSV column order. */
export const AUDIT_EXPORT_COLUMNS = [
  "id",
  "at",
  "actor",
  "actor_kind",
  "on_behalf_of",
  "source",
  "action",
  "target_kind",
  "target_id",
  "target_label",
  "status",
  "request_id",
  "detail",
] as const;

export type AuditExportColumn = (typeof AUDIT_EXPORT_COLUMNS)[number];

/** Written at the head of a CSV so spreadsheets read it as UTF-8. NDJSON gets none. */
export const CSV_BOM = "﻿";

/**
 * One CSV cell: RFC 4180 quoting plus a formula guard. A value starting with a
 * formula introducer (or a TAB/CR an importer would eat) is prefixed with an
 * apostrophe and always quoted, so the cell is text — including negative
 * numbers. Row terminators are the caller's job.
 */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  const needsQuote = guarded !== s || /[",\n\r]/.test(s) || /^\s|\s$/.test(s);
  return needsQuote ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** `stuga-audit-<date>.<ext>` for a server export of every matching row. */
export function auditExportFilename(dateIso: string, ext: "csv" | "ndjson"): string {
  return `stuga-audit-${dateIso}.${ext}`;
}
