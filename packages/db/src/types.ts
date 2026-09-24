/** Table row types. Query-specific inputs and result shapes live beside their functions. */
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";

export interface WorkspaceRow {
  workspace_id: string;
  name: string;
  default_doc_access: string;
  /** Set while the corpus needs vectors it lacks; drives the embedding backfill. */
  embedding_backfill_at: string | null;
  /** The last doc_id that backfill pass enqueued. */
  embedding_backfill_cursor: string | null;
  /** Conventions handed to every agent that connects; empty when none were written. */
  agent_instructions: string;
  created_at: string;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  /** Principal id without the "user:" prefix. */
  alias: string;
  role: WorkspaceRole;
  joined_at: string;
}

export interface DocRow {
  doc_id: string;
  workspace_id: string;
  /** Full principal: `user:<alias>` or `agent:<id>`. */
  owner: string;
  title: string;
  /** 'heading': derived from the first heading on each flush; 'user': an explicit rename indexing must keep. */
  title_source: "heading" | "user";
  doc_type: "prose" | "database";
  parent_id: string | null;
  /** Seq of the latest indexed snapshot; 0 before the first flush. */
  snapshot_seq: number;
  /** Oldest snapshot seq still in the version ring; null when the document publishes no ring. */
  version_floor: number | null;
  trashed: boolean;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
  acl_principals: string[];
  acl_writers: string[];
  /** Comment-only grants; a writer can always comment. */
  acl_commenters: string[];
  inherits_perms: boolean;
  locked: boolean;
  locked_by: string | null;
  locked_at: string | null;
  /** Kept out of every search and retrieval surface, still browsable. */
  search_hidden: boolean;
  own_grants: OwnGrantsJson;
  /** The principal that created the row. Provenance only. */
  created_by: string | null;
  /** Whether agent proposals wait for a person or apply at once. */
  agent_mode: ReviewMode;
  /** Instructions for agents on this item (a database's reach its row pages); '' when none. */
  agent_instructions: string;
  /** The database this document is a row page of. */
  page_of: string | null;
  /** `<table_id>.<row_id>`; meaningful only beside a non-null `page_of`. */
  page_row: string | null;
}

/** Grants set directly on a resource, before inheritance is flattened in. */
export interface OwnGrantsJson {
  p: string[];
  w: string[];
  c: string[];
}

export interface FolderRow {
  folder_id: string;
  workspace_id: string;
  parent_id: string | null;
  /** Full principal: `user:<alias>` or `agent:<id>`. */
  owner: string;
  title: string;
  acl_principals: string[];
  acl_writers: string[];
  inherits_perms: boolean;
  own_grants: OwnGrantsJson;
  /** Instructions for agents on everything beneath this folder; '' when none. */
  agent_instructions: string;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  doc_id: string;
  seq: number;
  ts: string;
  authors: string[];
  blob_key: string;
  /** Null when the previous snapshot could not be read. */
  chars: number | null;
  chars_added: number | null;
  chars_removed: number | null;
}

