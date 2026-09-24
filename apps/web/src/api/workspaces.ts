import type { DocAccessMode } from "@stuga/protocol/domain/workspaces";
import type { InviteRole, WorkspaceRole } from "@stuga/protocol/domain/roles";
import { api } from "../lib/http/client";
import { cachedResource } from "../lib/store";

export interface WorkspaceInfo {
  workspace_id: string;
  name: string;
  role: WorkspaceRole;
  default_doc_access: DocAccessMode;
  /** Free-text conventions handed to every agent that connects. */
  agent_instructions: string;
  created_at: string;
}

export interface MemberInfo {
  workspace_id: string;
  alias: string;
  role: WorkspaceRole;
  joined_at: string;
  display_name: string | null;
  username: string | null;
  email: string | null;
}

/** Someone with an account on this node who could be added to a workspace. */
export interface MemberCandidate {
  alias: string;
  username: string | null;
  display_name: string;
}

/** An invite link that can still admit someone. Its token was shown once, when it was created. */
export interface InviteInfo {
  /** Names the link for revoking; it cannot be turned back into the link. */
  token_hash: string;
  /** The link's last few characters, to tell it apart from others; null for a link made before hints were kept. */
  token_hint: string | null;
  role: InviteRole;
  created_by: string;
  created_at: string;
  /** Null: the link does not lapse. */
  expires_at: string | null;
  /** Null: any number of people. */
  max_uses: number | null;
  use_count: number;
}

interface WorkspaceList {
  workspaces: WorkspaceInfo[];
  active: string | null;
}

const workspaceList = cachedResource(() => api<WorkspaceList>("/api/workspaces"), 5_000);

/** Called whenever a write may have changed the workspace list, so long-lived controls can re-read it. */
export function onWorkspaceListChanged(fn: () => void): () => void {
  return workspaceList.subscribe(fn);
}

async function invalidating<T>(request: Promise<T>): Promise<T> {
  const result = await request;
  workspaceList.invalidate();
  return result;
}

export const Workspaces = {
  /** The caller's workspaces and the one the server resolved as active. */
  list: () => workspaceList.get(),
  /** The caller becomes the owner. */
  create: (name: string, defaultDocAccess?: DocAccessMode) =>
    invalidating(
      api<WorkspaceInfo>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, default_doc_access: defaultDocAccess }),
      }),
    ),
  update: (
    workspaceId: string,
    patch: { name?: string; default_doc_access?: DocAccessMode; agent_instructions?: string },
  ) =>
    invalidating(
      api<WorkspaceInfo>(`/api/workspaces/${workspaceId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    ),
  /** Owner only and irreversible; `confirm` must echo the workspace's exact name. */
  deleteWorkspace: (workspaceId: string, confirm: string) =>
    invalidating(
      api<{ deleted: boolean; docs: number }>(`/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      }),
    ),
  members: (workspaceId: string) =>
    api<{ members: MemberInfo[] }>(`/api/workspaces/${workspaceId}/members`),
  /** Adds an existing account by username at once; nothing is sent. */
  /** Adds an existing account: one picked from memberCandidates by alias, or a typed username. */
  invite: (workspaceId: string, who: { alias: string } | { username: string }, role: WorkspaceRole = "member") =>
    api<{ invited: string; role: WorkspaceRole }>(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ ...who, role }),
    }),
  /** Accounts on this node that are not members yet, by username or name; owners and admins only. */
  memberCandidates: (workspaceId: string, q: string, init?: { signal?: AbortSignal }) =>
    api<{ users: MemberCandidate[] }>(
      `/api/workspaces/${workspaceId}/member-candidates?q=${encodeURIComponent(q)}`,
      init,
    ),
  setRole: (workspaceId: string, alias: string, role: WorkspaceRole) =>
    invalidating(
      api<{ alias: string; role: WorkspaceRole }>(`/api/workspaces/${workspaceId}/members/${alias}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    ),
  remove: (workspaceId: string, alias: string) =>
    invalidating(
      api<{ removed: string }>(`/api/workspaces/${workspaceId}/members/${alias}`, { method: "DELETE" }),
    ),
  /** The token is returned once. Omit a limit for none; an admin link must admit one person. */
  createInvite: (
    workspaceId: string,
    opts: { role?: InviteRole; expires_in_days?: number; max_uses?: number } = {},
  ) =>
    api<{
      token: string;
      token_hash: string;
      join_url: string;
      role: InviteRole;
      expires_at: string | null;
      max_uses: number | null;
    }>(
      `/api/workspaces/${workspaceId}/invites`,
      { method: "POST", body: JSON.stringify(opts) },
    ),
  /** Links that can still admit someone, newest first. */
  listInvites: (workspaceId: string) => api<{ invites: InviteInfo[] }>(`/api/workspaces/${workspaceId}/invites`),
  revokeInvite: (workspaceId: string, tokenHash: string) =>
    api<{ revoked: boolean }>(`/api/workspaces/${workspaceId}/invites/${tokenHash}`, { method: "DELETE" }),
  redeemInvite: (token: string) =>
    invalidating(
      api<{ workspace_id: string; role: WorkspaceRole }>("/api/invites/redeem", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    ),
};
