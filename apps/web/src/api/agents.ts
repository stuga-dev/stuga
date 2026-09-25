import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { api, apiFailure, authedFetch } from "../lib/http/client";

/** A `vk_` key a machine client acts with, for the person who minted it. Apps that sign in are connections instead. */
export interface AgentKeyInfo {
  key_id: string;
  agent_id: string;
  /** `connector`: a retired key an OAuth sign-in once minted; sign-ins are connections now. */
  kind: "key" | "connector";
  name: string;
  /** The one tenant the key can act in. */
  workspace_id: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** The owner, the admin who removed them, or "system". */
  revoked_by: string | null;
  /** Folders (with subtrees) the key is confined to; null means the owner's whole reach. */
  scope_folders: string[] | null;
  /** `propose` writes through the run ledger; `read` writes nothing. */
  access: "read" | "propose";
  /** Null: no deadline. */
  expires_at: string | null;
  rotated_at: string | null;
}

/** `token` is returned once. */
interface MintedAgentKey {
  token: string;
  key_id: string;
  agent_id: string;
  principal: string;
  name: string;
  scope_folders: string[] | null;
  access: "read" | "propose";
  expires_at: string | null;
}

/** How a new key is narrowed below its owner's reach. */
export interface KeyNarrowing {
  scope_folders?: string[] | null;
  access?: "read" | "propose";
  expires_in_days?: number | null;
}

export const AgentKeys = {
  /** Every key the caller minted, across all their workspaces, so each stays revocable. */
  mine: () => api<{ keys: AgentKeyInfo[] }>("/api/keys"),
  revoke: (keyId: string) => api<{ revoked: boolean }>(`/api/keys/${keyId}`, { method: "DELETE" }),
  /** Pinned to the active workspace and acting with the caller's access. */
  create: (name: string, narrowing: KeyNarrowing = {}) =>
    api<MintedAgentKey>("/api/keys", { method: "POST", body: JSON.stringify({ name, ...narrowing }) }),
  /** A new secret for the same key; the old token stops working at once. */
  rotate: (keyId: string) => api<{ token: string; key_id: string }>(`/api/keys/${keyId}/rotate`, { method: "POST" }),
  /** How this agent is attributed. Two connections of one client are told apart here, not at minting. */
  rename: (keyId: string, name: string) => api<AgentKeyInfo>(`/api/keys/${keyId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
};

/** An app that signed in through OAuth: the person's grant of the workspaces they chose. */
export interface ConnectionInfo {
  grant_id: string;
  agent_id: string;
  name: string;
  client_id: string;
  /** The host that vouches for the app; null for one that registered itself. */
  verified_host: string | null;
  /** null: every workspace its person belongs to, now and later. */
  workspaces: string[] | null;
  access: "read" | "propose";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export const Connections = {
  mine: () => api<{ connections: ConnectionInfo[] }>("/api/me/connections"),
  rename: (grantId: string, name: string) =>
    api<ConnectionInfo>(`/api/me/connections/${grantId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  revoke: (grantId: string) => api<{ revoked: boolean }>(`/api/me/connections/${grantId}`, { method: "DELETE" }),
};

export interface WebhookInfo {
  webhook_id: string;
  url: string;
  events: string[];
  folder_id: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  failures: number;
  [k: string]: unknown;
}

export const Webhooks = {
  list: () => api<{ webhooks: WebhookInfo[]; event_types: readonly string[] }>("/api/webhooks"),
  /** The secret is returned once. */
  create: (input: { url: string; events: string[]; folder_id: string | null }) =>
    api<{ webhook: WebhookInfo; secret: string }>("/api/webhooks", { method: "POST", body: JSON.stringify(input) }),
  update: (webhookId: string, patch: { url?: string; events?: string[]; folder_id?: string | null; active?: boolean }) =>
    api<{ webhook: WebhookInfo }>(`/api/webhooks/${webhookId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (webhookId: string) => api<{ deleted: boolean }>(`/api/webhooks/${webhookId}`, { method: "DELETE" }),
};


export const Agents = {
  setup: () => api<AgentSetup>("/api/agent-setup"),

  /** The installable extension. It carries no credential: it signs in through the browser once installed. */
  bundle: async (): Promise<Blob> => {
    const res = await authedFetch("/api/agent-bundle");
    if (!res.ok) throw await apiFailure("/api/agent-bundle", "GET", res);
    return res.blob();
  },
};
