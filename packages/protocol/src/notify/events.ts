/**
 * What a notification is made of. A producer stores its event type and these params, never a
 * sentence: the text is written when someone reads it, in their language (./render.ts), in the
 * tray and in what the node sends outside the app. Names, titles and addresses in the params are
 * data and stay as they were written; instants are ISO strings.
 */
import type { ReviewMode } from "../domain/events";

/** A notification channel as an alert names it: which service, and where, never its secret. */
export interface ChannelParams {
  /** A NOTIFY_SINKS value; anything else reads as Stuga only. */
  sink: string;
  /** The webhook's host, when it has one. */
  host: string | null;
  /** The email sender, when one is set. */
  from: string | null;
  /** Only the webhook or the mail server changed, which the name alone would not show. */
  another?: boolean;
}

/** One database change an agent made, as its notification says it. */
export type DatabaseChange =
  | {
      kind:
        | "table_created"
        | "table_renamed"
        | "table_deleted"
        | "column_added"
        | "column_described"
        | "column_type_changed"
        | "column_format_changed"
        | "column_renamed"
        | "column_deleted"
        | "view_created"
        | "view_changed"
        | "view_deleted"
        | "row_page_created";
    }
  | { kind: "rows_inserted" | "rows_updated" | "rows_deleted" | "row_pages_created" | "changes_made"; count: number }
  | { kind: "rows_imported"; count: number; table: string };

/**
 * Who wrote a comment, as a notice names them: a person by their display name, an agent or an AI
 * co-author by the display name of the person it acts for, never by a name the agent's client chose.
 */
export type ActorParam = string | { agent_of: string } | { coauthor_of: string };

/**
 * Why a reply's notice reaches its reader: it answers their comment, their AI co-author's question
 * or their agent's comment, or it is in a thread they (or their co-author or agent) wrote in.
 */
export type CommentReplyRelation = "comment" | "coauthor_question" | "agent_comment" | "thread";

/** Every notification event and the params its text is written from. */
export interface NotificationParams {
  /** `excerpt` is the comment's own text. */
  MENTIONED_IN_COMMENT: { actor: ActorParam; doc: string; excerpt: string };
  COMMENT_ON_OWNED_DOC: { actor: ActorParam; doc: string; kind: "comment" | "reply"; excerpt: string };
  COMMENT_REPLY: { actor: ActorParam; doc: string; excerpt: string; relation: CommentReplyRelation };
  DIRECT_DOC_PERMISSIONS: { actor: string; doc: string };
  REQUEST_ACCESS: { actor: string; doc: string };
  /** `actor` is null when an agent's edit made the mention. */
  MENTIONED_IN_DOC: { actor: string | null; doc: string; excerpt: string };
  DATABASE_AGENT_EDIT: { actor: string; doc: string; change: DatabaseChange };
  /** `waits`: who approves, the recipient (who asked the AI) or a colleague. */
  DATABASE_AGENT_PROPOSED: { agent: string; doc: string; count: number; waits: "you" | "colleague" };
  AGENT_EDITS_PROPOSED: { agent: string; doc: string; count: number; waits: "you" | "colleague" };
  AGENT_EDITS_APPLIED: { agent: string; doc: string };
  /** To each person who may approve: `author` asked `agent`, whose changes wait for their approval. */
  APPROVAL_WAITING: { agent: string; author: string; doc: string; count: number };
  /**
   * To the item's owner and the workspace's admins who can read it, the person who asked left out:
   * changes `author`'s `agent` proposed wait at `colleague`, and nobody may approve them yet, because
   * nobody else can edit the item (`nobody`) or nobody in its approver group can (`group`).
   */
  APPROVER_NEEDED: { agent: string; author: string; doc: string; count: number; cause: "nobody" | "group" };
  /** To whoever asked: `agent` proposed changes for the change titled `change`, once per change. */
  CHANGE_PROPOSED: { agent: string; change: string };
  /** To whoever asked: `agent`'s change titled `change` changed pages that let AI edits apply directly, once per change. */
  CHANGE_APPLIED: { agent: string; change: string };
  /** To each person who may approve a page of the change titled `change`, once per change. */
  CHANGE_APPROVAL_WAITING: { agent: string; author: string; change: string };
  /**
   * To the workspace's other administrators who can read it: `actor` set how AI edits to `doc` (a
   * document, database or folder) are reviewed to `level`, looser than before, or `moved` it where
   * they are; `floor` is the level its folder set when `level` is below it, else null.
   */
  REVIEW_LEVEL_LOWERED: {
    actor: string;
    doc: string;
    kind: "document" | "database" | "folder";
    level: ReviewMode;
    floor: ReviewMode | null;
    moved: boolean;
  };

