/** Messages on the node's background job queue, produced by actors and routes. */
import type { AuditStatus } from "../domain/audit.js";

interface IndexDocFields {
  kind: "index_doc";
  docId: string;
  snapshotSeq?: number;
  title?: string;
  /** Who edited since the last flush. */
  authors?: string[];
  /** Bypass the content-hash dedup (the reconcile sweep re-embedding missing vectors). */
  force?: boolean;
  reason?: string;
}

export type IndexMessage =
  | (IndexDocFields & { recordVersion?: false })
  | (IndexDocFields & {
      /**
       * Record a `versions` row for `snapshotSeq`. Only the document actor sets
       * it: it owns the version ring and knows the snapshot bytes still exist.
       */
      recordVersion: true;
      /** Oldest seq in the version ring after this version entered it; stored as `docs.version_floor`. */
      versionFloor: number;
      /** Who edited since the previous version, for the version row; absent, `authors` stands in. */
      versionAuthors?: string[];
    })
  | { kind: "gc_check"; docId: string }
  | NotifyMessage
  | NotifyDeliverMessage
  | {
      kind: "ai_usage";
      alias: string;
      workspaceId: string;
      docId: string | null;
      usageKind: "coauthor" | "embedding";
      model: string;
      status?: "ok" | "error" | "disabled";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      /** Append-only audit of writes, permission changes and agent operations. */
      kind: "audit";
      /** ISO instant stamped by the sender; the worker's insert time lags behind retries and restarts. */
      at: string;
      workspaceId: string | null;
      actor: string;
      actorKind: "human" | "agent" | "internal";
      onBehalfOf?: string | null;
      source: "web" | "mcp" | "api-key" | "ws" | "internal" | "cron";
      action: string;
      targetKind?: string | null;
      targetId?: string | null;
      /**
       * The target's name when the row was written: a stored name the writer
       * holds (a title, a label, a fingerprinted URL), never text derived from
       * the target's contents, which the ledger's readers may not be allowed to see.
       */
      targetLabel?: string | null;
      status: AuditStatus;
      requestId?: string;
      detail?: Record<string, unknown>;
    }
  | {
      /**
       * Mirror a run into the `agent_runs` inbox. The worker upserts guarded on
       * `updatedAt`, so a late delivery never regresses a newer state.
       */
      kind: "run_index";
      run: RunIndexEntry;
    }
  | {
      /** Append to the workspace event feed and fan out to subscribed webhooks. */
      kind: "event";
      workspaceId: string;
      type: string;
      docId?: string | null;
      /** A principal: `user:<alias>`, `agent:<id>`, or a system name. */
      actor: string;
      actorKind: "human" | "agent" | "internal";
      payload?: Record<string, unknown>;
    }
  | {
      /** Deliver one event to one webhook. Retried by the queue on failure. */
      kind: "webhook_deliver";
      webhookId: string;
      eventId: number;
    };

/** One in-app notification for one recipient, also delivered to the configured sink. */
export type NotifyMessage = {
  kind: "notify";
  /** The recipient's bare alias. */
  recipient: string;
  workspaceId: string | null;
  eventType: string;
  docId: string;
  title: string;
  body: string;
  /** Who caused it, as a display string or alias. */
  actor: string;
};

/**
 * Hand one stored notification to the configured sink. Queued with the row it
 * belongs to, and retried by the queue on its own, so a failed delivery is
 * never mistaken for a duplicate notification.
 */
export type NotifyDeliverMessage = {
  kind: "notify_deliver";
  recipient: string;
  title: string;
  body: string;
  url: string;
};

/** One run as the inbox needs it; counts only, hunk text stays in the actor. */
export interface RunIndexEntry {
  runId: string;
  workspaceId: string;
  docId: string;
  docKind: "prose" | "database";
  docTitle: string;
  source: string;
  agent: string;
  agentAlias: string;
  /** Client/harness and model labels the agent sent; null when it sent none. */
  client: string | null;
  model: string | null;
  reviewer: string;
  status: string;
  reviewMode: "review" | "auto";
  autoApplied: boolean;
  reverted: boolean;
  acknowledged: boolean;
  pending: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  /** Hunks/ops that auto-applied. */
  applied: number;
  /** epoch ms */
  createdAt: number;
  updatedAt: number;
}
