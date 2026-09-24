/** What the ledger's read routes share: the gate, query-string filters and cursors, and the wire spelling of a timestamp. */
import { getMemberRole } from "@stuga/db";
import { AUDIT_STATUSES, isAuditStatus, type AuditStatus } from "@stuga/protocol/domain/audit";
import { error } from "../http/respond.js";
import type { Ctx } from "../auth/context.js";

/**
 * The gate on every workspace-ledger read: owner/admin humans only, never an
 * agent. The role is re-read from the membership row so a revocation bites on
 * the next request.
 */
export async function auditReadRefusal(ctx: Ctx, what = "read the audit ledger"): Promise<Response | null> {
  if (ctx.isAgent) return error(403, "agents cannot read the audit ledger");
  const role = await getMemberRole(ctx.sql, ctx.workspaceId, ctx.alias);
  if (role !== "owner" && role !== "admin") {
    return error(403, `only a workspace owner or admin can ${what}`);
  }
  return null;
}

/** An audit timestamp as an ISO instant; an unparseable value passes through unchanged. */
export function auditCursorAt(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? String(at) : d.toISOString();
}

/** A parsed parameter set, or the sentence a 400 should carry. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** The narrowing every ledger read accepts. Timestamps are ISO instants. */
export interface AuditReadFilters {
  actor?: string;
  principal?: string;
  action?: string;
  targetKind?: string;
  targetId?: string;
  status?: AuditStatus;
  since?: string;
  until?: string;
}

/**
 * A timestamp parameter as an ISO instant, or undefined when absent. Normalised
 * because a value `Date.parse` accepts can still fail Postgres's `::timestamptz` cast.
 */
export function instant(name: string, raw: string | null): Parsed<string | undefined> {
  if (!raw) return { ok: true, value: undefined };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { ok: false, message: `${name} must be a timestamp` };
  return { ok: true, value: new Date(ms).toISOString() };
}

/**
 * The filters a ledger read carries. `principal` is who is accountable (their
 * agents' rows included); `actor` is the exact alias that wrote the row. Sent
 * together they AND.
 */
export function parseAuditFilters(p: URLSearchParams): Parsed<AuditReadFilters> {
  const since = instant("since", p.get("since"));
  if (!since.ok) return since;
  const until = instant("until", p.get("until"));
  if (!until.ok) return until;
  const status = p.get("status");
  if (status && !isAuditStatus(status)) {
    return { ok: false, message: `status must be one of: ${AUDIT_STATUSES.join(", ")}` };
  }
  return {
    ok: true,
    value: {
      actor: p.get("actor") || undefined,
      principal: p.get("principal") || undefined,
      action: p.get("action") || undefined,
      targetKind: p.get("target_kind") || undefined,
      targetId: p.get("target_id") || undefined,
      status: status && isAuditStatus(status) ? status : undefined,
      since: since.value,
      until: until.value,
    },
  };
}

/** The (at, id) pair a page resumes below, as the client sends it back. */
export interface AuditCursor {
  at: string;
  id: number;
}

/**
 * The keyset cursor, or undefined for the newest page. `at` and `id` are one
 * position, so half a cursor is refused rather than answered with page one.
 */
export function parseAuditCursor(p: URLSearchParams): Parsed<AuditCursor | undefined> {
  const beforeAt = p.get("before_at");
  const beforeId = p.get("before_id");
  if (Boolean(beforeAt) !== Boolean(beforeId)) return { ok: false, message: "before_at and before_id go together" };
  if (!beforeAt || !beforeId) return { ok: true, value: undefined };
  const at = instant("before_at", beforeAt);
  if (!at.ok) return at;
  const id = Number(beforeId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: "before_id must be a row id" };
  return { ok: true, value: { at: at.value!, id } };
}

/** The most rows one page may carry. */
export const AUDIT_PAGE_CAP = 500;

/** The page size, settled here because a full page is what signals that more rows exist. */
export function parseAuditLimit(p: URLSearchParams, fallback: number): number {
  const raw = Number(p.get("limit") ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), AUDIT_PAGE_CAP) : fallback;
}

/** The cursor for the next page, offered whenever this page came back full. */
export function nextAuditCursor(events: { at: string | Date; id: number | string }[], limit: number): AuditCursor | null {
  const last = events[events.length - 1];
  return last && events.length === limit ? { at: auditCursorAt(last.at), id: Number(last.id) } : null;
}
