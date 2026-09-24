/**
 * The agent-run ledger rules the document and database actors share: run ids,
 * list limits, idle rollover, terminal status and the park-or-commit decision.
 */
import type { ReviewMode } from "./events.js";
import { RUN_IDLE_MS } from "./limits.js";

/** "run_" + 12 hex chars. */
export function newRunId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `run_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The principal an agent alias acts as in the event feed. API-key agents are
 * `agent-…` ids; the in-app co-author's `panel:<human>` alias is already namespaced.
 */
export function agentActorOf(agentAlias: string): string {
  return agentAlias.startsWith("agent-") ? `agent:${agentAlias}` : agentAlias;
}

/** A `?limit=` value clamped to 1..max; absent or non-numeric means `fallback` (a listing never errors on it). */
export function clampRunLimit(raw: string | null | undefined, max: number, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** Whether an open run last touched at `updatedAt` has gone quiet long enough for the next propose to start a new one. */
export function runIsIdle(updatedAt: number, now: number): boolean {
  return now - updatedAt > RUN_IDLE_MS;
}

/** Terminal status of a run whose items are all decided: "applied" if any landed. */
export function closedStatus(items: Iterable<{ status: string }>): "applied" | "rejected" {
  for (const item of items) {
    if (item.status === "accepted" || item.status === "auto_applied") return "applied";
  }
  return "rejected";
}

/** The node's resolved policy word. Anything but "auto" is `review`, never a silent commit. */
export function parseReviewMode(raw: unknown): ReviewMode {
  return raw === "auto" ? "auto" : "review";
}

/**
 * Whether a proposal commits at once instead of parking for a person.
 *
 * Only `auto` commits. The in-app co-author (`panel`) always parks, because its
 * turn is staged in front of the person who asked for it. A run still holding
 * undecided items parks too: the new proposal was validated against a working
 * copy that includes them, so it cannot land ahead of them.
 */
export function shouldCommit(review: ReviewMode, source: string, parkedBehindPending: boolean): boolean {
  return review === "auto" && source !== "panel" && !parkedBehindPending;
}
