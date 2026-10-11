/**
 * A restored version reloads every open page. What the reload should say, who
 * restored which version, is handed across it in session storage; the Versions
 * list is told for a while afterwards that its newest row is still on its way.
 */
import type { DocResetPayload } from "@stuga/protocol/wire/opcodes";
import { readStored, removeStored, takeStored, writeStored } from "../lib/storage";

type Restored = DocResetPayload["restored"];

/** What the reloaded page says: who restored it, unless it was this tab. */
export interface RestoreNotice extends Restored {
  mine: boolean;
}

/** How long after a restore the Versions list waits for the restore's own row. */
const SETTLE_MS = 60_000;

const noticeKey = (docId: string) => `stuga_restored:${docId}`;
const mineKey = (docId: string) => `stuga_restoring:${docId}`;
/** Apart from the notice, which the page takes once: the Versions panel may mount before or after it. */
const settlingKey = (docId: string) => `stuga_restore_settling:${docId}`;

/** This tab asked to restore `seq`, so the reload says it did rather than naming the person. */
export function noteOwnRestore(docId: string, seq: number): void {
  writeStored("session", mineKey(docId), String(seq));
}

/** The reset frame named who restored what: kept for the page the reload brings. */
export function rememberRestore(docId: string, restored: Restored): void {
  writeStored("session", noticeKey(docId), JSON.stringify(restored));
  writeStored("session", settlingKey(docId), JSON.stringify({ seq: restored.seq, until: Date.now() + SETTLE_MS }));
}

/** Once, on the page after the reload: what to say, or null when no restore brought it. */
export function takeRestore(docId: string): RestoreNotice | null {
  const raw = takeStored("session", noticeKey(docId));
  const own = readStored("session", mineKey(docId));
  removeStored("session", mineKey(docId));
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<Restored>;
    if (typeof r.by !== "string" || typeof r.at !== "string" || typeof r.seq !== "number") return null;
    return { by: r.by, at: r.at, seq: r.seq, mine: own === String(r.seq) };
  } catch {
    return null;
  }
}

/**
 * The version a restore just brought back, while its own row may not be listed
 * yet (the server records it a little after the reload), else null.
 */
export function restoreSettling(docId: string): number | null {
  const raw = readStored("session", settlingKey(docId));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as { seq?: unknown; until?: unknown };
    if (typeof s.seq === "number" && typeof s.until === "number" && Date.now() <= s.until) return s.seq;
  } catch {
    /* unreadable: treated as over */
  }
  restoreSettled(docId);
  return null;
}

/** The restore's own row arrived: the list is current again. */
export function restoreSettled(docId: string): void {
  removeStored("session", settlingKey(docId));
}
