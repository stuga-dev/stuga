/**
 * The document's open agent runs, one banner each (with two agents working,
 * Accept all must mean one of them). The banner walks the run's hunks in
 * document order and opens the per-hunk list, the only way to decide a hunk
 * with no ghost.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { Button } from "@astryxdesign/core/Button";
import { useOptionalAiCoauthor } from "../ai/ai-coauthor-context";
import { useAgentRuns, pendingHunks } from "./agent-runs-context";
import { useRejectNote, type NoteAnchor } from "./RejectNoteDialog";
import { UNSHOWN_REASON, summarizeHunk } from "./hunk-review";
import { RunChangeList } from "./RunChangeList";
import { RunBanner, RunNotices } from "./RunBanner";
import { itemKey } from "./run-ledger";
import { noteLabels, noteModeOf } from "./note-mode";
import { RUN_HUNK_EVENT, type HunkKey, type RunHunkDecisionDetail } from "../editor/run-preview/plan";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** What a note turns down, as its composer quotes it: one change's summary, or how many. */
function quoteOf(run: AgentRunSummary, hunkIds: string[] | undefined): string {
  const pending = pendingHunks(run);
  if (hunkIds?.length === 1) {
    const hunk = pending.find((h) => h.id === hunkIds[0]);
    if (hunk) return summarizeHunk(hunk).detail;
  }
  const n = hunkIds?.length ?? pending.length;
  return `All ${n} edit${n === 1 ? "" : "s"} by ${run.agent}`;
}

/** The feedback the newest rejection of `hunkIds` (every hunk when undefined) minted, or null when nothing was rejected. */
function rejectedFeedbackId(run: AgentRunSummary, hunkIds?: string[]): string | null {
  const wanted = hunkIds ? new Set(hunkIds) : null;
  const newest = run.hunks
    .filter((h) => h.status === "rejected" && h.feedback && (!wanted || wanted.has(h.id)))
    .map((h) => h.feedback!)
    .sort((a, b) => b.decided_at - a.decided_at)[0];
  return newest?.id ?? null;
}

export function AgentRunBar() {
  const { openRuns, notices, dismissNotice, undo } = useAgentRuns();
  return (
    <>
      <RunNotices notices={notices} dismissNotice={dismissNotice} onUndoDecision={undo} />
      {openRuns.map((run) => (
        <AgentRunBanner key={run.id} run={run} />
      ))}
    </>
  );
}

