/** Agent governance: the run inbox mirror, the workspace event feed, and outbound webhooks. */
import { RUN_IDLE_MS } from "@stuga/protocol/domain/limits";
import type { RunIndexEntry } from "@stuga/protocol/internal/jobs";
import type { AgentRunRow, AgentStatsRow, WebhookRow, WorkspaceEventRow } from "./types.js";
import { daysAgo, jsonb } from "./sql.js";
import type { Sql } from "./client.js";

// ---- The run inbox --------------------------------------------------------------

/**
 * Upsert one run's mirror row. The job queue is at-least-once and unordered,
 * so a delivery older than the stored row loses; an equal timestamp wins,
 * being the later save. A run whose workspace is gone is dropped.
 */
export async function upsertAgentRun(sql: Sql, e: RunIndexEntry): Promise<void> {
  const createdAt = new Date(e.createdAt).toISOString();
  const updatedAt = new Date(e.updatedAt).toISOString();
  await sql`
    INSERT INTO agent_runs
      (run_id, workspace_id, doc_id, doc_kind, doc_title, source, agent, agent_alias, reviewer, status,
       review_mode, auto_applied, reverted, acknowledged, pending, accepted, rejected, conflicts, applied,
       client, model, created_at, updated_at)
    SELECT ${e.runId}, ${e.workspaceId}, ${e.docId}, ${e.docKind}, ${e.docTitle}, ${e.source}, ${e.agent},
           ${e.agentAlias}, ${e.reviewer}, ${e.status}, ${e.reviewMode}, ${e.autoApplied}, ${e.reverted},
           ${e.acknowledged}, ${e.pending}, ${e.accepted}, ${e.rejected}, ${e.conflicts}, ${e.applied},
           ${e.client}, ${e.model}, ${createdAt}::timestamptz, ${updatedAt}::timestamptz
    WHERE EXISTS (SELECT 1 FROM workspaces WHERE workspace_id = ${e.workspaceId})
    ON CONFLICT (run_id) DO UPDATE SET
      doc_title = EXCLUDED.doc_title,
      client = EXCLUDED.client,
      model = EXCLUDED.model,
      status = EXCLUDED.status,
      review_mode = EXCLUDED.review_mode,
      auto_applied = EXCLUDED.auto_applied,
      reverted = EXCLUDED.reverted,
      acknowledged = EXCLUDED.acknowledged,
      pending = EXCLUDED.pending,
      accepted = EXCLUDED.accepted,
      rejected = EXCLUDED.rejected,
      conflicts = EXCLUDED.conflicts,
      applied = EXCLUDED.applied,
      updated_at = EXCLUDED.updated_at
    WHERE agent_runs.updated_at <= EXCLUDED.updated_at`;
}

/**
 * attention: open with pending hunks, or auto-applied and not yet acknowledged.
 * open: still collecting changes, by the actors' rollover rule (runIsIdle): pending
 * hunks, or touched within RUN_IDLE_MS. An idle run stays `open` in storage until
 * the agent's next change starts a new one, but nothing more will join it.
 * closed: everything else, so open and closed split `all` between them.
 */
export type RunInboxFilter = "attention" | "open" | "closed" | "all";

export interface ListAgentRunsInput {
  workspaceId: string;
  /** A run is listed only when the caller can see its document. */
  principals: string[];
  filter?: RunInboxFilter;
  agentAlias?: string;
  /** Keyset cursor: rows strictly older than this (updated_at, run_id). */
  before?: { updatedAt: string; runId: string };
  limit?: number;
}

/** The inbox page, newest activity first, gated on the document's ACL and hidden with trashed documents. */
export async function listAgentRuns(sql: Sql, input: ListAgentRunsInput): Promise<AgentRunRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const filter = input.filter ?? "attention";
  const collecting = sql`(r.status = 'open' AND (r.pending > 0 OR r.updated_at > now() - make_interval(secs => ${RUN_IDLE_MS / 1000})))`;
  return sql<AgentRunRow[]>`
    SELECT r.run_id, r.workspace_id, r.doc_id, r.doc_kind,
           coalesce(nullif(d.title, ''), r.doc_title) AS doc_title,
           r.source, r.agent, r.agent_alias, r.client, r.model, r.reviewer, r.status, r.review_mode,
           r.auto_applied, r.reverted, r.acknowledged,
           r.pending, r.accepted, r.rejected, r.conflicts, r.applied,
           r.created_at, r.updated_at
    FROM agent_runs r
    JOIN docs d ON d.doc_id = r.doc_id
    WHERE r.workspace_id = ${input.workspaceId}
      AND d.workspace_id = ${input.workspaceId}
      AND d.trashed = FALSE
      AND d.acl_principals && ${input.principals}
      ${
        filter === "attention"
          ? sql`AND ((r.status = 'open' AND r.pending > 0) OR (r.auto_applied AND NOT r.acknowledged AND NOT r.reverted))`
          : filter === "open"
            ? sql`AND ${collecting}`
            : filter === "closed"
              ? sql`AND NOT ${collecting}`
              : sql``
      }
      ${input.agentAlias ? sql`AND r.agent_alias = ${input.agentAlias}` : sql``}
      ${
        input.before
          ? sql`AND (r.updated_at, r.run_id) < (${input.before.updatedAt}::timestamptz, ${input.before.runId})`
          : sql``
      }
    ORDER BY r.updated_at DESC, r.run_id DESC
    LIMIT ${limit}`;
}

