/**
 * The agent-run ledger rules the document and database actors share: run ids,
 * list limits, idle rollover, terminal status and the park-or-commit decision.
 */
import type { ReviewMode } from "./events.js";
import { RUN_FEEDBACK_EXCERPT_CHARS, RUN_FEEDBACK_NOTE_MAX_CHARS, RUN_IDLE_MS } from "./limits.js";

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
 * Only `auto` commits, whoever the agent is: the in-app co-author follows the
 * setting like any other. A run still holding undecided items parks: the new
 * proposal was validated against a working copy that includes them, so it
 * cannot land ahead of them.
 */
export function shouldCommit(review: ReviewMode, parkedBehindPending: boolean): boolean {
  return review === "auto" && !parkedBehindPending;
}

/**
 * A reviewer's rejection, or a revert with a note, kept on every item one decision covered. The note
 * is advice to the agent that proposed them, never a rule: it decides nothing about what a later
 * write may do.
 */
export interface RunFeedback {
  /** "fb_" + 12 hex chars, shared by the items one decision covered. */
  id: string;
  /** The items had landed and were taken back, rather than refused. */
  reverted?: true;
  /** What the reviewer wrote, when they wrote anything. */
  note?: string;
  decided_by: string;
  /** epoch ms */
  decided_at: number;
  /**
   * When the agent was handed it with a later proposal (or the co-author with its next turn). Until
   * then reads repeat it; afterwards only `status` shows it.
   */
  addressed_at?: number;
  /**
   * A database op only: what it would have written, column ids named, cut to RUN_FEEDBACK_EXCERPT_CHARS,
   * so the agent sees which rows and values were turned down and not just the op's one-line summary.
   */
  detail?: string;
}

/** A rejection as the agent that proposed it is told: what was turned down, and the reviewer's note. */
export interface AgentFeedback {
  /** The RunFeedback id. */
  id: string;
  run_id: string;
  /** The changes had landed and were taken back, rather than refused. */
  reverted?: true;
  note?: string;
  decided_at: number;
  /** The rejected changes, at most RUN_FEEDBACK_MAX_CHANGES, each side cut to RUN_FEEDBACK_EXCERPT_CHARS. */
  changes: Array<{ old_string: string; new_string: string } | { summary: string; detail?: string }>;
  /** How many more changes the same decision rejected. */
  more?: number;
}

/** "fb_" + 12 hex chars. */
export function newFeedbackId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `fb_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A decision's `note`: trimmed, empty means none. A rejection or a revert carries one, since it is
 * what the agent revises from; an accept does not. A note that is not text, or one past
 * RUN_FEEDBACK_NOTE_MAX_CHARS, is refused rather than cut, so a reviewer never sends half a sentence.
 */
export function parseDecisionNote(decision: unknown, raw: unknown): { ok: true; note?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, message: "note must be text" };
  const note = raw.trim();
  if (!note) return { ok: true };
  if (decision !== "reject" && decision !== "revert") return { ok: false, message: "only a rejection or a revert carries a note" };
  if (note.length > RUN_FEEDBACK_NOTE_MAX_CHARS) {
    return { ok: false, message: `note is longer than ${RUN_FEEDBACK_NOTE_MAX_CHARS} characters` };
  }
  return { ok: true, note };
}

/** One side of a rejected change as an agent is shown it. */
export function feedbackExcerpt(text: string): string {
  return text.length > RUN_FEEDBACK_EXCERPT_CHARS ? `${text.slice(0, RUN_FEEDBACK_EXCERPT_CHARS)}…` : text;
}
