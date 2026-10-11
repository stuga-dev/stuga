import { api } from "../lib/http/client";

/** One of your passkeys; never its key. */
export interface PasskeySummary {
  id: string;
  name: string;
  /** Synced to other devices, so removing it signs those out too. */
  synced: boolean;
  created_at: string;
  last_used_at: string | null;
  /** Made at a remote address the node no longer has: it signs in nowhere. */
  elsewhere?: boolean;
}

/** Where an invite or password link can point (GET /api/link-addresses). */
export interface LinkAddresses {
  /** The remote address is on. */
  remote: boolean;
  /** Who can open a link to the node's own address: anyone on its network, or this computer only. */
  local: "network" | "computer";
  default: "local" | "remote";
}

/** What Revoke everything takes from an account, counted before it does. */
export interface RevokeEverythingCounts {
  /** Sign-ins still on, at every address. */
  sessions: number;
  passkeys: number;
  /** Linked to the node's identity provider. */
  provider: boolean;
  apps: number;
  api_keys: number;
  invites: number;
  share_links: number;
}

export interface AiModel {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "ollama";
}

export const Me = {
  whoami: () =>
    api<{
      alias: string;
      display_name: string;
      /** Null for an agent key, which has no account of its own. */
      username: string | null;
      /** Optional contact address; unverified. */
      email: string | null;
      principals: string[];
      workspace_id: string;
      /** Administers the node, independent of any workspace role. */
      node_admin: boolean;
      /** A person's answer only: whether the account can sign in with a password. */
      has_password?: boolean;
      /** A person's answer only: whether the node's identity provider is linked to the account. */
      provider_linked?: boolean;
    }>("/api/whoami"),
  /** An empty name is refused (400); the reply is the name as stored. */
  setDisplayName: (name: string) =>
    api<{ alias: string; display_name: string }>("/api/whoami", {
      method: "PATCH",
      body: JSON.stringify({ display_name: name }),
    }),
  /** An empty string clears it. */
  setEmail: (email: string) =>
    api<{ alias: string; email: string | null }>("/api/whoami", {
      method: "PATCH",
      body: JSON.stringify({ email }),
    }),
  /** What Revoke everything would take from you. */
  revokeEverythingCounts: () => api<RevokeEverythingCounts>("/api/me/revoke-everything"),
  /** Your passkeys, newest first; added only at the remote address. */
  passkeys: () => api<{ passkeys: PasskeySummary[] }>("/api/me/passkeys").then((r) => r.passkeys),
  renamePasskey: (id: string, name: string) =>
    api<{ id: string; name: string }>(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  /** The sign-ins it made end with it; `signed_out` when this one was among them. */
  removePasskey: (id: string) =>
    api<{ removed: true; signed_out: boolean }>(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Not now to "Sign in faster next time", on every device. */
  dismissPasskeyOffer: () => api<void>("/api/me/passkey-offer/dismiss", { method: "POST" }),
  /** Where the links you make can point. */
  linkAddresses: () => api<LinkAddresses>("/api/link-addresses"),
  /** Empty while the node's AI chat is off. */
  models: () => api<AiModel[]>("/api/models"),
};

export interface UserInfo {
  alias: string;
  username: string | null;
  display_name: string;
  email: string | null;
  /** From a mention search: whether they can open the document. */
  can_open?: boolean;
}

/** Under the server's cap of 200 ids, and short enough for any proxy's URL limit. */
const USER_RESOLVE_CHUNK = 100;

export const Users = {
  /** Principals, with or without "user:", to directory rows; chunked and merged. */
  resolve: async (ids: string[]): Promise<{ users: UserInfo[] }> => {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += USER_RESOLVE_CHUNK) chunks.push(ids.slice(i, i + USER_RESOLVE_CHUNK));
    if (chunks.length === 0) return { users: [] };
    const pages = await Promise.all(
      chunks.map((chunk) => api<{ users: UserInfo[] }>(`/api/users?ids=${encodeURIComponent(chunk.join(","))}`)),
    );
    return { users: pages.flatMap((p) => p.users) };
  },
  /** Substring search by username, full name or email. */
  search: (q: string, init?: { signal?: AbortSignal }) =>
    api<{ users: UserInfo[] }>(`/api/users/search?q=${encodeURIComponent(q)}`, init),
  /** People to @mention in a document, marked with whether they can open it; any length, `""` included. */
  searchForMention: (q: string, docId: string) =>
    api<{ users: UserInfo[]; can_share: boolean; readers_only?: boolean }>(
      `/api/users/search?q=${encodeURIComponent(q)}&doc=${encodeURIComponent(docId)}`,
    ),
};
