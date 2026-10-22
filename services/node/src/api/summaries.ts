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

/**
 * What an item is never reviewed more loosely than, each from where it comes: the level its folder
 * gives it (`review` unless one sets another; null at the top level), which only the folder's owner
 * or an admin sets it below; a row page's database's; and `review` for an item in someone's My notes
 * that others can read. Nobody sets it below the last two.
 */
interface ReviewFloors {
  folder: ReviewMode | null;
  database: ReviewMode | null;
  notes: ReviewMode | null;
}

/** How AI edits to an item are reviewed, as a summary says it: what the node enforces for every agent. */
interface ReviewFields {
  /**
   * Its level now: its own, else its folder's, else `review`; a row page's at least its database's,
   * and an item shared out of My notes at least `review` (effectiveReviewLevel).
   */
  agent_mode: ReviewMode;
  /** The strictest of its floors, null when none applies. */
  agent_mode_floor: ReviewMode | null;
  agent_mode_floors: ReviewFloors;
}

/** The level a folder gives what is in it, null at the top level. */
function floorOf(parentId: string | null, inherited: ReviewMode | null): ReviewMode | null {
  return parentId === null ? null : reviewLevelOf(null, inherited);
}

/** The fields for an item set at `level` (its own or its folders'), with these floors. */
function reviewFields(level: ReviewMode, floors: ReviewFloors): ReviewFields {
  const set = [floors.folder, floors.database, floors.notes].filter((f): f is ReviewMode => f !== null);
  const floor = set.length > 0 ? set.reduce(stricterReviewMode) : null;
  const hard = [floors.database, floors.notes].filter((f): f is ReviewMode => f !== null);
  return {
    agent_mode: hard.reduce(stricterReviewMode, level),
    agent_mode_floor: floor,
    agent_mode_floors: floors,
  };
}

export function docSummary(row: DocRow): Omit<Pick<DocRow, (typeof DOC_SUMMARY_KEYS)[number]>, "agent_mode"> & ReviewFields {
  return {
    ...pickKeys(row, DOC_SUMMARY_KEYS),
    ...reviewFields(docReviewLevel(row), {
      folder: floorOf(row.parent_id, row.folder_agent_mode),
      database: row.database_agent_mode ?? null,
      notes: row.notes_shared ? "review" : null,
    }),
  };
}

export function folderSummary(
  row: FolderRow,
): Pick<FolderRow, (typeof FOLDER_SUMMARY_KEYS)[number]> & ReviewFields & { approver_group: string | null } {
  return {
    ...pickKeys(row, FOLDER_SUMMARY_KEYS),
    // A folder gives its own level; what in it others can read is held to the My notes floor item by item.
    ...reviewFields(reviewLevelOf(row.agent_mode, row.parent_agent_mode), {
      folder: floorOf(row.parent_id, row.parent_agent_mode),
      database: null,
      notes: null,
    }),
    // At `colleague`, only its members approve beneath it; null for anyone else who can edit.
    approver_group: row.approver_group,
  };
}