/** Per-agent totals over the runs the caller can see. */
export async function agentRunStats(sql: Sql, workspaceId: string, principals: string[]): Promise<AgentStatsRow[]> {
  return sql<AgentStatsRow[]>`
    SELECT r.agent_alias,
           (array_agg(r.agent ORDER BY r.updated_at DESC))[1] AS agent,
           count(*)::int AS runs,
           count(*) FILTER (WHERE r.status = 'open')::int AS open_runs,
           coalesce(sum(r.pending), 0)::int AS pending,
           coalesce(sum(r.accepted), 0)::int AS accepted,
           coalesce(sum(r.rejected), 0)::int AS rejected,
           coalesce(sum(r.applied), 0)::int AS applied,
           count(*) FILTER (WHERE r.reverted)::int AS reverted_runs,
           max(r.updated_at) AS last_active_at
    FROM agent_runs r
    JOIN docs d ON d.doc_id = r.doc_id
    WHERE r.workspace_id = ${workspaceId}
      AND d.workspace_id = ${workspaceId}
      AND d.acl_principals && ${principals}
    GROUP BY r.agent_alias
    ORDER BY last_active_at DESC`;
}

/** Drop closed runs older than `days`; open runs are never swept. */
export async function purgeAgentRuns(sql: Sql, days: number): Promise<number> {
  const rows = await sql<{ run_id: string }[]>`
    DELETE FROM agent_runs
    WHERE status <> 'open' AND updated_at < ${daysAgo(sql, days)}
    RETURNING run_id`;
  return rows.length;
}

// ---- The event feed ----------------------------------------------------------------

export interface WorkspaceEventInsert {
  workspaceId: string;
  type: string;
  docId?: string | null;
  actor: string;
  actorKind: "human" | "agent" | "internal";
  payload?: Record<string, unknown>;
}

/** Null when the workspace is gone. */
export async function insertWorkspaceEvent(sql: Sql, e: WorkspaceEventInsert): Promise<WorkspaceEventRow | null> {
  const rows = await sql<WorkspaceEventRow[]>`
    INSERT INTO workspace_events (workspace_id, type, doc_id, actor, actor_kind, payload)
    SELECT ${e.workspaceId}, ${e.type}, ${e.docId ?? null}, ${e.actor}, ${e.actorKind}, ${jsonb(sql, e.payload ?? {})}
    WHERE EXISTS (SELECT 1 FROM workspaces WHERE workspace_id = ${e.workspaceId})
    RETURNING *`;
  return rows[0] ?? null;
}

export interface ListWorkspaceEventsInput {
  workspaceId: string;
  principals: string[];
  /** Cursor: events with an id greater than this. */
  after?: number;
  types?: string[];
  /** A scoped credential's folders, subtrees expanded; null = unscoped. */
  scopeFolderIds?: string[] | null;
  limit?: number;
}

/**
 * The feed, oldest first after the cursor. A document event is visible when
 * the document is; a workspace-level event is visible to every member but not
 * to a scoped credential, since it has no location.
 */
export async function listWorkspaceEvents(sql: Sql, input: ListWorkspaceEventsInput): Promise<WorkspaceEventRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const scoped = input.scopeFolderIds ?? null;
  return sql<WorkspaceEventRow[]>`
    SELECT e.*
    FROM workspace_events e
    LEFT JOIN docs d ON d.doc_id = e.doc_id
    WHERE e.workspace_id = ${input.workspaceId}
      AND e.id > ${input.after ?? 0}
      AND (
        (e.doc_id IS NULL ${scoped ? sql`AND FALSE` : sql``})
        OR (d.workspace_id = ${input.workspaceId}
            AND d.acl_principals && ${input.principals}
            ${scoped ? sql`AND d.parent_id = ANY(${scoped})` : sql``})
      )
      ${input.types && input.types.length > 0 ? sql`AND e.type = ANY(${input.types})` : sql``}
    ORDER BY e.id
    LIMIT ${limit}`;
}

