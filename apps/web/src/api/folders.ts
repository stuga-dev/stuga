import { api } from "../lib/http/client";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { AclModel, DocSort, ItemInstructions, SortOrder } from "./docs";

export interface Folder {
  folder_id: string;
  parent_id: string | null;
  title: string;
  /** Full principal: `user:<alias>` or `agent:<id>`. */
  owner: string;
  created_at: string;
  updated_at: string;
}

export const Folders = {
  /** `parentId`: a folder for its subfolders, null for the top level, undefined for every folder. Folders sort by title or updated_at only. */
  list: (parentId?: string | null, opts?: { sort?: DocSort; order?: SortOrder }) => {
    const params = new URLSearchParams();
    if (parentId !== undefined) params.set("parent_id", parentId ?? "");
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.order) params.set("order", opts.order);
    const qs = params.toString();
    return api<{ folders: Folder[] }>(`/api/folders${qs ? `?${qs}` : ""}`);
  },
  /** `instructions` are the folder's own instructions for agents; omit or pass "" for none. */
  create: (title: string, parentId?: string | null, instructions?: string) =>
    api<Folder>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ title, parent_id: parentId ?? undefined, ...(instructions ? { agent_instructions: instructions } : {}) }),
    }),
  rename: (id: string, title: string) =>
    api<Folder>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  move: (id: string, parentId: string | null) =>
    api<Folder>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ parent_id: parentId }) }),
  /** What a folder created under this parent (null = top level) would inherit, outermost first. */
  placementInstructions: (parentId: string | null) =>
    api<{ inherited: InstructionLevel[] }>(`/api/folders/instructions${parentId ? `?parent_id=${encodeURIComponent(parentId)}` : ""}`),
  /** Owner or workspace admin only; stored verbatim. */
  setInstructions: (id: string, text: string) =>
    api<Folder>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ agent_instructions: text }) }),
  /** Any reader may ask; saving needs `can_edit`. */
  instructions: (id: string) => api<ItemInstructions>(`/api/folders/${id}/instructions`),
  ancestors: (id: string) => api<{ ancestors: Folder[] }>(`/api/folders/${id}/ancestors`),
  /** Active documents and descendant folders, for the delete warning. */
  contents: (id: string) => api<{ docs: number; folders: number }>(`/api/folders/${id}/contents`),
  /** Owner only. Deletes the subtree; its documents move to Trash. */
  remove: (id: string) =>
    api<{ deleted: boolean; folders: number; docs_trashed: number }>(`/api/folders/${id}`, { method: "DELETE" }),
  getAcl: (id: string) => api<AclModel>(`/api/folders/${id}/acl`),
  /** Readers and writers only; the server cascades a share to inheriting descendants. */
  setAcl: (id: string, grants: string[], writerGrants: string[], inherits: boolean) =>
    api<{ acl_principals: string[]; acl_writers: string[] }>(`/api/folders/${id}/acl`, {
      method: "PUT",
      body: JSON.stringify({ grants, writer_grants: writerGrants, inherits }),
    }),
};
