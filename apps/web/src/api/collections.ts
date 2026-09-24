import { api } from "../lib/http/client";

export interface CollectionSummary {
  collection_id: string;
  name: string;
  item_count: number;
  updated_at: string;
}

export interface CollectionItem {
  doc_id: string | null;
  folder_id: string | null;
  title: string;
}

export const Collections = {
  list: () => api<{ collections: CollectionSummary[] }>("/api/collections"),
  create: (name: string) =>
    api<CollectionSummary>("/api/collections", { method: "POST", body: JSON.stringify({ name }) }),
  get: (id: string) =>
    api<{ collection: CollectionSummary; items: CollectionItem[] }>(`/api/collections/${id}`),
  rename: (id: string, name: string) =>
    api<CollectionSummary>(`/api/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  remove: (id: string) => api<{ deleted: boolean }>(`/api/collections/${id}`, { method: "DELETE" }),
  /** `added` counts new members; `skipped` counts refs the caller cannot see, which the server drops. */
  addItems: (id: string, refs: { docIds?: string[]; folderIds?: string[] }) =>
    api<{ added: number; skipped: number }>(`/api/collections/${id}/items`, {
      method: "POST",
      body: JSON.stringify({ doc_ids: refs.docIds ?? [], folder_ids: refs.folderIds ?? [] }),
    }),
  removeItems: (id: string, refs: { docIds?: string[]; folderIds?: string[] }) =>
    api<{ removed: number }>(`/api/collections/${id}/items`, {
      method: "DELETE",
      body: JSON.stringify({ doc_ids: refs.docIds ?? [], folder_ids: refs.folderIds ?? [] }),
    }),
};
