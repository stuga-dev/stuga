/**
 * What a rejection's note does, and so what its button says. The button that opens the note and the
 * one that sends it carry the same words, so the reviewer confirms the action they chose.
 */
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { t } from "../i18n/i18n";

/**
 * - `revise`: the co-author's own run, with AI chat on: it rewrites the rejected text at once.
 * - `next_turn`: the co-author's run with AI chat off: the note waits for its next turn.
 * - `agent`: an agent outside the app: the note waits for its next read or proposal here.
 */
export type NoteMode = "revise" | "next_turn" | "agent";

export function noteModeOf(source: AgentRunSummary["source"], coauthorAvailable: boolean): NoteMode {
  if (source !== "panel") return "agent";
  return coauthorAvailable ? "revise" : "next_turn";
}

export interface NoteLabels {
  /** The button that opens the note, with an ellipsis for the step still to come. */
  trigger: string;
  /** The button that sends it. */
  submit: string;
  /** One line under the note saying when it is acted on; null when the submit label says it. */
  hint: string | null;
}

/** Labels for one change, or for every change of a run (`all`). */
export function noteLabels(mode: NoteMode, all = false): NoteLabels {
  if (mode === "revise") {
    return all
      ? { trigger: t("review.note.reviseAllEllipsis"), submit: t("review.note.reviseAll"), hint: null }
      : { trigger: t("review.note.reviseEllipsis"), submit: t("review.note.revise"), hint: null };
  }
  const hint = mode === "next_turn" ? t("review.note.nextTurnHint") : t("review.note.agentHint");
  return all
    ? { trigger: t("review.note.rejectAllEllipsis"), submit: t("review.note.rejectAll"), hint }
    : { trigger: t("review.note.rejectEllipsis"), submit: t("review.note.reject"), hint };
}
