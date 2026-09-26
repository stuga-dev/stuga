import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { api } from "../lib/http/client";
import type { AuditCursor, AuditEvent } from "./audit";
import type { MemberCandidate } from "./workspaces";

/** Keys are write-only: no response carries one. */
interface AiEndpointSettings {
  /** Semantic search's switch: false keeps its model but stops it. */
  enabled: boolean;
  /** Semantic search is in force: its switch is on and a model is set. */
  running: boolean;
  provider: "anthropic" | "openai" | "ollama";
  base_url: string;
  model?: string;
  api_key_set: boolean;
  /** The first 8 hex digits of the key's sha-256. */
  api_key_fingerprint: string | null;
  /** The database records a key whose file is missing from the data directory. */
  api_key_stale: boolean;
}

interface AiChatEndpointSettings {
  id: string;
  provider: "anthropic" | "openai" | "ollama";
  base_url: string;
  models: Array<{ id: string; name: string }>;
  api_key_set: boolean;
  api_key_fingerprint: string | null;
  api_key_stale: boolean;
}

/** Each half runs once it is set up; its switch only turns it off, keeping it. */
export interface NodeAiSettings {
  chat: {
    /** Chat's switch: false keeps the providers but stops chat. */
    enabled: boolean;
    /** Its switch is on and a saved provider offers a model. */
    running: boolean;
    /** Resolved against every endpoint's models. */
    default_model: string;
    /** Saved providers only. */
    endpoints: AiChatEndpointSettings[];
  };
  embed: AiEndpointSettings & {
    /** Maximum cosine distance (0 to 2] for a semantic match in the search box; null follows the default. */
    search_max_distance: number | null;
    /** The same for Ask, agents' retrieve and the assistants' document search. */
    retrieval_max_distance: number | null;
  };
  embedding_column_dims: number;
  /** What each cutoff is when none is stored. */
  max_distance_defaults: { search: number; retrieval: number };
  /** Where each provider listens when a base URL is left empty. */
  provider_base_urls: Record<"anthropic" | "openai" | "ollama", string>;
  updated_by: string | null;
  updated_at: string | null;
}

interface ChatEndpointProbe {
  id: string;
  ok: boolean;
  model?: string;
  latency_ms?: number;
  message?: string;
  skipped?: boolean;
}

export interface AiProbe {
  ok: boolean;
  /** A save skips endpoints it did not change; a test probes everything enabled. */
  chat: ChatEndpointProbe[];
  embed: { ok: boolean; model?: string; dims?: number; message?: string; skipped?: boolean };
}

/** `api_key`: absent keeps the stored key, "" deletes it, a value replaces it. Anything omitted is left as stored. */
export interface NodeAiSettingsInput {
  /** No endpoints removes chat and forgets its switch. */
  chat?: {
    /** Absent keeps the stored switch. */
    enabled?: boolean;
    default_model: string;
    endpoints: Array<{ id: string; provider: string; base_url: string; models: Array<{ id: string; name: string }>; api_key?: string }>;
  };
  /** A cutoff: absent keeps the stored one, null restores the default. */
  /** No model removes semantic search and forgets its switch. */
  embed?: {
    /** Absent keeps the stored switch. */
    enabled?: boolean;
    provider: string;
    base_url: string;
    model: string;
    api_key?: string;
    search_max_distance?: number | null;
    retrieval_max_distance?: number | null;
  };
}

export interface NodeAdmin {
  alias: string;
  display_name: string;
  username: string;
  email: string | null;
  granted_by: string | null;
  granted_at: string;
}

/** A release newer than the one running. */
export interface AvailableUpdate {
  version: string;
  /** YYYY-MM-DD. */
  released_at: string;
  /** Whether a release after the running one fixes a vulnerability. */
  security: boolean;
  notes_url: string;
}

/** Node administrators only. */
export interface NodeVersion {
  /** `0.0.0-dev` for a build from source. */
  version: string;
  build: "release" | "source";
  /** YYYY-MM-DD; null when the build does not say. */
  released_at: string | null;
  /** The code this build was made from: its tag for a release, the repository for a build from source. */
  source_url: string;
  /** The build that booted against this database before this one, if any. */
  previous_version: string | null;
  first_boot_at: string | null;
  last_boot_at: string | null;
  /** What the node knows about newer versions. */
  update: {
    /** False for a build from source, which has no release to compare with and never looks. */
    comparable: boolean;
    /** The last look, successful or not. */
    checked_at: string | null;
    /** Why the last look failed; null when it did not. */
    error: string | null;
    available: AvailableUpdate | null;
    /** The page that lists every release. */
    releases_url: string;
    /** A sentence saying how this packaging moves to a newer version. */
    upgrade_hint: string;
    /** Whether the machine installs a newer release on request (the Mac package), and how the last one went. */
    install: {
      available: boolean;
      status: {
        version: string;
        state: "downloading" | "verifying" | "installing" | "done" | "failed" | "refused";
        message: string;
        at: string;
      } | null;
    };
  };
}

