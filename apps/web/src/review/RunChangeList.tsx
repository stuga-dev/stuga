/**
 * The "Review each" drawer of one open run: every pending hunk, painted ones
 * first in document order, then the ones with no ghost, which can only be
 * decided here. Summaries are agent text and render as text nodes only.
 */
import { useEffect, type KeyboardEvent } from "react";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { useAgentRuns, pendingHunks } from "./agent-runs-context";
import { orderRowsForReview, summarizeHunk, unshownReason } from "./hunk-review";
import { itemKey } from "./run-ledger";
import { Button } from "@astryxdesign/core/Button";
import { anchorOf, keepFocus, type NoteAnchor } from "./RejectNoteDialog";
import { t } from "../i18n/i18n";
import { runAgentLabel } from "../state/identity";

export function RunChangeList({
  run,
  noteAction,
}: {
  run: AgentRunSummary;
  /** Rejecting one change with a note: the button's words, the action they name, and what opens the composer. */
  noteAction?: { label: string; name: string; onOpen: (hunkId: string, anchor: NoteAnchor) => void };
}) {
  const { preview, inFlight, loadingHunks, decide, loadFullHunks } = useAgentRuns();

  // A truncated run arrives without hunks; they are fetched when the list opens.
  useEffect(() => {
    if (run.hunks_truncated) void loadFullHunks(run.id);
  }, [run.id, run.hunks_truncated, loadFullHunks]);

  const rows = orderRowsForReview(pendingHunks(run), (h) => itemKey(run.id, h.id), preview.anchored);
  const loading = loadingHunks.has(run.id);

  if (rows.length === 0) {
    return (
      <p className="agent-run-changes__empty">
        {loading
          ? t("review.changeList.loading")
          : t("review.changeList.unlisted")}
      </p>
    );
  }

  /** Arrow keys move between rows instead of tabbing through every row's buttons. */
  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const bodies = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".agent-run-change__body")];
    const i = bodies.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    bodies[(i + (e.key === "ArrowDown" ? 1 : -1) + bodies.length) % bodies.length]!.focus();
  }

  return (
    <ul className="agent-run-changes" aria-label={t("review.changeList.label", { agent: runAgentLabel(run) })} onKeyDown={onKeyDown}>
      {rows.map((row, i) => {
        const summary = summarizeHunk(row.hunk);
        const posted = inFlight.has(row.key);
        const position = { index: i + 1, total: rows.length };
        const reason = preview.why[row.key];
        const unshown = reason
          ? t("review.changeList.unshown", { reason: unshownReason(reason) })
          : t("review.changeList.unshownDecideHere");
        return (
          <li
            key={row.key}
            className={`agent-run-change${posted ? " agent-run-change--busy" : ""}`}
            aria-busy={posted || undefined}
          >
            <button
              type="button"
              className="agent-run-change__body"
              title={summary.detail}
              // Unanchored rows stay focusable so arrow-key navigation reaches them.
              aria-label={row.isAnchored ? t("review.changeList.show", position) : t("review.changeList.unshownRow", { ...position, unshown })}
              disabled={posted}
              onClick={() => preview.scrollToHunk(row.key)}
            >
              <span className={`agent-run-change__marker agent-run-change__marker--${summary.kind}`} aria-hidden="true">
                {summary.marker}
              </span>
              <span className="agent-run-change__lines">
                <span className="agent-run-change__text">{summary.text}</span>
                {summary.context && <span className="agent-run-change__context">{summary.context}</span>}
              </span>
              {!row.isAnchored && (
                <span className="agent-run-change__note">{unshown}</span>
              )}
            </button>
            <span className="agent-run-change__actions">
              <Button
                label={t("review.changeList.accept", position)}
                variant="secondary"
                size="sm"
                isDisabled={posted}
                onClick={() => void decide(run.id, "accept", [row.hunk.id])}
              >
                {t("common.accept")}
              </Button>
              <Button
                label={t("review.changeList.reject", position)}
                variant="ghost"
                size="sm"
                isDisabled={posted}
                onClick={() => void decide(run.id, "reject", [row.hunk.id])}
              >
                {t("common.reject")}
              </Button>
              {noteAction && (
                <Button
                  label={t("review.changeList.note", { action: noteAction.name, ...position })}
                  variant="ghost"
                  size="sm"
                  isDisabled={posted}
                  onMouseDown={keepFocus}
                  onClick={(e) => noteAction.onOpen(row.hunk.id, anchorOf(e))}
                >
                  {noteAction.label}
                </Button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
