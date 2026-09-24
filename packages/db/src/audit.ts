/**
 * The append-only audit ledger. Requests enqueue `audit` jobs and the worker
 * batches them into insertAuditEvents, so a slow audit write never stalls a request.
 */
import type { Fragment } from "postgres";
import type { AuditEventInsert, AuditEventRow } from "./types.js";
import { daysAgo, isoOrNull } from "./sql.js";
import type { Sql } from "./client.js";

/**
 * Append a batch in one statement. Every `at` is stored truncated to
 * milliseconds, the server clock fallback included: the paging cursor travels
 * as a JS Date, and a microsecond tail would make `(at, id) < cursor` skip the
 * rows sharing the boundary millisecond for good.
 */
export async function insertAuditEvents(sql: Sql, batch: AuditEventInsert[]): Promise<void> {
  if (batch.length === 0) return;
  const requestIds = batch.map((e) => e.requestId ?? null);
  const ats = batch.map((e) => isoOrNull(e.at));
  const workspaceIds = batch.map((e) => e.workspaceId);
  const actors = batch.map((e) => e.actor);
  const actorKinds = batch.map((e) => e.actorKind);
  const onBehalfOfs = batch.map((e) => e.onBehalfOf ?? null);
  const sources = batch.map((e) => e.source);
  const actions = batch.map((e) => e.action);
  const targetKinds = batch.map((e) => e.targetKind ?? null);
  const targetIds = batch.map((e) => e.targetId ?? null);
  const targetLabels = batch.map((e) => e.targetLabel ?? null);
  // A NULL in a named column is rejected rather than defaulted.
  const statuses = batch.map((e) => e.status ?? "ok");
  const details = batch.map((e) => JSON.stringify(e.detail ?? {}));
  await sql`
    INSERT INTO audit_events
      (request_id, at, workspace_id, actor, actor_kind, on_behalf_of, source, action,
       target_kind, target_id, target_label, status, detail)
    SELECT request_id, date_trunc('milliseconds', COALESCE(at::timestamptz, now())), workspace_id, actor, actor_kind, on_behalf_of,
           source, action, target_kind, target_id, target_label, status, detail::jsonb
    FROM unnest(
      ${requestIds}::text[], ${ats}::text[], ${workspaceIds}::text[], ${actors}::text[],
      ${actorKinds}::text[], ${onBehalfOfs}::text[], ${sources}::text[], ${actions}::text[],
      ${targetKinds}::text[], ${targetIds}::text[], ${targetLabels}::text[], ${statuses}::text[],
      ${details}::text[]
    ) AS t(request_id, at, workspace_id, actor, actor_kind, on_behalf_of, source, action,
           target_kind, target_id, target_label, status, detail)`;
}

export interface AuditFilters {
  workspaceId: string;
  /** The instrument, matched exactly: the alias the row was written under. */
  actor?: string;
  /**
   * The accountable person: rows they wrote and rows their agents wrote for
   * them (`actor = $1 OR on_behalf_of = $1`). ANDs with `actor`.
   */
  principal?: string;
  action?: string;
  targetKind?: string;
  targetId?: string;
  status?: string;
  /** Inclusive. */
  since?: Date | string;
  /** Exclusive. */
  until?: Date | string;
  /** Keyset cursor: rows strictly older than this (at, id). */
  before?: { at: string | Date; id: number };
  limit?: number;
}

function timeWindow(sql: Sql, since: Date | string | undefined, until: Date | string | undefined): Fragment {
  return sql`
    ${since ? sql`AND at >= ${isoOrNull(since)}::timestamptz` : sql``}
    ${until ? sql`AND at < ${isoOrNull(until)}::timestamptz` : sql``}`;
}

function auditWhere(sql: Sql, filters: Omit<AuditFilters, "limit">): Fragment {
  return sql`
    WHERE workspace_id = ${filters.workspaceId}
      ${filters.actor ? sql`AND actor = ${filters.actor}` : sql``}
      ${filters.principal ? sql`AND (actor = ${filters.principal} OR on_behalf_of = ${filters.principal})` : sql``}
      ${filters.action ? sql`AND action = ${filters.action}` : sql``}
      ${filters.targetKind ? sql`AND target_kind = ${filters.targetKind}` : sql``}
      ${filters.targetId ? sql`AND target_id = ${filters.targetId}` : sql``}
      ${filters.status ? sql`AND status = ${filters.status}` : sql``}
      ${timeWindow(sql, filters.since, filters.until)}
      ${filters.before ? sql`AND (at, id) < (${isoOrNull(filters.before.at)}::timestamptz, ${filters.before.id})` : sql``}`;
}

