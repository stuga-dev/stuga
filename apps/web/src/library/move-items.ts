/** Moving and trashing library items, and what a batch of them reports. */
import { Docs, Folders } from "../api";
import { errorMessage } from "../lib/http/client";

export interface LibraryItemRef {
  kind: "folder" | "doc";
  id: string;
}

export interface LibraryDragItem extends LibraryItemRef {
  title: string;
  /** The folder the item sits in now; null is the top level. */
  parentId: string | null;
}

/**
 * The items a drop on `destId` would move: never a folder onto itself or into
 * its own subtree, and nothing already there. `ancestors` are the folders
 * enclosing the destination.
 */
export function movableTo(items: readonly LibraryDragItem[], destId: string | null, ancestors: readonly string[]): LibraryDragItem[] {
  return items.filter((item) => {
    if (item.kind === "folder" && (item.id === destId || ancestors.includes(item.id))) return false;
    return item.parentId !== destId;
  });
}

interface BatchReport {
  body: string;
  type: "info" | "error";
}

/** One request per item, since there is no bulk endpoint. Resolves to the failures' reasons. */
export async function moveEach(items: readonly LibraryItemRef[], destId: string | null): Promise<unknown[]> {
  const results = await Promise.allSettled(
    items.map((item) => (item.kind === "folder" ? Folders.move(item.id, destId) : Docs.move(item.id, destId))),
  );
  return results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}

/** Resolves to how many of the documents could not be trashed. */
export async function trashEach(docIds: readonly string[]): Promise<number> {
  const results = await Promise.allSettled(docIds.map((id) => Docs.trash(id, true)));
  return results.filter((r) => r.status === "rejected").length;
}

/** Silent for a single item that moved; a partial failure says how many landed. */
export function moveReport(total: number, failures: readonly unknown[]): BatchReport | null {
  const failed = failures.length;
  if (failed === 0) return total > 1 ? { body: `Moved ${total} items.`, type: "info" } : null;
  if (failed === total) {
    const reason = failures[0];
    return { body: errorMessage(reason, "Couldn’t move those items."), type: "error" };
  }
  return { body: `Moved ${total - failed} of ${total}; ${failed} couldn’t be moved.`, type: "error" };
}

export function trashReport(total: number, failed: number): BatchReport {
  return failed === 0
    ? { body: `Moved ${total} to Trash.`, type: "info" }
    : { body: `${total - failed} of ${total} moved to Trash.`, type: "error" };
}
