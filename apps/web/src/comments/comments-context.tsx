/**
 * Comments context — the single source of truth for a document's comments,
 * shared between the editor surface (highlights + selection composer) and the
 * side panel (list + resolve). It runs alongside the EditorProvider, reads the
 * live editor out of it, and keeps the CommentHighlight extension's storage in
 * sync so highlights repaint whenever the comment set changes.
 *
 * Comments are loaded over REST (matching the rest of Stuga) and updated
 * optimistically; there is no live WS comment channel yet, so collaborators see
 * each other's comments on their next load / reconnect.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { Docs, type Comment, type CommentAnchor } from "../api";
import { useSharedEditor } from "../editor/editor-context";
import { anchorFromSelection, resolveAnchorRange } from "./anchor";

/**
 * How long a resolved thread's anchor stays lit after it is clicked in the
 * sidebar. Long enough to read the sentence it points at, short enough that the
 * document is back to its resolved-and-quiet state before the user acts on it —
 * and matched by the CSS fade on `.comment-highlight--flash`.
 */
const FLASH_MS = 2600;

/** A comment being composed against a live selection, positioned near its anchor. */
export interface PendingComment {
  anchor: CommentAnchor;
  rect: { top: number; left: number };
}

interface CommentsCtx {
  comments: Comment[];
  activeNum: number | null;
  pending: PendingComment | null;
  /** Capture the current selection as a comment anchor and open the composer over it. */
  startForSelection: () => void;
  /** Persist the pending comment; resolves true on success so the composer keeps the draft on failure. */
  submit: (body: string) => Promise<boolean>;
  cancel: () => void;
  setActive: (num: number | null) => void;
  clickComment: (num: number) => void;
  resolve: (num: number, resolved: boolean) => void;
  del: (num: number) => void;
  /** Post a reply to a thread (parentNum = the root comment's num). Resolves true on success. */
  reply: (parentNum: number, body: string) => Promise<boolean>;
  reload: () => void;
}

const Ctx = createContext<CommentsCtx | null>(null);

