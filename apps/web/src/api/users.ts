import { api } from "../lib/http/client";

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
  /** Empty while the node's AI chat is off. */
  models: () => api<AiModel[]>("/api/models"),
};

export interface UserInfo {
  alias: string;
  username: string | null;
  display_name: string;
  email: string | null;
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
};
