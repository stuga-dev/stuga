import { auditExportFilename } from "@stuga/protocol/domain/audit";
import { api, apiFailure, authedFetch, UPLOAD_TIMEOUT_MS } from "../lib/http/client";


export interface AuditEvent {
  id: number;
  request_id: string | null;
  at: string;
  workspace_id: string | null;
  actor: string;
  actor_kind: "human" | "agent" | "internal";
  /** The person a delegated agent acted for. */
  on_behalf_of: string | null;
  source: "web" | "mcp" | "api-key" | "ws" | "internal" | "cron";
  action: string;
  target_kind: string | null;
  target_id: string | null;
  /** The target's name when the row was written. */
  target_label: string | null;
  status: string;
  detail: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AuditFilters {
  /** The exact actor: the instrument a row was made with. */
  actor?: string;
  /** The accountable principal: `actor = p OR on_behalf_of = p`. ANDs with `actor`. */
  principal?: string;
  action?: string;
  targetKind?: string;
  targetId?: string;
  /** "ok" or "denied"; omitted means both. */
  status?: string;
  /** Inclusive lower bound on `at` (ISO). */
  since?: string;
  /** Exclusive upper bound on `at` (ISO). */
  until?: string;
  limit?: number;
  /** Keyset cursor: rows older than this (at, id). Sent only as a pair. */
  before_at?: string;
  before_id?: number;
}

/** The (at, id) pair that reaches the row after the last one on this page. */
export interface AuditCursor {
  at: string;
  id: number;
}

interface AuditFacet {
  value: string;
  count: number;
  last_at: string;
}

/** Filter menu values over the whole window. `truncated`: an axis had more values than were returned. */
export interface AuditFacets {
  /** Grouped by `COALESCE(on_behalf_of, actor)`. */
  principals: AuditFacet[];
  /** Grouped by `actor`, over agent rows only. */
  agents: AuditFacet[];
  actions: AuditFacet[];
  statuses: AuditFacet[];
  truncated: boolean;
}

/** The export streams the whole range, so it takes no cursor. */
export type AuditExportFilters = Omit<AuditFilters, "limit" | "before_at" | "before_id">;

function auditQuery(filters: AuditExportFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (filters.actor) q.set("actor", filters.actor);
  if (filters.principal) q.set("principal", filters.principal);
  if (filters.action) q.set("action", filters.action);
  if (filters.targetKind) q.set("target_kind", filters.targetKind);
  if (filters.targetId) q.set("target_id", filters.targetId);
  if (filters.status) q.set("status", filters.status);
  if (filters.since) q.set("since", filters.since);
  if (filters.until) q.set("until", filters.until);
  return q;
}

function attachmentName(res: Response): string | null {
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? null;
}

export const Audit = {
  /** Every matching row, uncapped. Fetched rather than linked, since a link cannot carry the bearer. */
  export: async (
    filters: AuditExportFilters = {},
    format: "ndjson" | "csv" = "csv",
  ): Promise<{ blob: Blob; filename: string }> => {
    const q = auditQuery(filters);
    q.set("format", format);
    const res = await authedFetch(`/api/audit/export?${q}`, { timeoutMs: UPLOAD_TIMEOUT_MS });
    if (!res.ok) throw await apiFailure("/api/audit/export", "GET", res);
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      blob: await res.blob(),
      filename: attachmentName(res) ?? auditExportFilename(stamp, format === "csv" ? "csv" : "ndjson"),
    };
  },
  /** Newest first; `limit` is capped at 500. `next_before` is null when nothing older remains. */
  list: (filters: AuditFilters = {}) => {
    const q = auditQuery(filters);
    if (filters.limit) q.set("limit", String(filters.limit));
    if (filters.before_at && filters.before_id !== undefined) {
      q.set("before_at", filters.before_at);
      q.set("before_id", String(filters.before_id));
    }
    const qs = q.toString();
    return api<{ events: AuditEvent[]; next_before: AuditCursor | null }>(`/api/audit${qs ? `?${qs}` : ""}`);
  },
  /** Only the window: a menu narrowed by its own selection could not offer the way back out. */
  facets: (window: { since?: string; until?: string } = {}) => {
    const q = new URLSearchParams();
    if (window.since) q.set("since", window.since);
    if (window.until) q.set("until", window.until);
    const qs = q.toString();
    return api<AuditFacets>(`/api/audit/facets${qs ? `?${qs}` : ""}`);
  },
};
