/**
 * Request changes: a rejection with a note saying what should change. The agent that proposed it is
 * handed the note with its next read or proposal here; the in-app co-author takes it as its next turn.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { RUN_FEEDBACK_NOTE_MAX_CHARS } from "@stuga/protocol/domain/limits";

/** The viewport box of the control that opened a floating composer. */
export interface NoteAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The box of an element, as a composer's anchor. */
export function anchorRect(el: Element): NoteAnchor {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

/** The anchor of the control a click came from. */
export function anchorOf(e: ReactMouseEvent<HTMLElement>): NoteAnchor {
  return anchorRect(e.currentTarget);
}

/** Pressing a control that opens the composer leaves focus, and the editor's caret, where they were. */
export const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

export interface RejectNoteRequest {
  title: string;
  /** "Reject and revise" where the co-author revises at once; "Reject with note" otherwise. */
  submitLabel?: string;
  /**
   * One line under the note saying what happens to it, where the submit label doesn't. Omitted, it
   * fits an agent outside the app; null when the label says it all.
   */
  hint?: string | null;
  /** What is being turned down, quoted above the note. */
  quote?: string;
  /**
   * Float beside this point, as Edit with AI does, so the reviewer stays in the document. Without
   * one (the inbox, away from any document) a dialog opens.
   */
  anchor?: NoteAnchor;
  onSubmit: (note: string) => void;
}

/** Where an agent outside the app finds the note: with its next read or proposal here. */
const AGENT_HINT = "The agent gets your note the next time it works here.";

/** Composer width, as Edit with AI's composer has, and the room kept below its top. */
const COMPOSER_WIDTH = 300;
const COMPOSER_ROOM = 200;
const GAP = 8;

/**
 * Beside the control when there is room, so the rows under it (the next change and its buttons) stay
 * in reach; under it, kept on screen, when there is not (a control at the window's right edge).
 */
export function composerPosition(anchor: NoteAnchor, viewport: { width: number; height: number }): { top: number; left: number } {
  const beside = anchor.right + GAP;
  const fits = beside + COMPOSER_WIDTH + GAP <= viewport.width;
  const top = fits ? anchor.top - 4 : anchor.bottom + 6;
  const left = fits ? beside : Math.min(anchor.left, viewport.width - COMPOSER_WIDTH - GAP);
  return { top: Math.max(GAP, Math.min(top, viewport.height - COMPOSER_ROOM)), left: Math.max(GAP, left) };
}

/**
 * The floating composer: the change quoted, one note field, Enter sends, Shift+Enter breaks a line,
 * Escape closes, and so does a press outside it while the note is empty. No backdrop, so the
 * document stays in view and in reach.
 */
function RequestChangesComposer({
  request,
  anchor,
  onClose,
}: {
  request: RejectNoteRequest;
  anchor: NoteAnchor;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const text = note.trim();
  const tooLong = text.length > RUN_FEEDBACK_NOTE_MAX_CHARS;
  const submit = () => {
    if (!text || tooLong) return;
    request.onSubmit(text);
    onClose();
  };
  const box = useRef<HTMLDivElement>(null);
  const empty = useRef(true);
  empty.current = !text;
  // A press elsewhere goes where it was aimed (focus stays there); a note already written is kept open.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (empty.current && box.current && !box.current.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  const { top, left } = composerPosition(anchor, { width: window.innerWidth, height: window.innerHeight });

  return createPortal(
    <div
      ref={box}
      className="ai-edit-composer"
      style={{ top, left }}
      role="dialog"
      aria-label={request.title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {request.quote && (
        <div className="ai-edit-composer__quote" dir="auto" title={request.quote}>
          {request.quote}
        </div>
      )}
      <TextArea
        label="What should change?"
        description={request.hint === undefined ? AGENT_HINT : (request.hint ?? undefined)}
        hasAutoFocus
        value={note}
        rows={2}
        size="sm"
        status={tooLong ? { type: "error", message: `Keep it under ${RUN_FEEDBACK_NOTE_MAX_CHARS} characters.` } : undefined}
        onChange={setNote}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <HStack gap={2} justify="end">
        <Button label="Cancel" variant="ghost" size="sm" onMouseDown={keepFocus} onClick={() => onClose()} />
        <Button
          label={request.submitLabel ?? "Reject with note"}
          variant="primary"
          size="sm"
          onMouseDown={keepFocus}
          isDisabled={!text || tooLong}
          onClick={submit}
        />
      </HStack>
    </div>,
    document.body,
  );
}

function RejectNoteDialog({ request, onClose }: { request: RejectNoteRequest; onClose: () => void }) {
  const [note, setNote] = useState("");
  const text = note.trim();
  const tooLong = text.length > RUN_FEEDBACK_NOTE_MAX_CHARS;

  function submit() {
    if (!text || tooLong) return;
    request.onSubmit(text);
    onClose();
  }

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={request.title} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <TextArea
              label="What should change?"
              description={request.hint === undefined ? AGENT_HINT : (request.hint ?? undefined)}
              value={note}
              onChange={setNote}
              rows={4}
              maxLength={RUN_FEEDBACK_NOTE_MAX_CHARS}
              hasAutoFocus
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
              <Button label={request.submitLabel ?? "Reject with note"} variant="primary" isDisabled={!text || tooLong} onClick={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/**
 * `ask` opens the composer for one rejection, floating at its anchor or as a dialog without one;
 * render `dialog` once, anywhere in the caller's tree. It is mounted only while open, so each
 * rejection starts from an empty note, and closing it hands focus back to where it was, so the
 * editor's caret (or the grid's cell) is where the reviewer left it.
 */
export function useRejectNote(): { ask: (request: RejectNoteRequest) => void; dialog: ReactNode } {
  const [request, setRequest] = useState<RejectNoteRequest | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const ask = useCallback((r: RejectNoteRequest) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRequest(r);
  }, []);
  const close = useCallback((restoreFocus = true) => {
    setRequest(null);
    const el = returnTo.current;
    returnTo.current = null;
    if (restoreFocus && el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }, []);
  const dialog =
    request &&
    (request.anchor ? (
      <RequestChangesComposer request={request} anchor={request.anchor} onClose={close} />
    ) : (
      <RejectNoteDialog request={request} onClose={() => close()} />
    ));
  return { ask, dialog };
}
