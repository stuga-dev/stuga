/** Messages on the node's background job queue, produced by actors and routes. */
import type { AuditStatus } from "../domain/audit.js";
import type { ReviewMode } from "../domain/events.js";
import type { DocNotification } from "../notify/events.js";

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
  | NotifyApproversMessage
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
      /** ISO instant it happened, stamped by the sender when the feed compares it with other rows; absent, the insert time. */
      at?: string;
    }
  | {
      /** Deliver one event to one webhook. Retried by the queue on failure. */
      kind: "webhook_deliver";
      webhookId: string;
      eventId: number;
    };

/**
 * One in-app notification about a document for one recipient, also delivered to the configured
 * sink. It carries its event and params, never a sentence: each reader's language writes the text
 * (@stuga/protocol/notify/render). `params.doc` is the document's title as it was.
 */
export type NotifyMessage = {
  kind: "notify";
  /** The recipient's bare alias. */
  recipient: string;
  workspaceId: string | null;
  docId: string;
  /** Who caused it: an alias, or an agent's id. */
  actor: string;
  /** The comment it is about: its link opens that comment, and two mentions are two notifications. */
  commentNum?: number;
  /**
   * The thread a COMMENT_REPLY is in, `${rootNum}@${rootCreatedAtMs}`: replies in one thread within
   * the hour are one notification. The root's creation time keeps a reused number a new thread.
   */
  thread?: string;
  /** `docId` names a folder: the link opens it in the library. */
  folder?: true;
  /** The run it is about: the link opens its review card. */
  runId?: string;
} & DocNotification;

/**
 * Tell the people who may approve a run at `colleague` that it waits for them: an APPROVAL_WAITING
 * notification each, or APPROVER_NEEDED to the item's owner and admins when nobody may yet. The node
 * works out who they are when it runs, from who can edit the item then; the run's reviewer is never
 * one of them.
 */
export type NotifyApproversMessage = {
  kind: "notify_approvers";
  workspaceId: string;
  docId: string;
  runId: string;
  /** The person who asked the AI. */
  reviewer: string;
  /** The approver group the run was proposed under, or null. */
  approverGroup: string | null;
  /** The agent's id, which the notifications name as their actor. */
  actor: string;
  /** The agent's display name, the item's title and how many changes wait. */
  agent: string;
  doc: string;
  count: number;
  /**
   * Whether the person who asked was told that the run waits for a colleague, which a chat channel
   * then hears instead of a post per approver. The in-app co-author's runs tell nobody who is watching.
   */
  askerTold: boolean;
  /**
   * Set when a folder's approver group changed while the run waited: the group its item followed
   * before (null for none). Only those who may approve now and could not then are told.
   */
  groupBefore?: string | null;
};

/**
 * Hand one stored notification to the configured sink. Queued with the row it
 * belongs to, and retried by the queue on its own, so a failed delivery is
 * never mistaken for a duplicate notification.
 */
export type NotifyDeliverMessage = {
  kind: "notify_deliver";
  /** The sink it was queued for, stamped on its row as where it is being sent. */
  channel: string;
  /**
   * Which setup of that sink (its webhook, server and sender), as a short hash that gives none of
   * them away: a delivery goes only through the setup it was queued for.
   */
  channelKey?: string;
  /** The row it belongs to, which each attempt marks delivered or failed. Set as it is queued. */
  notificationId?: string;
  recipient: string;
  /** An address to email in place of the recipient's own: the old one, when they changed it. */
  to?: string;
  /** What it says, written in the recipient's language when it is sent (@stuga/protocol/notify/render). */
  eventType: string;
  params: Record<string, unknown>;
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
  reviewMode: ReviewMode;
  /** The approver group the run was proposed under, or null. */
  approverGroup: string | null;
  /** Who accepted its changes at `colleague`; never its reviewer. */
  approvedBy: string[];
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
