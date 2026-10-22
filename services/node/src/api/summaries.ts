/** The document and folder fields a browser may see; ACL arrays and grants stay server-side. */
import type { DocRow, FolderRow } from "@stuga/db";
import { docReviewLevel, reviewLevelOf, stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";

const DOC_SUMMARY_KEYS = [
  "doc_id",
  "title",
  // "heading" while the title follows the first line; "user" once someone named it.
  "title_source",
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

/** How AI edits to an item are reviewed, as a summary says it. */
interface ReviewFields {
  /** Its level now: its own, else its folder's, else `review`; a row page's at least its database's. */
  agent_mode: ReviewMode;
  /**
   * The level it cannot be set below by its owner: its folder's (`review` unless one sets another),
   * which only the folder's owner or an admin sets it below, and a row page's database's, which
   * nobody does; null at the top level.
   */
  agent_mode_floor: ReviewMode | null;
}

/** The level a folder gives what is in it, null at the top level. */
function floorOf(parentId: string | null, inherited: ReviewMode | null): ReviewMode | null {
  return parentId === null ? null : reviewLevelOf(null, inherited);
}

export function docSummary(row: DocRow): Omit<Pick<DocRow, (typeof DOC_SUMMARY_KEYS)[number]>, "agent_mode"> & ReviewFields {
  const floor = floorOf(row.parent_id, row.folder_agent_mode);
  const database = row.database_agent_mode;
  return {
    ...pickKeys(row, DOC_SUMMARY_KEYS),
    agent_mode: docReviewLevel(row),
    agent_mode_floor: database ? (floor ? stricterReviewMode(floor, database) : database) : floor,
  };
}

export function folderSummary(
  row: FolderRow,
): Pick<FolderRow, (typeof FOLDER_SUMMARY_KEYS)[number]> & ReviewFields & { approver_group: string | null } {
  return {
    ...pickKeys(row, FOLDER_SUMMARY_KEYS),
    agent_mode: reviewLevelOf(row.agent_mode, row.parent_agent_mode),
    agent_mode_floor: floorOf(row.parent_id, row.parent_agent_mode),
    // At `colleague`, only its members approve beneath it; null for anyone else who can edit.
    approver_group: row.approver_group,
  };
}
