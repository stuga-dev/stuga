import type { DocAccessMode } from "@stuga/protocol/domain/workspaces";
import type { InviteRole, WorkspaceRole } from "@stuga/protocol/domain/roles";
import { api, apiFailure, authedFetch } from "../lib/http/client";
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

/** A workspace just made; one imported from an archive or a sample names the document to open first. */
export interface CreatedWorkspace extends WorkspaceInfo {
  start_doc_id?: string;
}

/** A published sample workspace a new one can start from. */
export interface WorkspaceSample {
  id: string;
  title: string;
  description: string;
  /** The new workspace's name. */
  name: string;
  /** The languages of its text, as primary language tags. */
  langs: string[];
}

/** The samples the node can offer; `unavailable` when it could not read their list. */
export interface WorkspaceSamples {
  samples: WorkspaceSample[];
  unavailable?: boolean;
}

interface WorkspaceList {
  workspaces: WorkspaceInfo[];
  active: string | null;
}

const workspaceList = cachedResource(() => api<WorkspaceList>("/api/workspaces"), 5_000);
const sampleList = cachedResource(() => api<WorkspaceSamples>("/api/workspace-samples"), 60_000);

/** Called whenever a write may have changed the workspace list, so long-lived controls can re-read it. */
export function onWorkspaceListChanged(fn: () => void): () => void {
  return workspaceList.subscribe(fn);
}

/** The name a download's Content-Disposition gives: the UTF-8 `filename*` when there is one. */
function attachmentName(res: Response): string | null {
  const disposition = res.headers.get("content-disposition") ?? "";
  const utf8 = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]!);
    } catch {
      // The plain name below.
    }
  }
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
}

/** An export's download, and an import's request, which the node answers once the import is done, each take as long as the workspace is large. */
const ARCHIVE_TIMEOUT_MS = 60 * 60_000;

/** A write that may change the list, failed ones included: an import the browser stopped waiting for goes on. */
async function invalidating<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } finally {
    workspaceList.invalidate();
  }
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
  /** The samples a new workspace can start from, as the node lists them. */
  samples: () => sampleList.get(),
  /** The samples asked for again, rather than as last listed: for a list the node could not offer. */
  samplesAgain: () => {
    sampleList.invalidate();
    return sampleList.get();
  },
  /** The samples as last listed, while that list is fresh; else undefined. */
  cachedSamples: () => sampleList.peek(),
  /** A new workspace holding a published sample, which the node downloads; the caller becomes the owner. */
  createFromSample: (sample: string, name: string, defaultDocAccess: DocAccessMode) =>
    invalidating(
      api<CreatedWorkspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, default_doc_access: defaultDocAccess, sample }),
        timeoutMs: ARCHIVE_TIMEOUT_MS,
      }),
    ),
  /** A new workspace holding a workspace archive's contents; the caller becomes the owner. */
  importArchive: (file: File, name: string, defaultDocAccess: DocAccessMode) =>
    invalidating(
      api<CreatedWorkspace>(
        `/api/workspaces/import?name=${encodeURIComponent(name)}&default_doc_access=${encodeURIComponent(defaultDocAccess)}`,
        { method: "POST", headers: { "content-type": "application/zip" }, body: file, timeoutMs: ARCHIVE_TIMEOUT_MS },
      ),
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
  /** Everything the caller can open, as a `.stuga.zip` archive; owners and admins. Fetched, since a link cannot carry the bearer. */
  exportArchive: async (workspaceId: string): Promise<{ blob: Blob; filename: string }> => {
    const path = `/api/workspaces/${workspaceId}/export`;
    const res = await authedFetch(path, { timeoutMs: ARCHIVE_TIMEOUT_MS });
    if (!res.ok) throw await apiFailure(path, "GET", res);
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch {
      // The node breaks the download when it cannot finish the archive; the browser's own words say less.
      throw new Error("The export stopped before it finished.");
    }
    return { blob, filename: attachmentName(res) ?? "workspace.stuga.zip" };
  },
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