  ACCOUNT_NEW_SIGN_IN: { host: string; device: string; at: string; from: string };
  MEMBER_NEW_SIGN_IN: { name: string; host: string; device: string; at: string; from: string };
  /** `recourse`: whether another administrator can act for them, or only the node's machine. */
  ACCOUNT_PASSWORD_CHANGED: { how: "changed" | "reset"; device: string; at: string; recourse: "administrator" | "machine" };
  MEMBER_PASSWORD_CHANGED: { name: string; how: "changed" | "reset"; host: string; device: string; at: string };
  /** `by` is the administrator who did it; null when the person did. */
  ACCOUNT_EVERYTHING_REVOKED: { by: string | null; device: string; at: string };
  MEMBER_EVERYTHING_REVOKED: { name: string; by: string | null; at: string };
  ACCOUNT_API_KEY_CREATED: { key: string };
  ACCOUNT_PASSKEY_ADDED: { host: string; passkey: string; device: string; at: string; from: string };
  ACCOUNT_PASSKEY_REMOVED: { passkey: string };
  ACCOUNT_APP_CONNECTED: { host: string; app: string; appHost: string };
  /** `to` is null when the address was removed. */
  ACCOUNT_EMAIL_CHANGED: { to: string | null; device: string; at: string };
  MEMBER_EMAIL_CHANGED: { name: string; how: "changed" | "removed"; device: string; at: string };
  /** `host` is null when it happened on the node's own network. */
  ACCOUNT_SIGN_INS_PAUSED: { username: string; host: string | null };
  NODE_NOTIFY_CHANNEL_CHANGED: { by: string; before: ChannelParams; after: ChannelParams; device: string; at: string };

  SECURITY_UPDATE_AVAILABLE: { running: string; latest: string; securityVersion: string };
  /** `error` is what the backup reported, as it reported it. */
  BACKUP_FAILED: { error: string };
  /** What the node's notification settings send to try a channel. */
  NODE_TEST_NOTIFICATION: Record<string, never>;
  /** `detail` is the certificate service's own explanation, as it gave it. */
  REMOTE_CERT_RENEWAL_FAILED: { address: string; expires: string; detail: string | null };
  REMOTE_CERT_EXPIRING: { address: string; expires: string };
  REMOTE_CERT_EXPIRED: { address: string };
  REMOTE_CERT_RECOVERED: { address: string; expires: string };
  /** `refused`: the service no longer takes the node's key; `key_unusable`: the node lost it or can't read it. */
  REMOTE_BINDING_REJECTED: { address: string | null; reason: "refused" | "key_unusable" };
  REMOTE_ADDRESS_MOVED: { address: string };
  /** This release is older than the remote-access service allows; `version` is the one to update to, or later. */
  REMOTE_UPDATE_REQUIRED: { address: string; version: string };
}

export type NotificationEvent = keyof NotificationParams;

/** The events about one document, which reach their recipient through the job queue (NotifyMessage). */
export type DocNotificationEvent =
  | "MENTIONED_IN_COMMENT"
  | "COMMENT_ON_OWNED_DOC"
  | "COMMENT_REPLY"
  | "DIRECT_DOC_PERMISSIONS"
  | "REQUEST_ACCESS"
  | "MENTIONED_IN_DOC"
  | "DATABASE_AGENT_EDIT"
  | "DATABASE_AGENT_PROPOSED"
  | "AGENT_EDITS_PROPOSED"
  | "AGENT_EDITS_APPLIED"
  | "APPROVAL_WAITING"
  | "APPROVER_NEEDED"
  | "REVIEW_LEVEL_LOWERED";

/** An event with its params, typed together. */
export type NotificationOf<E extends NotificationEvent> = { eventType: E; params: NotificationParams[E] };

/** Any one notification's event and params. */
export type AnyNotification = { [E in NotificationEvent]: NotificationOf<E> }[NotificationEvent];

/** One document event with its params. */
export type DocNotification = { [E in DocNotificationEvent]: NotificationOf<E> }[DocNotificationEvent];

/** An event and its params as a producer hands them on: typed where it is made, stored as JSON. */
export function notification<E extends NotificationEvent>(eventType: E, params: NotificationParams[E]): { eventType: E; params: NotificationParams[E] } {
  return { eventType, params };
}

/** Instant params, formatted for the reader when the text is written. */
export const TIME_PARAMS: readonly string[] = ["at", "expires"];

/**
 * Why a delivery outside the app did not happen, as a notification row stores it: a code, or
 * `sink_answered:<status>`, or `failed:<what the channel said>`. The reader's app words it.
 */
export const DELIVERY_ERROR_CODES = [
  "email_not_set_up",
  "no_email_address",
  "no_sink",
  "no_webhook_url",
  "channel_changed",
  "node_restarted",
  "not_sent",
] as const;

export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

/** A stored delivery error, split into its code and what came with it. */
export function parseDeliveryError(
  stored: string,
): { code: DeliveryErrorCode } | { code: "sink_answered"; status: string } | { code: "failed"; detail: string } {
  if ((DELIVERY_ERROR_CODES as readonly string[]).includes(stored)) return { code: stored as DeliveryErrorCode };
  if (stored.startsWith("sink_answered:")) return { code: "sink_answered", status: stored.slice("sink_answered:".length) };
  return { code: "failed", detail: stored.startsWith("failed:") ? stored.slice("failed:".length) : stored };
}
