/** Table row types. Query-specific inputs and result shapes live beside their functions. */
import type { SearchStrictness } from "@stuga/protocol/domain/search-strictness";
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
  /** Set while an archive is imported into it, which hides it from every list; null otherwise. */
  import_started_at: string | null;
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
  /** Seq of the latest processed snapshot, or of a version with its text; 0 before the first flush. */
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
  /** What the provider was asked to do about its own session: nothing, stay silent, ask which account, or sign in again. */
  prompt: "none" | "select_account" | "login" | null;
  link_alias: string | null;
  /** The sign-in of `link_alias` this flow confirms (prompt "login"); null for a sign-in or a link. */
  confirm_session: string | null;
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

/** Which listener issued a credential, and so the only one it is good at: the node's own on its network, or its remote address's. */
export type CredentialArrival = "local" | "remote";

/** How a session began. */
export type SignedInWith = "password" | "provider" | "passkey" | "reset" | "invite" | "setup";

export interface RefreshSessionRow {
  id: string;
  /** The sign-in this row's token continues: shared by its rotations, named by every access token as `sid`. */
  session_id: string;
  alias: string;
  token_hash: string;
  /** When the token lapses unused: never later than `absolute_expires_at`. */
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  /** The successor's token_hash when the row was rotated; null for any other revocation. */
  replaced_by: string | null;
  arrival: CredentialArrival;
  signed_in_with: SignedInWith;
  /** The passkey a sign-in made with one used (`credential_id`); removing it ends the sign-in. */
  passkey_id: string | null;
  signed_in_at: string;
  confirmed_at: string;
  /** At the remote address, when the session ends however often it renews; null on the node's own network. */
  absolute_expires_at: string | null;
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
  /**
   * The sink a delivery was queued for when the row was written, "none" when it was shown in Stuga
   * only; null for a row written before deliveries were recorded.
   */
  delivery_channel: string | null;
  /** When the sink took it. */
  delivered_at: string | null;
  /** Why the last attempt failed; cleared once one succeeds. */
  delivery_error: string | null;
}

export interface SearchResult {
  doc_id: string;
  title: string;
  doc_type: "prose" | "database";
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

/** One person's authorization of one OAuth client; revoked, never deleted. */
export interface OauthGrantRow {
  grant_id: string;
  client_id: string;
  /** What its runs are attributed to. */
  name: string;
  /** The host that served the client's metadata document; null = registered dynamically, unverified. */
  client_host: string | null;
  owner: string;
  /** The agent acts as `agent:<agent_id>`. */
  agent_id: string;
  /** The workspaces it may act in; null = every workspace its owner belongs to, now and later. */
  workspace_scope: string[] | null;
  access: ApiKeyAccess;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
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
  /** The search box's level; null takes the default. `custom` goes with `search_max_distance`. */
  search_strictness: SearchStrictness | null;
  /** A cosine distance for the search box's semantic leg, set through the API (level `custom`). */
  search_max_distance: number | null;
  /** A cosine distance for retrieval's semantic leg, set through the API; null for none. */
  retrieval_max_distance: number | null;
  /** False switches the reranker off while it stays set up. */
  rerank_enabled: boolean | null;
  rerank_base_url: string | null;
  rerank_model: string | null;
  rerank_api_key_fp: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/** A measurement of one embedding configuration (its key hashes everything that changes distances). */
export interface EmbedCalibrationRow {
  config_key: string;
  model: string;
  state: "running" | "ready" | "failed";
  /** The last successful measurement, as @stuga/ai's CalibrationResult; it stays in force while measured again. */
  result: Record<string, unknown> | null;
  error: string | null;
  error_kind: "endpoint" | "inseparable" | null;
  attempts: number;
  next_attempt_at: Date | null;
  triggered_by: string;
  started_at: Date;
  finished_at: Date | null;
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
  /** Whether the scheduled backup runs; null runs. */
  backup_auto: boolean | null;
  /** The hour the scheduled backup starts, 0–23 in time_zone; null is 3. */
  backup_hour: number | null;
  /** The weekday of a weekly backup, 0 (Sunday) to 6; null backs up every day. */
  backup_weekday: number | null;
  /** How many backups are kept, at least 1; null is 3. */
  backup_keep: number | null;
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

/** A relay as the last check-in listed it. */
export interface StoredRemoteRelay {
  name: string;
  addr: string;
  port: number;
  server_name: string;
  /** The relay's own self-signed certificate, one or two PEM blocks. */
  ca_pem: string;
}

/** What went wrong last with remote access; cleared by the next success of the same kind. */
export interface StoredRemoteError {
  code: string;
  message: string;
  /** ISO 8601. */
  at: string;
  retry_at?: string;
  /** The remote-access service's own error code, for `service_refused`. */
  service_code?: string;
  /** Why the service turned this address off, for `denied`. */
  reason?: string;
}

/** Remote access (docs/remote-access.md). Every column is a default until the node is bound. */
export interface NodeRemoteAccessRow {
  enabled: boolean;
  enabled_by: string | null;
  enabled_at: Date | null;
  remote_id: string | null;
  hostname: string | null;
  api_url: string | null;
  binding_thumbprint: string | null;
  bound_at: Date | null;
  binding_failing_since: Date | null;
  relays: StoredRemoteRelay[];
  acme_directory: string | null;
  acme_profile: string | null;
  acme_reissue_before: Date | null;
  acme_account_directory: string | null;
  acme_account_url: string | null;
  ca_terms_accepted_by: string | null;
  ca_terms_accepted_at: Date | null;
  ca_terms_url: string | null;
  cert_serial: string | null;
  cert_directory: string | null;
  cert_not_before: Date | null;
  cert_not_after: Date | null;
  cert_renew_at: Date | null;
  cert_reissue_before: Date | null;
  cert_failures: number;
  cert_retry_at: Date | null;
  cert_account_url: string | null;
  cert_ari_next_at: Date | null;
  cert_ari_window_start: Date | null;
  cert_ari_window_end: Date | null;
  cert_alerted_serial: string | null;
  checkin_at: Date | null;
  checkin_next_at: Date | null;
  credential_ttl: number | null;
  credential_not_before: Date | null;
  credential_issued_at: Date | null;
  credential_expires_at: Date | null;
  credential_refresh_at: Date | null;
  credential_failures: number;
  credential_retry_at: Date | null;
  probe_at: Date | null;
  probe_ok_at: Date | null;
  probe_failures: number;
  connector_config_sha256: string | null;
  connector_config_changed_at: Date | null;
  last_error: StoredRemoteError | null;
  updated_at: Date | null;
}