/**
 * A page of the workspace ledger, newest first; `limit` is capped at 500.
 * Paged by keyset on (at, id), a total order. The cursor compares the bare
 * column so audit_events_ws_at_idx still serves the ORDER BY.
 */
export async function listAuditEvents(sql: Sql, filters: AuditFilters): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  return sql<AuditEventRow[]>`
    SELECT * FROM audit_events
    ${auditWhere(sql, filters)}
    ORDER BY at DESC, id DESC
    LIMIT ${limit}`;
}

/** Every matching row, oldest first, in batches over a server-side cursor, for export. */
export function auditEventsCursor(
  sql: Sql,
  filters: Omit<AuditFilters, "limit" | "before">,
  batch = 500,
): AsyncIterable<AuditEventRow[]> {
  return sql<AuditEventRow[]>`
    SELECT * FROM audit_events
    ${auditWhere(sql, filters)}
    ORDER BY at ASC, id ASC`.cursor(batch);
}

/** One distinct value of an audit axis in a window. */
export interface AuditFacet {
  value: string;
  count: number;
  last_at: Date;
}

export interface AuditFacetsResult {
  /** Who is accountable: `COALESCE(on_behalf_of, actor)`. */
  principals: AuditFacet[];
  /** What acted: `actor` on agent rows only. Those rows also count under their human in `principals`. */
  agents: AuditFacet[];
  actions: AuditFacet[];
  statuses: AuditFacet[];
  /** Some axis held more values than `limit`; it shows the busiest ones. */
  truncated: boolean;
}

/**
 * The values present in a window of the ledger, for the filter menus: built
 * from the window rather than a loaded page, so a quiet value is still offered.
 * Each axis asks for `limit + 1` rows to learn whether it was cut short.
 */
export async function auditFacets(
  sql: Sql,
  input: { workspaceId: string; since?: Date | string; until?: Date | string; limit?: number },
): Promise<AuditFacetsResult> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const facet = (value: Fragment, extra: Fragment = sql``) => sql<AuditFacet[]>`
    SELECT ${value} AS value, count(*)::int AS count, max(at) AS last_at
    FROM audit_events
    WHERE workspace_id = ${input.workspaceId}
      ${extra}
      ${timeWindow(sql, input.since, input.until)}
    GROUP BY ${value}
    ORDER BY count DESC, value ASC
    LIMIT ${limit + 1}`;
  const [principals, agents, actions, statuses] = await Promise.all([
    facet(sql`COALESCE(on_behalf_of, actor)`),
    facet(sql`actor`, sql`AND actor_kind = 'agent'`),
    facet(sql`action`),
    facet(sql`status`),
  ]);
  const truncated =
    principals.length > limit || agents.length > limit || actions.length > limit || statuses.length > limit;
  return {
    principals: principals.slice(0, limit),
    agents: agents.slice(0, limit),
    actions: actions.slice(0, limit),
    statuses: statuses.slice(0, limit),
    truncated,
  };
}

/** Delete events older than `olderThanDays`, counted in SQL rather than returned. */
export async function purgeAuditEvents(sql: Sql, olderThanDays: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    WITH gone AS (
      DELETE FROM audit_events
      WHERE at < ${daysAgo(sql, olderThanDays)}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`;
  return row?.n ?? 0;
}

/** Node-level rows (no workspace, `node.*` actions), newest first, paged like the workspace ledger. */
export async function listNodeAuditEvents(
  sql: Sql,
  opts: { limit?: number; before?: { at: string | Date; id: number } } = {},
): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return sql<AuditEventRow[]>`
    SELECT * FROM audit_events
    WHERE workspace_id IS NULL AND action LIKE 'node.%'
      ${opts.before ? sql`AND (at, id) < (${isoOrNull(opts.before.at)}::timestamptz, ${opts.before.id})` : sql``}
    ORDER BY at DESC, id DESC
    LIMIT ${limit}`;
}
