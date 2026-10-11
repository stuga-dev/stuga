import type { CommentMention } from "@stuga/protocol/domain/mentions";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import { t } from "../i18n/i18n";
import { api } from "../lib/http/client";

export interface DocSummary {
  doc_id: string;
  title: string;
  /** "heading" while the title follows the document's first line; "user" once someone named it. */
  title_source: "heading" | "user";
  /** Full principal: `user:<alias>` or `agent:<id>`. */
  owner: string;
  doc_type: "prose" | "database";
  created_at: string;
  updated_at: string;
  trashed: boolean;
  /** Set exactly when `trashed`; the Trash countdown runs from it. */
  trashed_at: string | null;
  /** Null at the top level. */
  parent_id: string | null;
  /** Content frozen. */
  locked: boolean;
  /** Left out of every search surface. */
  search_hidden: boolean;
  /** Whether agent changes wait for a person or apply at once. */
  agent_mode: ReviewMode;
  /** For a database row's page: the database, and the row as `<table_id>.<row_id>`. Pages stay out of library lists. */
  page_of: string | null;
  page_row: string | null;
}

export interface SearchResult {
  doc_id: string;
  title: string;
  doc_type: "prose" | "database";
  /** Raw document text with highlights between ⟦ and ⟧; escape before rendering. */
  snippet: string;
  score: number;
  /** Above zero when the document is near the query in meaning; zero when only its words matched. */
  sem_score: number;
  page_of: string | null;
  page_row: string | null;
  updated_at: string;
}

export interface Comment {
  num: number;
  doc_id: string;
  /** The root comment a reply belongs to; null for a thread's first comment. */
  parent_num: number | null;
  author: string;
  body: string;
  /** Base64 Yjs RelativePositions of the anchored range; null for a document-level comment. */
  anchor_start: string | null;
  anchor_end: string | null;
  /** The text selected when the comment was made. */
  anchor_quote: string | null;
  resolved: boolean;
  /** The people its @usernames resolved to when it was saved. */
  mentions: CommentMention[];
  created_at: string;
}

/** A collaboration-safe text anchor: base64 Yjs RelativePositions plus the quoted text. */
export interface CommentAnchor {
  start: string;
  end: string;
  quote: string;
}

export interface Version {
  doc_id: string;
  seq: number;
  ts: string;
  authors: string[];
  /** Null when a snapshot could not be read (and, for the change counts, when there is no readable previous version): show nothing, never zero. */
  chars: number | null;
  chars_added: number | null;
  chars_removed: number | null;
}

export interface VersionListing {
  /** Newest first. */
  versions: Version[];
  /** The newest processed snapshot; ahead of every version when the latest edits recorded none. No version at or past it can be deleted. */
  head_seq: number;
  /** Whether the caller may restore and delete versions: they manage the doc and it is not locked. */
  can_manage: boolean;
}

/** Listing orders the server accepts; anything else falls back to its default. */
export type DocSort = "updated_at" | "created_at" | "title";
export type SortOrder = "asc" | "desc";

export interface AclModel {
  acl_principals: string[];
  /** Subset of acl_principals that may edit. */
  acl_writers: string[];
  /** Subset that may comment but not edit. */
  acl_commenters: string[];
  inherits: boolean;
  /** The folder inherited access comes from; `title` is null when the caller cannot read it. Null at the top level. */
  parent: { folder_id: string; title: string | null } | null;
  /** Always has access, so it is neither a direct grant nor inherited. */
  owner: string;
  /** The direct grants; everything else in acl_* is inherited from a parent folder. */
  own_grants: { p: string[]; w: string[]; c: string[] };
  /** The caller may change the sharing: the owner or a workspace admin. */
  can_manage: boolean;
}

export type ShareRole = "viewer" | "commenter" | "editor";

/** A share link that still opens the document. */
export interface ShareLinkInfo {
  token_hash: string;
  role: ShareRole;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  /** Null for a link whose address the node cannot show again; it still works until turned off. */
  link_url: string | null;
}

/** Someone who asked for access and still cannot open the item. */
export interface AccessRequest {
  /** `user:<alias>` */
  principal: string;
  requested_at: string;
}