/** The identity provider offered beside passwords. The client secret is write-only, like every credential here. */
export interface IdentityProviderSettings {
  /** Null when none is configured. */
  issuer: string | null;
  client_id: string | null;
  /** The stored button text; null shows `default_label`. */
  label: string | null;
  /** The issuer's host. */
  default_label: string | null;
  /** Null asks for `default_scopes`. */
  scopes: string | null;
  default_scopes: string;
  client_secret_set: boolean;
  client_secret_label: string | null;
  /** The database records a secret whose file is missing from the data directory. */
  client_secret_stale: boolean;
  /** One per origin this node answers on; each must be registered with the provider. */
  callback_urls: string[];
  /** Linked accounts with no password, which could not sign in with the provider removed. */
  accounts_without_password: number;
}

/** The non-AI settings, applied on save; `node` is what the environment and the first boot fixed. */
export interface NodeOperationalSettings {
  /** The name set here, shown in place of the product's; null until there is one. */
  node_name: string | null;
  /** What agents and the switcher call the node: the name, else PUBLIC_ORIGIN's host. Never empty. */
  node_label: string;
  limits: { max_upload_mb: number; ceiling_mb: number };
  maintenance: {
    audit_retention_days: number;
    database_ops_keep: number;
    ai_usage_retention_days: number;
    ask_thread_retention_days: number;
  };
  notify: {
    sink: string;
    email_from: string | null;
    /** Redacted labels only. */
    webhook_set: boolean;
    webhook_label: string | null;
    webhook_stale: boolean;
    smtp_set: boolean;
    smtp_label: string | null;
    smtp_stale: boolean;
  };
  branding: {
    accent_color: string | null;
  };
  /** Whether the node looks for a newer version once a day. */
  updates: { check: boolean };
  /** The daily backup: whether it runs, and its hour (0–23) in `time_zone`. */
  backups: { auto: boolean; hour: number };
  /** The node's time zone for scheduled work, an IANA name. */
  time_zone: string;
  /**
   * The languages search gets a tokenizer for. While `rebuilding`, and after a rebuild that gave up
   * (`error` says why), search uses the languages the old and the new choice share.
   */
  search: { languages: SearchLanguage[]; choices: SearchLanguage[]; rebuilding: boolean; error: string | null };
  identity_provider: IdentityProviderSettings;
  /** A sentence saying how an environment change takes effect. */
  restart_hint: string;
  node: {
    /** Chosen by the first boot; a rename never changes it. */
    node_id: string;
    public_origin: string;
    /** Further origins browsers may call this node from. */
    extra_origins: string[];
    bind: string;
    port: number;
    data_dir: string;
    database: string;
    embedding_dims: number;
  };
  updated_by: string | null;
  updated_at: string | null;
}

/** Omitted groups and keys are left alone. A credential: absent keeps it, "" deletes it, a value replaces it. */
export interface NodeOperationalSettingsInput {
  /** "" removes the name. */
  node_name?: string;
  limits?: { max_upload_mb?: number };
  maintenance?: {
    audit_retention_days?: number;
    database_ops_keep?: number;
    ai_usage_retention_days?: number;
    ask_thread_retention_days?: number;
  };
  notify?: { sink?: string; email_from?: string; webhook_url?: string; smtp_url?: string };
  branding?: { accent_color?: string };
  updates?: { check?: boolean };
  backups?: { auto?: boolean; hour?: number };
  /** An IANA name; null returns to UTC. */
  time_zone?: string | null;
  /** A change rebuilds the search indexes. */
  search?: { languages: SearchLanguage[] };
  /** Null removes it. `client_secret` is a credential; an empty `label` or `scopes` restores the default. */
  identity_provider?: { issuer: string; client_id: string; client_secret?: string; label?: string; scopes?: string } | null;
}

