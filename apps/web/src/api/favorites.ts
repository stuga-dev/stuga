import { api } from "../lib/http/client";
import type { DocSummary } from "./docs";

export const Favorites = {
  /** `docs` is the starred rows the caller can still open; `favorites` keeps every starred id so any can be cleared. */
  list: () => api<{ favorites: string[]; docs: DocSummary[] }>("/api/favorites"),
  add: (docId: string) => api<{ ok: boolean }>("/api/favorites", { method: "PUT", body: JSON.stringify({ doc_id: docId }) }),
  remove: (docId: string) => api<{ ok: boolean }>(`/api/favorites/${docId}`, { method: "DELETE" }),
};
