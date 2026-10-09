/** The pieces the document and database review banners share. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { useToast } from "@astryxdesign/core/Toast";
import { ChevronDown, ChevronUp, Sparkles, Zap } from "lucide-react";
import type { RunNotice } from "./use-run-ledger";
import { anchorRect, keepFocus, type NoteAnchor } from "./RejectNoteDialog";

/** How long after its last update a run still reads as streaming in. */
const LIVE_WINDOW_MS = 5_000;

/** Whether a run changed within the live window; re-renders itself when the window closes. */
function useLiveWindow(updatedAt: number): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    const remaining = updatedAt + LIVE_WINDOW_MS - Date.now();
    if (remaining <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), remaining);
    return () => clearTimeout(t);
  }, [updatedAt]);
  return Date.now() - updatedAt < LIVE_WINDOW_MS;
}

/**
 * Drains a ledger's notices into toasts. Stays mounted with no open run, since a
 * decision can settle as its run leaves the bar. `onUndo` adds Undo to an
 * `accepted` notice, and `onUndoDecision` to a `decided` one.
 */
export function RunNotices({
  notices,
  dismissNotice,
  onUndo,
  onUndoDecision,
}: {
  notices: RunNotice[];
  dismissNotice: (id: number) => void;
  onUndo?: (runId: string) => Promise<void>;
  onUndoDecision?: (runId: string, itemIds: string[]) => Promise<void>;
}) {
  const toast = useToast();
  useEffect(() => {
    for (const n of notices) {
      if (n.kind === "decided" && n.runId && n.itemIds && onUndoDecision) {
        const { runId, itemIds } = n;
        // One per run: a newer decision's toast replaces the last, and its Undo is the one that applies.
        toast({
          body: n.message,
          type: "info",
          uniqueID: `run-decision:${runId}`,
          autoHideDuration: 8000,
          endContent: (
            <UndoButton
              onUndo={() =>
                onUndoDecision(runId, itemIds).catch((e: unknown) => {
                  toast({ body: e instanceof Error && e.message ? e.message : "Couldn’t undo that.", type: "error" });
                })
              }
            />
          ),
        });
      } else if (n.kind === "undone" && n.runId) {
        // Replaces the decision's own toast, whose Undo no longer applies.
        toast({ body: n.message, type: "info", uniqueID: `run-decision:${n.runId}` });
      } else if (n.kind === "accepted" && n.runId && onUndo) {
        const runId = n.runId;
        toast({
          body: n.message,
          type: "info",
          uniqueID: `run-accept:${runId}`,
          autoHideDuration: 8000,
          endContent: (
            <UndoButton
              onUndo={() =>
                onUndo(runId).catch((e: unknown) => {
                  toast({ body: e instanceof Error && e.message ? e.message : "Couldn’t undo these changes.", type: "error" });
                })
              }
            />
          ),
        });
      } else {
        // A blocked change lost nothing, so it reads as guidance.
        toast({ body: n.message, type: n.kind === "conflict" || n.kind === "error" ? "error" : "info" });
      }
      dismissNotice(n.id);
    }
  }, [notices, toast, dismissNotice, onUndo, onUndoDecision]);
  return null;
}

/**
 * Takes its action as a prop and must keep doing so: toasts render in a
 * separate React root, where a context hook would find no provider and throw.
 */
function UndoButton({ onUndo }: { onUndo: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label="Undo"
      variant="ghost"
      size="sm"
      isDisabled={busy}
      onClick={() => {
        setBusy(true);
        void onUndo().finally(() => setBusy(false));
      }}
    />
  );
}

/**
 * Rejecting with a note: the button's words, and what opens the composer at an anchor. Opened from a
 * menu, gone once it closes, the composer hands focus back to `returnFocus`, the menu's button.
 */
export interface NoteAction {
  label: string;
  onOpen: (anchor: NoteAnchor, returnFocus: HTMLElement | null) => void;
}

/**
 * One open run as a single-line banner: a count and one muted hint, then the
 * run's controls and Accept all / Reject all. With a `noteAction`, Reject all is a split
 * button whose menu rejects all with a note. `list` is the expandable per-change drawer under it.
 */
export function RunBanner({
  updatedAt,
  title,
  hint,
  controls,
  list,
  busy,
  onDecide,
  noteAction,
}: {
  updatedAt: number;
  title: string;
  hint: string;
  controls?: ReactNode;
  list?: ReactNode;
  busy: boolean;
  onDecide: (decision: "accept" | "reject") => void;
  noteAction?: NoteAction;
}) {
  const live = useLiveWindow(updatedAt);
  // The composer floats beside the whole Reject all control, not the menu that opened it.
  const rejectGroup = useRef<HTMLDivElement>(null);
  const rejectMenu = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="agent-run">
      {/* No `description`: with the title as its only text the Banner keeps to one line. */}
      <Banner
        className={`agent-run-bar${live ? " agent-run-bar--live" : ""}`}
        status="info"
        container="section"
        icon={<Zap size={16} />}
        title={
          <span className="agent-run-title">
            <span className="agent-run-title__main">{title}</span>
            <span className="agent-run-title__hint">{hint}</span>
          </span>
        }
        endContent={
          <HStack gap={2} vAlign="center">
            {controls}
            {list && (
              <Button
                label={expanded ? "Hide the individual changes" : "Review each change"}
                variant="ghost"
                size="sm"
                icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                onClick={() => setExpanded((e) => !e)}
              >
                Review each
              </Button>
            )}
            <Button label="Accept all" variant="primary" size="sm" isDisabled={busy} onClick={() => onDecide("accept")} />
            {noteAction ? (
              <ButtonGroup ref={rejectGroup} label="Reject all" size="sm">
                <Button label="Reject all" variant="secondary" size="sm" isDisabled={busy} onClick={() => onDecide("reject")} />
                <DropdownMenu
                  button={{
                    label: "More ways to reject",
                    variant: "secondary",
                    size: "sm",
                    isIconOnly: true,
                    icon: <ChevronDown size={15} />,
                    isDisabled: busy,
                    onMouseDown: keepFocus,
                    ref: rejectMenu,
                  }}
                  hasChevron={false}
                  alignment="end"
                  items={[
                    {
                      label: noteAction.label,
                      onClick: () => rejectGroup.current && noteAction.onOpen(anchorRect(rejectGroup.current), rejectMenu.current),
                    },
                  ]}
                />
              </ButtonGroup>
            ) : (
              <Button label="Reject all" variant="secondary" size="sm" isDisabled={busy} onClick={() => onDecide("reject")} />
            )}
          </HStack>
        }
      />
      {list && expanded && list}
    </div>
  );
}

/** A run that applied at once, offered on the reviewer's next visit. */
export function CatchUpBanner({
  title,
  description,
  view,
  revert,
  onDismiss,
}: {
  title: string;
  description: string;
  view: ReactNode;
  /** Omitted once the run was reverted. */
  revert?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Banner
      className="agent-catchup"
      status="info"
      container="section"
      icon={<Sparkles size={16} />}
      title={title}
      description={description}
      endContent={
        <HStack gap={2}>
          {view}
          {revert}
          <Button label="Dismiss" variant="ghost" size="sm" onClick={onDismiss} />
        </HStack>
      }
    />
  );
}