/** An item's instructions for agents: its own text and what it inherits from the levels above it. */
export interface ItemInstructions {
  /** The item's own text, as stored. */
  own: string;
  /** The levels above the item that the caller can read, outermost first; empty ones left out. */
  inherited: InstructionLevel[];
  /** Whether the caller manages the item: its owner or a workspace admin. */
  can_edit: boolean;
}

export const Docs = {
  /**
   * `folderId`: a folder for its contents, null for the top level, undefined for
   * every document. Sorted server-side: the response is capped, so a client sort
   * would order only the capped window.
   */
  list: (
    trashedOnly = false,
    folderId?: string | null,
    opts?: { sort?: DocSort; order?: SortOrder; /** Full principal. */ owner?: string },
  ) => {
    const params = new URLSearchParams();
    if (trashedOnly) params.set("trashed_only", "true");
    if (folderId !== undefined) params.set("parent_id", folderId ?? "");
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.order) params.set("order", opts.order);
    if (opts?.owner) params.set("owner", opts.owner);
    const qs = params.toString();
    return api<{ docs: DocSummary[] }>(`/api/docs${qs ? `?${qs}` : ""}`);
  },
  /** Documents another member shared with the caller directly. */
  sharedWithMe: () => api<{ docs: DocSummary[] }>("/api/docs?shared=true"),
  /** Always succeeds, so it never reveals whether the document exists. */
  requestAccess: (id: string) =>
    api<{ requested: boolean }>(`/api/docs/${id}/request-access`, { method: "POST" }),
  /** Owner or workspace admin only. `agent_instructions` is stored verbatim. */
  setState: (
    id: string,
    state: { locked?: boolean; search_hidden?: boolean; agent_mode?: ReviewMode; agent_instructions?: string },
  ) => api<DocSummary>(`/api/docs/${id}/state`, { method: "PATCH", body: JSON.stringify(state) }),
  /** Any reader may ask; saving needs `can_edit`. */
  instructions: (id: string) => api<ItemInstructions>(`/api/docs/${id}/instructions`),
  createShareLink: (id: string, opts: { role?: ShareRole; expires_in_days?: number } = {}) =>
    api<{ token: string; link_url: string; role: ShareRole; expires_at: string | null }>(
      `/api/docs/${id}/share-links`,
      { method: "POST", body: JSON.stringify(opts) },
    ),
  /** The links that still open the document, newest first; owner or workspace admin. */
  shareLinks: (id: string) => api<{ links: ShareLinkInfo[] }>(`/api/docs/${id}/share-links`),
  /** A live link's new level, at the same address; people who already opened it keep their access. */
  setShareLinkRole: (id: string, tokenHash: string, role: ShareRole) =>
    api<{ token_hash: string; role: ShareRole }>(`/api/docs/${id}/share-links/${tokenHash}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  /** People who already opened the link keep their access. */
  revokeShareLink: (id: string, tokenHash: string) =>
    api<{ revoked: boolean }>(`/api/docs/${id}/share-links/${tokenHash}`, { method: "DELETE" }),
  /** Owner or workspace admin. */
  accessRequests: (id: string) => api<{ requests: AccessRequest[] }>(`/api/docs/${id}/access-requests`),
  dismissAccessRequest: (id: string, principal: string) =>
    api<{ dismissed: number }>(`/api/docs/${id}/access-requests/${encodeURIComponent(principal)}`, { method: "DELETE" }),
  redeemShareLink: (token: string) =>
    api<{ doc_id: string; workspace_id: string; role: string }>("/api/share-links/redeem", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  /**
   * A database arrives with its storage initialized, or the create fails as a whole. Its first table
   * takes the database's name (and keeps following it), or "Table 1" in the creator's language while
   * the database has none; it starts with Name, Notes and Done unless `columns` names its columns
   * (none: an empty table).
   */
  create: (title: string, parentId?: string | null, docType?: "prose" | "database", columns?: Array<{ name: string; type: string }>) =>
    api<DocSummary>("/api/docs", {
      method: "POST",
      body: JSON.stringify({
        title,
        parent_id: parentId ?? undefined,
        doc_type: docType ?? undefined,
        ...(docType === "database" && title.trim() === "" ? { table: t("database.tables.first") } : {}),
        columns,
      }),
    }),
  /** The server derives the title from the Markdown; `filename` is only its fallback. */
  createFromMarkdown: (markdown: string, filename?: string, parentId?: string | null) =>
    api<DocSummary>("/api/docs", {
      method: "POST",
      body: JSON.stringify({ markdown, filename, parent_id: parentId ?? undefined }),
    }),
  /** The document as Markdown, as the editor shows it now. */
  markdown: (id: string) => api<{ markdown: string }>(`/api/docs/${id}/markdown`),
  /** A copy of a document beside it, its body as written, named `title`. */
  copy: (id: string, title: string, parentId: string | null) =>
    api<DocSummary>("/api/docs", {
      method: "POST",
      body: JSON.stringify({ copy_of: id, title, parent_id: parentId ?? undefined }),
    }),
  move: (id: string, parentId: string | null) =>
    api<DocSummary>(`/api/docs/${id}`, { method: "PATCH", body: JSON.stringify({ parent_id: parentId }) }),
  get: (id: string) => api<DocSummary>(`/api/docs/${id}`),
  rename: (id: string, title: string) =>
    api<DocSummary>(`/api/docs/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  /** Move to Trash (`true`) or restore (`false`). */
  trash: (id: string, trashed: boolean) =>
    api<DocSummary>(`/api/docs/${id}`, { method: "PATCH", body: JSON.stringify({ trashed }) }),
  /** Delete permanently; owner only. */
  remove: (id: string) => api<{ deleted: boolean }>(`/api/docs/${id}`, { method: "DELETE" }),
  /**
   * `degraded`: the query could not be embedded, so only the keyword leg ran.
   * `keywordOnly` skips the semantic leg on purpose, for a quick answer while typing.
   * `limit` defaults to 20 on the server, which caps it at 100.
   */
  search: (q: string, opts: { keywordOnly?: boolean; limit?: number; signal?: AbortSignal } = {}) =>
    api<{ query: string; results: SearchResult[]; degraded: boolean }>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        q,
        ...(opts.keywordOnly ? { keyword_only: true } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      }),
      signal: opts.signal,
    }),
  versions: (id: string) => api<VersionListing>(`/api/docs/${id}/versions`),
  comments: (id: string) => api<{ comments: Comment[] }>(`/api/docs/${id}/comments`),
  addComment: (id: string, body: string, anchor?: CommentAnchor | null) =>
    api<Comment>(`/api/docs/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body,
        anchor_start: anchor?.start ?? null,
        anchor_end: anchor?.end ?? null,
        anchor_quote: anchor?.quote ?? null,
      }),
    }),
  /** A reply inherits its thread's anchor server-side. */
  replyComment: (id: string, parentNum: number, body: string) =>
    api<Comment>(`/api/docs/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, parent_num: parentNum }),
    }),
  resolveComment: (id: string, num: number, resolved: boolean) =>
    api<Comment>(`/api/docs/${id}/comments/${num}`, {
      method: "PATCH",
      body: JSON.stringify({ resolved }),
    }),
  deleteComment: (id: string, num: number) =>
    api<{ deleted: boolean }>(`/api/docs/${id}/comments/${num}`, { method: "DELETE" }),
  /** Plain text of a historical version. */
  versionContent: (id: string, seq: number) =>
    api<{ seq: number; text: string }>(`/api/docs/${id}/versions/${seq}`),
  /** Owner or workspace admin. */
  restoreVersion: (id: string, seq: number) =>
    api<{ restored: number; seq: number }>(`/api/docs/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({ seq }),
    }),
  /** Owner or workspace admin; the current version is refused. */
  deleteVersion: (id: string, seq: number) =>
    api<{ deleted: number }>(`/api/docs/${id}/versions/${seq}`, { method: "DELETE" }),
  getAcl: (id: string) => api<AclModel>(`/api/docs/${id}/acl`),
  /** Writers and commenters are subsets of `grants`; the rest are view-only. */
  setAcl: (
    id: string,
    grants: string[],
    writerGrants: string[],
    inherits: boolean,
    commenterGrants: string[] = [],
  ) =>
    api<{ acl_principals: string[]; acl_writers: string[] }>(`/api/docs/${id}/acl`, {
      method: "PUT",
      body: JSON.stringify({ grants, writer_grants: writerGrants, commenter_grants: commenterGrants, inherits }),
    }),
};
