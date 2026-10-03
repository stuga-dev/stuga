/**
 * Request changes: a rejection with a note saying what should change. The agent that proposed it is
 * handed the note with its next read or proposal here; the in-app co-author takes it as its next turn.
 */
import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { RUN_FEEDBACK_NOTE_MAX_CHARS } from "@stuga/protocol/domain/limits";

/** Where a floating composer opens: just under this viewport point. */
export interface NoteAnchor {
  top: number;
  left: number;
}

/** The anchor under the control a click came from. */
export function anchorOf(e: ReactMouseEvent<HTMLElement>): NoteAnchor {
  const r = e.currentTarget.getBoundingClientRect();
  return { top: r.bottom, left: r.left };
}

/** Pressing a control that opens the composer leaves focus, and the editor's caret, where they were. */
export const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

export interface RejectNoteRequest {
  title: string;
  /** "Revise now" where the co-author takes the note as its next turn. */
  submitLabel?: string;
  /** What is being turned down, quoted above the note. */
  quote?: string;
  /**
   * Float beside this point, as Edit with AI does, so the reviewer stays in the document. Without
   * one (the inbox, away from any document) a dialog opens.
   */
  anchor?: NoteAnchor;
  onSubmit: (note: string) => void;
}

/** Composer width and the room kept below it, as Edit with AI's composer has. */
const COMPOSER_WIDTH = 300;
const COMPOSER_ROOM = 200;

/**
 * The floating composer: the change quoted, one note field, Enter sends, Shift+Enter breaks a line,
 * Escape closes. No backdrop, so the document stays in view and in reach.
 */
function RequestChangesComposer({ request, anchor, onClose }: { request: RejectNoteRequest; anchor: NoteAnchor; onClose: () => void }) {
  const [note, setNote] = useState("");
  const text = note.trim();
  const tooLong = text.length > RUN_FEEDBACK_NOTE_MAX_CHARS;
  const submit = () => {
    if (!text || tooLong) return;
    request.onSubmit(text);
    onClose();
  };
  const top = Math.max(8, Math.min(anchor.top + 6, window.innerHeight - COMPOSER_ROOM));
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - COMPOSER_WIDTH - 8));

  return createPortal(
    <div
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
        isLabelHidden
        hasAutoFocus
        value={note}
        placeholder="What should change? The AI revises from this."
        rows={2}
        maxLength={RUN_FEEDBACK_NOTE_MAX_CHARS}
        onChange={setNote}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <HStack gap={2} justify="end">
        <Button label="Cancel" variant="ghost" size="sm" onMouseDown={keepFocus} onClick={onClose} />
        <Button
          label={request.submitLabel ?? "Request changes"}
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
              description="The AI revises from this."
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
              <Button label={request.submitLabel ?? "Request changes"} variant="primary" isDisabled={!text || tooLong} onClick={submit} />
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
  const close = useCallback(() => {
    setRequest(null);
    const el = returnTo.current;
    returnTo.current = null;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }, []);
  const dialog =
    request &&
    (request.anchor ? (
      <RequestChangesComposer request={request} anchor={request.anchor} onClose={close} />
    ) : (
      <RejectNoteDialog request={request} onClose={close} />
    ));
  return { ask, dialog };
}