/** The newest event id in a workspace, where a fresh subscriber starts. */
export async function latestWorkspaceEventId(sql: Sql, workspaceId: string): Promise<number> {
  const rows = await sql<{ id: number | null }[]>`
    SELECT max(id) AS id FROM workspace_events WHERE workspace_id = ${workspaceId}`;
  return rows[0]?.id ?? 0;
}

export async function getWorkspaceEvent(sql: Sql, id: number): Promise<WorkspaceEventRow | null> {
  const rows = await sql<WorkspaceEventRow[]>`SELECT * FROM workspace_events WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function purgeWorkspaceEvents(sql: Sql, days: number): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM workspace_events WHERE at < ${daysAgo(sql, days)} RETURNING id`;
  return rows.length;
}

// ---- Webhooks -------------------------------------------------------------------------

export async function insertWebhook(
  sql: Sql,
  input: {
    webhookId: string;
    workspaceId: string;
    url: string;
    secret: string;
    events: string[];
    folderId: string | null;
    createdBy: string;
  },
): Promise<WebhookRow> {
  const rows = await sql<WebhookRow[]>`
    INSERT INTO webhooks (webhook_id, workspace_id, url, secret, events, folder_id, created_by)
    VALUES (${input.webhookId}, ${input.workspaceId}, ${input.url}, ${input.secret}, ${input.events},
            ${input.folderId}, ${input.createdBy})
    RETURNING *`;
  return rows[0]!;
}

export async function listWebhooks(sql: Sql, workspaceId: string): Promise<WebhookRow[]> {
  return sql<WebhookRow[]>`
    SELECT * FROM webhooks WHERE workspace_id = ${workspaceId} ORDER BY created_at, webhook_id`;
}

export async function getWebhook(sql: Sql, webhookId: string): Promise<WebhookRow | null> {
  const rows = await sql<WebhookRow[]>`SELECT * FROM webhooks WHERE webhook_id = ${webhookId}`;
  return rows[0] ?? null;
}

export async function updateWebhook(
  sql: Sql,
  workspaceId: string,
  webhookId: string,
  patch: { url?: string; events?: string[]; folderId?: string | null; active?: boolean },
): Promise<WebhookRow | null> {
  const set: Record<string, unknown> = {};
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.events !== undefined) set.events = patch.events;
  if (patch.folderId !== undefined) set.folder_id = patch.folderId;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) {
    const rows = await sql<WebhookRow[]>`
      SELECT * FROM webhooks WHERE workspace_id = ${workspaceId} AND webhook_id = ${webhookId}`;
    return rows[0] ?? null;
  }
  const rows = await sql<WebhookRow[]>`
    UPDATE webhooks SET ${sql(set)}
    WHERE workspace_id = ${workspaceId} AND webhook_id = ${webhookId}
    RETURNING *`;
  return rows[0] ?? null;
}

export async function deleteWebhook(sql: Sql, workspaceId: string, webhookId: string): Promise<boolean> {
  const rows = await sql<{ webhook_id: string }[]>`
    DELETE FROM webhooks WHERE workspace_id = ${workspaceId} AND webhook_id = ${webhookId}
    RETURNING webhook_id`;
  return rows.length > 0;
}

/**
 * The active hooks an event reaches: the type matches (or the hook takes every
 * type) and the hook is workspace-wide or rooted at a folder in `folderIds`,
 * the event document's ancestry. An event with no document reaches only
 * workspace-wide hooks.
 */
export async function matchingWebhooks(sql: Sql, workspaceId: string, type: string, folderIds: string[]): Promise<WebhookRow[]> {
  return sql<WebhookRow[]>`
    SELECT * FROM webhooks
    WHERE workspace_id = ${workspaceId}
      AND active = TRUE
      AND (cardinality(events) = 0 OR ${type} = ANY(events))
      AND (folder_id IS NULL OR folder_id = ANY(${folderIds}))
    ORDER BY created_at, webhook_id`;
}

/** Record a delivery attempt; `failures` counts consecutive failures and a success resets it. */
export async function recordWebhookDelivery(sql: Sql, webhookId: string, status: number | null, ok: boolean): Promise<void> {
  await sql`
    UPDATE webhooks
    SET last_delivery_at = now(),
        last_status = ${status},
        failures = ${ok ? sql`0` : sql`failures + 1`}
    WHERE webhook_id = ${webhookId}`;
}