export interface CollectionRow {
  collection_id: string;
  workspace_id: string;
  owner: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionSummary extends CollectionRow {
  item_count: number;
}

/** A doc or a folder member of a collection, with its current title. */
export interface CollectionItemRow {
  doc_id: string | null;
  folder_id: string | null;
  title: string;
  added_at: string;
}

export interface AskThreadRow {
  thread_id: string;
  workspace_id: string;
  owner: string;
  title: string;
  collection_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AskThreadSummary extends AskThreadRow {
  turn_count: number;
  last_question: string | null;
}

/** `citations` and `steps` are JSONB the caller narrows. */
export interface AskTurnRow {
  thread_id: string;
  seq: number;
  question: string;
  answer: string;
  citations: unknown[];
  steps: unknown[];
  model: string;
  rounds: number;
  stop_reason: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

/** What the directory shows other people about an account; never how it signs in. */
export interface UserRow {
  /** Principal id without the "user:" prefix. */
  alias: string;
  /** The handle the account signs in and is @mentioned with; stored normalized. */
  username: string;
  /** Chosen when the account is made, then changed only by the person. */
  display_name: string;
  /** Optional and unverified. */
  email: string | null;
  updated_at: string;
}

/** The directory columns a request reads for its caller. */
export interface DirectoryRow {
  display_name: string;
  username: string;
  email: string | null;
}

/** How an account signs in. Node administration lives in node_admins. */
export interface AccountRow {
  alias: string;
  username: string;
  /** Null when the account has no local password yet. */
  password_hash: string | null;
  /** The identity provider's subject, when linked. */
  oidc_sub: string | null;
}

/** A sign-in through the identity provider, between its start and its callback. */
export interface OidcFlowRow {
  state: string;
  binding_hash: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  /** What the provider was asked to do about its own session: nothing, stay silent, or ask which account. */
  prompt: "none" | "select_account" | null;
  link_alias: string | null;
  return_to: string;
  expires_at: Date;
  created_at: Date;
}

/** A session handoff (`alias` set) or a first-visit ticket (`sub` set). */
export interface OidcTicketRow {
  ticket_hash: string;
  kind: "session" | "first_visit";
  binding_hash: string;
  alias: string | null;
  sub: string | null;
  /** The issuer that vouched for `sub`; set on a first-visit ticket only. */
  issuer: string | null;
  preferred_username: string | null;
  name: string | null;
  email: string | null;
  return_to: string;
  expires_at: Date;
  created_at: Date;
}

/** One of a person's bookmarks to another Stuga node. */
export interface UserNodeRow {
  id: string;
  label: string;
  /** Scheme, host and port only. */
  origin: string;
}

export interface RefreshSessionRow {
  id: string;
  alias: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  /** The successor's token_hash when the row was rotated; null for any other revocation. */
  replaced_by: string | null;
}

export interface CommentRow {
  doc_id: string;
  num: number;
  /** The root comment this replies to; null for a root. */
  parent_num: number | null;
  author: string;
  body: string;
  /** Base64 Yjs RelativePositions; null on an unanchored comment and on every reply. */
  anchor_start: string | null;
  anchor_end: string | null;
  anchor_quote: string | null;
  resolved: boolean;
  reactions: Record<string, string[]>;
  /** The people its @usernames resolved to when it was saved. */
  mentions: Array<{ alias: string; username: string }>;
  created_at: string;
  updated_at: string;
}

export interface GroupRow {
  group_id: string;
  workspace_id: string;
  members: string[];
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  workspace_id: string | null;
  recipient_alias: string;
  event_type: string;
  resource_id: string | null;
  resource_title: string | null;
  resource_url: string | null;
  actor_alias: string | null;
  payload: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

export interface SearchResult {
  doc_id: string;
  title: string;
  page_of: string | null;
  page_row: string | null;
  snippet: string;
  kw_rank: number;
  sem_score: number;
  score: number;
}

/** One retrieved passage; `score` is the RRF fusion of its keyword and semantic ranks. */
export interface AskChunk {
  doc_id: string;
  title: string;
  chunk_index: number;
  content: string;
  heading_path: string | null;
  sem_score: number;
  score: number;
}

export type ApiKeyAccess = "read" | "propose";

/** A machine-client credential; only the secret's sha-256 is stored. */
export interface ApiKeyRow {
  key_id: string;
  secret_hash: string;
  /** The agent acts as `agent:<agent_id>`. */
  agent_id: string;
  /** Alias of the human who issued the key. */
  owner: string;
  workspace_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** The owner, a workspace admin, or 'system'. */
  revoked_by: string | null;
  /** Folder ids (each with its subtree) the key may act in; null = the owner's whole reach. */
  scope_folders: string[] | null;
  access: ApiKeyAccess;
  expires_at: string | null;
  rotated_at: string | null;
}

export interface ShareLinkRow {
  token_hash: string;
  doc_id: string;
  workspace_id: string;
  role: "viewer" | "commenter" | "editor";
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface WorkspaceInviteRow {
  token_hash: string;
  token_hint: string | null;
  workspace_id: string;
  role: WorkspaceRole;
  created_by: string;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
  created_at: string;
}

/** The inbox mirror of one actor-side run. */
export interface AgentRunRow {
  run_id: string;
  workspace_id: string;
  doc_id: string;
  doc_kind: "prose" | "database";
  doc_title: string;
  source: string;
  agent: string;
  agent_alias: string;
  client: string | null;
  model: string | null;
  reviewer: string;
  status: string;
  review_mode: ReviewMode;
  auto_applied: boolean;
  reverted: boolean;
  acknowledged: boolean;
  pending: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  applied: number;
  created_at: string;
  updated_at: string;
}

/** Per-agent aggregates over agent_runs. */
export interface AgentStatsRow {
  agent_alias: string;
  agent: string;
  runs: number;
  open_runs: number;
  pending: number;
  accepted: number;
  rejected: number;
  applied: number;
  reverted_runs: number;
  last_active_at: string;
}

export interface WorkspaceEventRow {
  id: number;
  workspace_id: string;
  at: string;
  type: string;
  doc_id: string | null;
  actor: string;
  actor_kind: "human" | "agent" | "internal";
  payload: Record<string, unknown>;
}

export interface WebhookRow {
  webhook_id: string;
  workspace_id: string;
  url: string;
  secret: string;
  /** Event types delivered; empty = every type. */
  events: string[];
  folder_id: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  /** Consecutive failed deliveries; reset by a success. */
  failures: number;
}

export type AiUsageKind = "coauthor" | "embedding" | "ask" | "table_coauthor";
export type AiUsageStatus = "ok" | "error" | "disabled";

/** One model call's raw token counts. Telemetry only: nothing gates on them. */
export interface AiUsageInsert {
  alias: string;
  workspaceId: string | null;
  docId: string | null;
  kind: AiUsageKind;
  model: string;
  status?: AiUsageStatus;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `internal` is the node itself; `agent` is an API-key or MCP caller. */
export type AuditActorKind = "human" | "agent" | "internal";

export type AuditSource = "web" | "mcp" | "api-key" | "ws" | "internal" | "cron";

export interface AuditEventRow {
  id: number;
  request_id: string | null;
  at: Date;
  workspace_id: string | null;
  actor: string;
  actor_kind: AuditActorKind;
  /** The human an agent acted for. */
  on_behalf_of: string | null;
  source: AuditSource;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  /** The target's name as it read when the row was written. */
  target_label: string | null;
  status: string;
  detail: Record<string, unknown>;
}

export interface AuditEventInsert {
  requestId?: string | null;
  /** Defaults to the server clock. Stored truncated to milliseconds either way. */
  at?: Date | string | null;
  workspaceId: string | null;
  actor: string;
  actorKind: AuditActorKind;
  onBehalfOf?: string | null;
  source: AuditSource;
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  status?: string;
  detail?: Record<string, unknown>;
}

/** One chat endpoint in `node_ai_settings.chat_endpoints`; the API key is only a fingerprint. */
export interface StoredChatEndpoint {
  id: string;
  provider: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  apiKeyFp: string | null;
}

/** NULL fields are not set here. */
export interface NodeAiSettingsRow {
  /** False switches chat off while its providers stay saved. */
  chat_enabled: boolean | null;
  /** False switches semantic search off while its model stays set. */
  embed_enabled: boolean | null;
  chat_default_model: string | null;
  chat_endpoints: StoredChatEndpoint[];
  embed_provider: string | null;
  embed_base_url: string | null;
  embed_model: string | null;
  embed_api_key_fp: string | null;
  /** Maximum cosine distance for search's semantic leg. */
  search_max_distance: number | null;
  /** Maximum cosine distance for retrieval's semantic leg. */
  retrieval_max_distance: number | null;
  updated_by: string | null;
  updated_at: Date;
}

/** NULL fields are not set here; a retention of 0 keeps every row. */
export interface NodeSettingsRow {
  /** Null shows PUBLIC_ORIGIN's host. */
  node_name: string | null;
  max_upload_bytes: number | null;
  audit_retention_days: number | null;
  database_ops_keep: number | null;
  ai_usage_retention_days: number | null;
  ask_thread_retention_days: number | null;
  notify_sink: string | null;
  /** Redacted; the URL itself is a secret file. */
  notify_webhook_label: string | null;
  smtp_label: string | null;
  email_from: string | null;
  brand_accent_color: string | null;
  /** Whether the node looks for a newer version; null looks. */
  update_check: boolean | null;
  /** Whether the daily backup runs; null runs. */
  backup_auto: boolean | null;
  /** The hour the daily backup starts, 0–23 in time_zone; null is 3. */
  backup_hour: number | null;
  /** An IANA time zone name for scheduled work; null is UTC. */
  time_zone: string | null;
  /** Set together with idp_client_id, or neither. */
  idp_issuer: string | null;
  idp_client_id: string | null;
  /** A fingerprint; the secret itself is a file. */
  idp_client_secret_label: string | null;
  idp_label: string | null;
  idp_scopes: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export interface NodeAdminRow {
  alias: string;
  /** Null for the bootstrap grant. */
  granted_by: string | null;
  granted_at: Date;
}

export interface NodeStateRow {
  /** Chosen by the first boot; a rename never changes it. */
  node_id: string;
  app_version: string;
  first_boot_at: Date;
  last_boot_at: Date;
  /** The last look for a newer version, successful or not; null before the first. */
  update_checked_at: Date | null;
  /** What the last successful look listed, as it was stored; a failed look keeps it. */
  update_feed: unknown;
  /** Why the last look failed; null when it succeeded. */
  update_check_error: string | null;
  /** When the last scheduled backup was tried; null before the first. */
  backup_attempted_at: Date | null;
  /** Why it failed; null when it did not. */
  backup_error: string | null;
}