/** The node's backups and the daily schedule they follow. */
export interface NodeBackups {
  auto: boolean;
  hour: number;
  time_zone: string;
  /** When the next daily backup starts; null when they are off. */
  next_at: string | null;
  /** A backup is under way, or waiting to start. */
  running: boolean;
  /** Why a backup waits to start, such as a workspace being imported; null when none does. */
  waiting: string | null;
  /** The last daily or requested backup that was tried, and why it failed. */
  attempted_at: string | null;
  error: string | null;
  /** Where backups go, as the node sees the path, and how many are kept. */
  dir: string;
  keep: number;
  /** Newest first. */
  backups: Array<{ name: string; created_at: string; bytes: number; stuga_version: string | null; before_upgrade: boolean }>;
}

export interface NotifyProbe {
  ok: boolean;
  sink: string;
  message?: string;
}

export const NodeSettings = {
  ai: () => api<NodeAiSettings>("/api/node/ai-settings"),
  saveAi: (input: NodeAiSettingsInput) =>
    api<{ settings: NodeAiSettings; probe: AiProbe; reembed: { armed: boolean; chunks_cleared: number; workspaces: number } | null }>(
      "/api/node/ai-settings",
      { method: "PUT", body: JSON.stringify(input) },
    ),
  testAi: (input: NodeAiSettingsInput) =>
    api<AiProbe>("/api/node/ai-settings/test", { method: "POST", body: JSON.stringify(input) }),

  settings: () => api<NodeOperationalSettings>("/api/node/settings"),
  saveSettings: (input: NodeOperationalSettingsInput) =>
    api<NodeOperationalSettings>("/api/node/settings", { method: "PUT", body: JSON.stringify(input) }),
  testNotify: (input: NodeOperationalSettingsInput) =>
    api<NotifyProbe>("/api/node/settings/notify-test", { method: "POST", body: JSON.stringify(input) }),

  /** The provider's model list; empty, with a message, when it has none to offer. */
  discoverModels: (which: "chat" | "embed", provider: string, baseUrl: string, apiKey?: string) =>
    api<{ models: string[]; message?: string }>("/api/node/ai-settings/models", {
      method: "POST",
      body: JSON.stringify({ which, provider, base_url: baseUrl || undefined, api_key: apiKey || undefined }),
    }),

  admins: () => api<{ admins: NodeAdmin[] }>("/api/node/admins"),
  addAdmin: (username: string) =>
    api<{ alias: string; granted: boolean }>("/api/node/admins", { method: "POST", body: JSON.stringify({ username }) }),
  removeAdmin: (alias: string) =>
    api<{ revoked: boolean }>(`/api/node/admins/${encodeURIComponent(alias)}`, { method: "DELETE" }),

  /** Every account on the node by username or name, for picking one; names only, never emails. */
  users: (q: string, init?: { signal?: AbortSignal }) =>
    api<{ users: MemberCandidate[] }>(`/api/node/users?q=${encodeURIComponent(q)}`, init),

  /** A one-time link that sets the account's password, returned once. */
  mintPasswordReset: (username: string) =>
    api<{ url: string; alias: string; username: string; expires_at: string }>("/api/node/password-resets", {
      method: "POST",
      body: JSON.stringify({ username }),
    }),

  /** The node's own ledger, rows with no workspace, newest first. */
  audit: (filters: { limit?: number; before_at?: string; before_id?: number } = {}) => {
    const q = new URLSearchParams();
    if (filters.limit) q.set("limit", String(filters.limit));
    if (filters.before_at && filters.before_id !== undefined) {
      q.set("before_at", filters.before_at);
      q.set("before_id", String(filters.before_id));
    }
    const qs = q.toString();
    return api<{ events: AuditEvent[]; next_before: AuditCursor | null }>(`/api/node/audit${qs ? `?${qs}` : ""}`);
  },
  version: () => api<NodeVersion>("/api/node/version"),
  backups: () => api<NodeBackups>("/api/node/backups"),
  /** Start a backup now: the node pauses for it, then serves again. */
  backUpNow: () => api<{ started: true }>("/api/node/backups", { method: "POST" }),
  /** Look for a newer version now; answers like `version`, whether or not the node looked. */
  checkVersion: () => api<NodeVersion>("/api/node/version/check", { method: "POST" }),
  /** Ask the machine to install `version`, the newest the node knows of; the node restarts on it. */
  installVersion: (version: string) =>
    api<NodeVersion>("/api/node/version/install", { method: "POST", body: JSON.stringify({ version }) }),
};