function AgentRunBanner({ run }: { run: AgentRunSummary }) {
  const { busy, decide, preview } = useAgentRuns();
  const coauthor = useOptionalAiCoauthor();
  // Read again when the decision lands: the co-author may have started a turn while the dialog was open.
  const coauthorRef = useRef(coauthor);
  coauthorRef.current = coauthor;
  const { ask, dialog } = useRejectNote();
  // Whoever proposed revises: an agent's note waits for that agent, and the co-author's own run
  // becomes a turn scoped to what this decision rejected, at once or when the turn in flight ends.
  // With AI chat off the co-author can't take one, so its note waits for its next turn instead.
  const mode = noteModeOf(run.source, coauthor?.available === true);
  const sendNote = (hunkIds: string[] | undefined, note: string) =>
    void decide(run.id, "reject", hunkIds, note).then((decided) => {
      const live = coauthorRef.current;
      const feedbackId = decided && run.source === "panel" ? rejectedFeedbackId(decided, hunkIds) : null;
      if (feedbackId && live?.available) live.revise(note, { runId: run.id, feedbackId });
    });
  const requestChanges = (hunkIds: string[] | undefined, anchor: NoteAnchor, returnFocus?: HTMLElement | null) => {
    const labels = noteLabels(mode, hunkIds === undefined);
    ask({
      title: labels.submit,
      submitLabel: labels.submit,
      hint: mode === "revise" && coauthor?.streaming ? "Revises when the current turn ends." : labels.hint,
      anchor,
      returnFocus,
      quote: quoteOf(run, hunkIds),
      onSubmit: (note) => sendNote(hunkIds, note),
    });
  };
  // A ghost's note arrives as the same document event as its Accept/Reject, for this run.
  const sendRef = useRef(sendNote);
  sendRef.current = sendNote;
  useEffect(() => {
    const onHunk = (e: Event) => {
      const detail = (e as CustomEvent<RunHunkDecisionDetail>).detail;
      if (detail?.decision === "request_changes" && detail.runId === run.id && detail.hunkId && detail.note) {
        sendRef.current([detail.hunkId], detail.note);
      }
    };
    document.addEventListener(RUN_HUNK_EVENT, onHunk);
    return () => document.removeEventListener(RUN_HUNK_EVENT, onHunk);
  }, [run.id]);
  /**
   * The navigator's position, held as the hunk's key because a decision drops
   * that hunk from the list under the cursor. `at` is the index it held, so a
   * vanished key hands the cursor to the change that took its place.
   */
  const [cursor, setCursor] = useState<{ key: HunkKey; at: number } | null>(null);

  const pending = pendingHunks(run);
  const n = run.hunks_truncated ? 0 : pending.length;

  // The overlay reports every open run's hunks; keep this run's, in document order.
  const mine = new Set(pending.map((h) => itemKey(run.id, h.id)));
  const anchored = preview.anchored.filter((k) => mine.has(k));
  const unanchored = preview.unanchored.filter((k) => mine.has(k));
  const unanchoredCount = unanchored.length;
  // One shared reason fits in the banner; several are told row by row in "Review each".
  const reasons = new Set(unanchored.map((k) => preview.why[k]));
  const sharedReason = reasons.size === 1 ? [...reasons][0] : undefined;

  const parked = cursor === null ? -1 : anchored.indexOf(cursor.key);
  // A vanished key's slot now holds a change never shown, so the next ▸ lands on it.
  const at =
    cursor === null || anchored.length === 0 ? null : parked >= 0 ? parked : Math.min(cursor.at, anchored.length - 1);
  const visited = parked >= 0;

  function go(delta: number) {
    if (anchored.length === 0) return;
    const next =
      at === null
        ? delta > 0
          ? 0
          : anchored.length - 1
        : !visited && delta > 0
          ? at
          : (at + delta + anchored.length) % anchored.length;
    setCursor({ key: anchored[next]!, at: next });
    preview.scrollToHunk(anchored[next]!);
  }

  // The list is offered when it says something the ghosts can't.
  const hasList = n > 1 || run.hunks_truncated === true || unanchoredCount > 0;

  return (
    <>
      <RunBanner
        updatedAt={run.updated_at}
        title={n > 0 ? `${run.agent} proposes ${n} edit${n === 1 ? "" : "s"}` : `${run.agent} proposes edits`}
        hint={
          unanchoredCount > 0
            ? `${unanchoredCount} can’t be shown in the document${sharedReason ? ` (${UNSHOWN_REASON[sharedReason]})` : ""} — see “Review each”`
            : "nothing changes until you accept"
        }
        busy={busy}
        onDecide={(decision) => void decide(run.id, decision)}
        noteAction={{
          label: noteLabels(mode, true).trigger,
          onOpen: (anchor, returnFocus) => requestChanges(undefined, anchor, returnFocus),
        }}
        list={
          hasList ? (
            <RunChangeList
              run={run}
              noteAction={{ label: noteLabels(mode).trigger, onOpen: (hunkId, anchor) => requestChanges([hunkId], anchor) }}
            />
          ) : undefined
        }
        controls={
          anchored.length > 0 && (
            <div className="agent-run-nav" role="group" aria-label="Move between this run's changes">
              <Button label="Previous change" variant="ghost" size="sm" isIconOnly icon={<ChevronLeft size={15} />} onClick={() => go(-1)} />
              <span className="agent-run-nav__count" aria-live="polite">
                {(at ?? 0) + 1} of {anchored.length}
              </span>
              <Button label="Next change" variant="ghost" size="sm" isIconOnly icon={<ChevronRight size={15} />} onClick={() => go(1)} />
            </div>
          )
        }
      />
      {dialog}
    </>
  );
}
