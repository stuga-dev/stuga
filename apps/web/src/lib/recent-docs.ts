/**
 * The documents opened lately in this browser, per workspace, newest first: the
 * palette's empty state. Ids only; the palette asks the server for each one when
 * it shows them, so a title is current and a document no longer readable drops
 * out. Session state, cleared at sign-out with the workspace pointer.
 */
import { readStored, removeStored, writeStored } from "./storage";

const KEY = "stuga_recent_docs";
const PER_WORKSPACE = 8;
const WORKSPACES = 20;

type Recents = Record<string, string[]>;

function read(): Recents {
  try {
    const parsed: unknown = JSON.parse(readStored("local", KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Recents = {};
    for (const [ws, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) out[ws] = ids.filter((id): id is string => typeof id === "string").slice(0, PER_WORKSPACE);
    }
    return out;
  } catch {
    return {};
  }
}

/** The workspace last written moves to the end, so the oldest is the one dropped. */
function write(workspace: string, ids: string[]): void {
  const all = read();
  delete all[workspace];
  if (ids.length) all[workspace] = ids;
  const kept = Object.entries(all).slice(-WORKSPACES);
  writeStored("local", KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** `workspace` is the active workspace pointer; null keys the node's default. */
export function noteRecentDoc(workspace: string | null, docId: string): void {
  const ws = workspace ?? "";
  write(ws, [docId, ...(read()[ws] ?? []).filter((id) => id !== docId)].slice(0, PER_WORKSPACE));
}

export function recentDocIds(workspace: string | null): string[] {
  return read()[workspace ?? ""] ?? [];
}

export function forgetRecentDoc(workspace: string | null, docId: string): void {
  const ws = workspace ?? "";
  write(ws, (read()[ws] ?? []).filter((id) => id !== docId));
}

export function clearRecentDocs(): void {
  removeStored("local", KEY);
}
