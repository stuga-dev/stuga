/**
 * A change: the runs one agent makes across several pages for one piece of work (an ingest of a
 * meeting, a Save to Stuga of several points), reviewed as one. Its runs stay runs, each decided at
 * its own page's level; the change groups them on one card, one Slack post and one notice per
 * person, and opens with the agent's `change_title`.
 */

/** "chg_" + 12 hex chars. */
export function newChangeId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `chg_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether `raw` has the shape of a change id; a refusal says "unknown" either way. */
export function isChangeId(raw: unknown): raw is string {
  return typeof raw === "string" && /^chg_[0-9a-f]{12}$/.test(raw);
}

/** A change's title: a few words naming the work, such as "Customer sync, 2026-10-21". */
export const CHANGE_TITLE_MAX = 200;
/** What the change does, in a few sentences, for whoever approves it. */
export const CHANGE_SUMMARY_MAX = 2_000;
/** Runs one change may hold: a save or an ingest touches a few pages, never a whole wiki. */
export const CHANGE_RUNS_MAX = 100;

/** A title or summary as stored: one line for a title, whitespace runs collapsed, cut to its limit. */
export function cleanChangeText(raw: unknown, max: number, oneLine: boolean): string {
  if (typeof raw !== "string") return "";
  const text = (oneLine ? raw.replace(/\s+/g, " ") : raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? c : "")).trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** The web app's card for a whole change. `workspace` lets it open in that workspace when another is active. */
export function changeCardPath(changeId: string, workspace?: string | null): string {
  const path = `/review/change/${encodeURIComponent(changeId)}`;
  return workspace ? `${path}?workspace=${encodeURIComponent(workspace)}` : path;
}

/**
 * Where a new page an agent made in a change stands: `held` (only whoever asked and those who may
 * approve it can open it), `released` (approved: it takes its folder's access) or `removed` (its
 * changes were declined or withdrawn: in the trash).
 */
export type NewPageState = "held" | "released" | "removed";
