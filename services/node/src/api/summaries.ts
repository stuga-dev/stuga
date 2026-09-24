/** The document and folder fields a browser may see; ACL arrays and grants stay server-side. */
import type { DocRow, FolderRow } from "@stuga/db";

const DOC_SUMMARY_KEYS = [
  "doc_id",
  "title",
  "owner",
  "doc_type",
  "parent_id",
  "created_at",
  "updated_at",
  "trashed",
  "trashed_at",
  "locked",
  "search_hidden",
  "agent_mode",
  "page_of",
  "page_row",
] as const satisfies readonly (keyof DocRow)[];

const FOLDER_SUMMARY_KEYS = [
  "folder_id",
  "parent_id",
  "title",
  "owner",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof FolderRow)[];

function pickKeys<T extends object, K extends readonly (keyof T)[]>(row: T, keys: K): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const k of keys) out[k] = row[k];
  return out;
}

export function docSummary(row: DocRow): Pick<DocRow, (typeof DOC_SUMMARY_KEYS)[number]> {
  return pickKeys(row, DOC_SUMMARY_KEYS);
}

export function folderSummary(row: FolderRow): Pick<FolderRow, (typeof FOLDER_SUMMARY_KEYS)[number]> {
  return pickKeys(row, FOLDER_SUMMARY_KEYS);
}