export function CommentsProvider({
  docId,
  ydoc,
  onReveal,
  children,
}: {
  docId: string;
  ydoc: Y.Doc | null;
  /** Called when a comment is clicked in the editor or the panel; the page brings the Comments panel into view. */
  onReveal?: (num: number) => void;
  children: ReactNode;
}) {
  const { editor } = useSharedEditor();
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeNum, setActiveNum] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  // A resolved thread the user just clicked, painted briefly so they can see
  // WHICH words it was about. See FLASH_MS and clickComment below.
  const [flashNum, setFlashNum] = useState<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashFrame = useRef<number | null>(null);

  const reload = useCallback(() => {
    Docs.comments(docId)
      .then((r) => setComments(r.comments))
      .catch(() => {});
  }, [docId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Mirror comments + active state into the highlight extension's storage, then
  // dispatch a no-op transaction so its decorations recompute.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // editor.storage is strongly typed per-extension in Tiptap v3; our extension's
    // storage shape isn't in that global map, so reach it through an index cast.
    const storage = (
      editor.storage as unknown as Record<
        string,
        { comments: Comment[]; activeNum: number | null; flashNum: number | null } | undefined
      >
    ).commentHighlight;
    if (!storage) return;
    storage.comments = comments;
    storage.activeNum = activeNum;
    storage.flashNum = flashNum;
    try {
      editor.view.dispatch(editor.state.tr.setMeta("commentHighlight", true));
    } catch {
      /* view not ready yet — the next state change will repaint */
    }
  }, [comments, activeNum, flashNum, editor]);

  // A flash belongs to ONE document. Clear the timer when this provider is torn
  // down or switched to another doc, and drop the number with it: comment nums
  // are per-document, so carrying a live `flashNum` across would light up the
  // new document's comment with the same number — and, since the timer that
  // would have cleared it is gone, light it up permanently.
  useEffect(() => {
    setFlashNum(null);
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
      flashTimer.current = null;
      flashFrame.current = null;
    };
  }, [docId]);

  // Clicking anywhere in the editor that isn't a highlight clears the active comment.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".comment-highlight")) setActiveNum(null);
    };
    dom.addEventListener("mousedown", handler);
    return () => dom.removeEventListener("mousedown", handler);
  }, [editor]);

  const startForSelection = useCallback(() => {
    if (!editor) return;
    const anchor = anchorFromSelection(editor);
    if (!anchor) return;
    const { to } = editor.state.selection;
    const coords = editor.view.coordsAtPos(to);
    setPending({ anchor, rect: { top: coords.bottom, left: coords.left } });
  }, [editor]);

  // Keep the open composer pinned under its anchor as the page scrolls/resizes.
  const pendingEndRef = useRef<string | null>(null);
  pendingEndRef.current = pending?.anchor.end ?? null;
  const pendingKey = pending?.anchor.start ?? null;
  useEffect(() => {
    if (!editor || !pendingKey || !ydoc) return;
    const recompute = () => {
      const end = pendingEndRef.current;
      if (!end) return;
      const range = resolveAnchorRange(ydoc, editor.state, pendingKey, end);
      if (!range) return;
      const coords = editor.view.coordsAtPos(range.to);
      if (coords.top === 0 && coords.left === 0) return;
      setPending((prev) => {
        if (!prev) return prev;
        if (Math.abs(coords.bottom - prev.rect.top) < 1 && Math.abs(coords.left - prev.rect.left) < 1) return prev;
        return { anchor: prev.anchor, rect: { top: coords.bottom, left: coords.left } };
      });
    };
    const scroller = document.querySelector(".doc-main");
    scroller?.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    editor.on("transaction", recompute);
    return () => {
      scroller?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
      editor.off("transaction", recompute);
    };
  }, [editor, pendingKey, ydoc]);

  const submit = useCallback(
    async (body: string): Promise<boolean> => {
      const text = body.trim();
      if (!text || !pending) return false;
      try {
        const c = await Docs.addComment(docId, text, pending.anchor);
        setComments((cs) => [...cs, c]);
        setPending(null);
        setActiveNum(c.num);
        return true;
      } catch {
        // Don't drop the user's text: keep the composer open and resync from the
        // server (covers a num-collision retry that already landed, etc.).
        reload();
        return false;
      }
    },
    [docId, pending, reload],
  );

  const cancel = useCallback(() => setPending(null), []);

  const clickComment = useCallback(
    (num: number) => {
      setActiveNum(num);
      onReveal?.(num);
      if (!editor || !ydoc) return;
      const c = comments.find((x) => x.num === num);
      if (!c?.anchor_start || !c.anchor_end) return;
      // A resolved thread has no standing highlight, so scrolling to it alone
      // drops the reader into the middle of a paragraph with no indication of
      // which words were discussed. Paint the range for FLASH_MS instead —
      // temporary, so resolved threads still don't clutter the document, and
      // re-armed on every click so a second click keeps it lit rather than
      // letting the first click's timer cut it short.
      if (c.resolved) {
        if (flashTimer.current) clearTimeout(flashTimer.current);
        if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
        if (flashNum === num) {
          // Re-clicking the thread that is ALREADY lit has to restart the fade,
          // and setting state to the value it already holds is a React no-op —
          // no render, so the decoration is never rebuilt and the CSS animation
          // (which ends `forwards` at zero opacity) never replays. Past the 2.4s
          // fade the highlight is already invisible, so the click looked dead.
          // Drop the decoration for one frame; the next render mounts a fresh
          // element and the animation starts from the top.
          setFlashNum(null);
          flashFrame.current = requestAnimationFrame(() => {
            flashFrame.current = null;
            setFlashNum(num);
          });
        } else {
          setFlashNum(num);
        }
        flashTimer.current = setTimeout(() => {
          flashTimer.current = null;
          setFlashNum((cur) => (cur === num ? null : cur));
        }, FLASH_MS);
      } else if (flashNum !== null) {
        // Moving to an unresolved thread ends any flash immediately: two
        // highlights competing for attention is worse than none.
        if (flashTimer.current) clearTimeout(flashTimer.current);
        if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
        flashTimer.current = null;
        flashFrame.current = null;
        setFlashNum(null);
      }
      const range = resolveAnchorRange(ydoc, editor.state, c.anchor_start, c.anchor_end);
      if (!range) return;
      editor.chain().focus().setTextSelection(range.from).run();
      requestAnimationFrame(() => {
        const dom = editor.view.domAtPos(range.from);
        const node = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        node?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    },
    [editor, ydoc, comments, flashNum, onReveal],
  );

  const resolve = useCallback(
    (num: number, resolved: boolean) => {
      setComments((cs) => cs.map((c) => (c.num === num ? { ...c, resolved } : c)));
      if (activeNum === num && resolved) setActiveNum(null);
      Docs.resolveComment(docId, num, resolved).catch(() => reload());
    },
    [docId, activeNum, reload],
  );

  const del = useCallback(
    (num: number) => {
      // Optimistic remove; resync from the server if the delete is rejected
      // (e.g. not the author/owner) so the comment reappears. Deleting a root
      // also removes its replies (the DB FK cascades; mirror that locally so the
      // thread vanishes immediately).
      setComments((cs) => cs.filter((c) => c.num !== num && c.parent_num !== num));
      if (activeNum === num) setActiveNum(null);
      Docs.deleteComment(docId, num).catch(() => reload());
    },
    [docId, activeNum, reload],
  );

  const reply = useCallback(
    async (parentNum: number, body: string): Promise<boolean> => {
      const text = body.trim();
      if (!text) return false;
      try {
        const c = await Docs.replyComment(docId, parentNum, text);
        setComments((cs) => [...cs, c]);
        return true;
      } catch {
        // Keep the draft (the reply box won't clear) and resync.
        reload();
        return false;
      }
    },
    [docId, reload],
  );

  const value: CommentsCtx = {
    comments,
    activeNum,
    pending,
    startForSelection,
    submit,
    cancel,
    setActive: setActiveNum,
    clickComment,
    resolve,
    del,
    reply,
    reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useComments(): CommentsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useComments must be used within a CommentsProvider");
  return ctx;
}
