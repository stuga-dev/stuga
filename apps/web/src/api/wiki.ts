import type { DocWikiLinks, WikiIndex, WikiLint, WikiLog } from "@stuga/protocol/domain/wiki";
import { api } from "../lib/http/client";

export type { AuthorRef, DocWikiLinks, IndexEntry, IndexSection, LogOutcome, LogTable, WikiIndex, WikiLint, WikiLog, WikiLogEntry } from "@stuga/protocol/domain/wiki";

/** The wiki as the signed-in person reads it: nothing in it names a page, folder or change they cannot open. */
export const Wiki = {
  index: (folderId?: string) => api<WikiIndex>(`/api/wiki/index${folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ""}`),
  log: (before?: string | null) => api<WikiLog>(`/api/wiki/log${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  lint: (folderId?: string) => api<WikiLint>(`/api/wiki/lint${folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ""}`),
  links: (docId: string) => api<DocWikiLinks>(`/api/docs/${encodeURIComponent(docId)}/links`),
  /** What the page cites that changed counts as checked now; answers with the page's links as they then stand. */
  markChecked: (docId: string) => api<DocWikiLinks & { marked: number }>(`/api/docs/${encodeURIComponent(docId)}/links/checked`, { method: "POST" }),
};
