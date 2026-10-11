/** Moving and trashing library items, what a move gives away, and what a batch of them reports. */
import type { ToastOptions } from "@astryxdesign/core/Toast";
import { Docs, Folders, type AclModel } from "../api";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";
import { showUndoToast } from "./undo-toast";

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

/** Someone a move lets in, at the level the destination gives them. */
export interface AccessGain {
  principal: string;
  role: "editor" | "viewer";
}

type AclLevels = Pick<AclModel, "acl_principals" | "acl_writers">;

/**
 * Who an item would gain by inheriting from `dest`: inheritance only adds, so anyone the folder
 * reaches whom the item does not, or whom it lets edit where the item lets them only read. An item
 * that does not inherit gains nobody.
 */
export function accessGains(item: AclLevels & Pick<AclModel, "inherits">, dest: AclLevels): AccessGain[] {
  if (!item.inherits) return [];
  const readers = new Set(item.acl_principals);
  const writers = new Set(item.acl_writers);
  const destWriters = new Set(dest.acl_writers);
  const gains: AccessGain[] = [];
  for (const p of dest.acl_principals) {
    if (destWriters.has(p) && !writers.has(p)) gains.push({ principal: p, role: "editor" });
    else if (!readers.has(p)) gains.push({ principal: p, role: "viewer" });
  }
  return gains;
}

/** Everyone moving `items` into `destId` lets in, at the most each one gains; empty at the top level or when it cannot be told. */
export async function moveAccessGains(items: readonly LibraryItemRef[], destId: string | null): Promise<AccessGain[]> {
  if (destId === null) return [];
  const [dest, ...acls] = await Promise.all([
    Folders.getAcl(destId),
    ...items.map((item) => (item.kind === "folder" ? Folders.getAcl(item.id) : Docs.getAcl(item.id)).catch(() => null)),
  ]);
  const best = new Map<string, AccessGain["role"]>();
  for (const acl of acls) {
    if (!acl) continue;
    for (const gain of accessGains(acl, dest!)) {
      if (best.get(gain.principal) !== "editor") best.set(gain.principal, gain.role);
    }
  }
  return [...best].map(([principal, role]) => ({ principal, role }));
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

/**
 * Moves documents to the Trash and says so, with Undo that restores them; a
 * refusal says why. Resolves to the ids that went. `after` runs once the
 * trashing (and later an undo) has settled, to re-read the list.
 */
export async function trashAndReport(
  docs: ReadonlyArray<{ id: string; title: string }>,
  toast: (options: ToastOptions) => void,
  after: () => void,
): Promise<Set<string>> {
  const results = await Promise.allSettled(docs.map((d) => Docs.trash(d.id, true)));
  const trashed = docs.filter((_, i) => results[i]!.status === "fulfilled");
  after();
  const name = (d: { title: string }) => d.title || t("common.untitled");
  if (trashed.length < docs.length) {
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    toast(
      docs.length === 1
        ? { body: errorMessage(refused.reason, t("library.explorer.trashFailed", { title: name(docs[0]!) })), type: "error" }
        : trashReport(docs.length, docs.length - trashed.length),
    );
    return new Set(trashed.map((d) => d.id));
  }
  const one = trashed.length === 1 ? trashed[0]! : null;
  const body = one ? t("library.options.trashed", { title: name(one) }) : t("library.move.trashed", { count: trashed.length });
  showUndoToast(toast, body, async () => {
    const back = await Promise.allSettled(trashed.map((d) => Docs.trash(d.id, false)));
    after();
    const failed = back.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
    return one ? t("library.trash.restoredNamed", { title: name(one) }) : t("library.trash.restoredCount", { count: trashed.length });
  });
  return new Set(trashed.map((d) => d.id));
}

/** What a move that did not fully land says: how many did, or why none did. */
export function moveFailureReport(total: number, failures: readonly unknown[]): BatchReport {
  const failed = failures.length;
  if (failed === total) {
    const reason = failures[0];
    return { body: errorMessage(reason, t("library.move.failed")), type: "error" };
  }
  return { body: t("library.move.partial", { moved: total - failed, total, failed }), type: "error" };
}

/** Where a move goes: a folder, or the top level, and its name as people read it. */
export interface MoveDestination {
  id: string | null;
  title: string;
}

/**
 * Moves the items and says so: a full move names where they went and offers
 * Undo, which puts each back where it was; a partial one says how many landed.
 * `after` runs once the moves (and later an undo) have settled, to re-read the list.
 */
export async function moveAndReport(
  items: ReadonlyArray<LibraryItemRef & { parentId: string | null }>,
  dest: MoveDestination,
  toast: (options: ToastOptions) => void,
  after: () => void,
): Promise<void> {
  const failures = await moveEach(items, dest.id);
  after();
  if (failures.length > 0) {
    toast(moveFailureReport(items.length, failures));
    return;
  }
  showUndoToast(toast, t("library.move.movedTo", { count: items.length, place: dest.title }), async () => {
    const back = await Promise.all(items.map((item) => moveEach([item], item.parentId)));
    after();
    const failed = back.flat();
    if (failed.length > 0) throw failed[0];
    return t("library.move.movedBack", { count: items.length });
  });
}

function trashReport(total: number, failed: number): BatchReport {
  return { body: t("library.move.trashedPartial", { moved: total - failed, total }), type: "error" };
}
