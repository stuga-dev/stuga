/** Drives the run preview from the open runs' pending hunks and reports what it could show. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { captureRelRange } from "../rel-range";
import { buildRunSegments, type HunkKey, type PreviewSegment, type RunPreviewData, type RunPreviewHunk, type RunReport } from "./plan";
import { EMPTY_REPORT, previewStorage, publish, repaint } from "./extension";

/** Class `scrollToHunk` flashes on the ghost it scrolled to. */
const FLASH_CLASS = "ai-preview-hunk--flash";
const FLASH_MS = 1200;

/** Trailing debounce for recomputing the paint after document changes (a block diff per hunk). */
const REPUBLISH_DEBOUNCE_MS = 250;

/** What `useRunPreview` hands the review UI. */
export interface RunPreviewApi {
  /** Hunks painted inline, in document order. */
  anchored: HunkKey[];
  /** Pending hunks that could not be painted. */
  unanchored: HunkKey[];
  /** Scroll a hunk's ghost into view and flash it. False if it is not anchored. */
  scrollToHunk: (key: HunkKey) => boolean;
}

/** Set equality by content. */
function sameKeys(a: ReadonlySet<HunkKey>, b: ReadonlySet<HunkKey>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/** Anchor the drafts to stable Yjs positions; un-anchorable ones stay decidable. */
function runHunksPreview(editor: Editor, currentMd: string, hunks: RunPreviewHunk[]): RunPreviewData | null {
  const { segments: drafts, unpaintable } = buildRunSegments(editor.state.doc, currentMd, hunks, editor.schema);
  const segments: PreviewSegment[] = [];
  const orphaned: HunkKey[] = [...unpaintable];
  for (const draft of drafts) {
    const rel = captureRelRange(editor.state, draft.from, draft.to);
    if (!rel) {
      for (const part of draft.hunks) orphaned.push(part.key);
      continue;
    }
    segments.push({ rel, hunks: draft.hunks });
  }
  if (segments.length === 0 && orphaned.length === 0) return null;
  return { segments, unpaintable: orphaned };
}

/**
 * Drive the overlay from the pending hunks. `anchored`/`unanchored` come from
 * every paint, not from the last publish, because a collaborator's edit can
 * orphan an anchor without this hook re-running.
 */
export function useRunPreview(
  editor: Editor | null,
  ydoc: Y.Doc | null,
  hunks: RunPreviewHunk[],
  pendingKeys: ReadonlySet<HunkKey>,
): RunPreviewApi {
  const [report, setReport] = useState<RunReport>(EMPTY_REPORT);
  const editorRef = useRef<Editor | null>(editor);
  editorRef.current = editor;
  const flashRef = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);

  // Separate from the publish effect, so a re-publish never drops the subscription mid-paint.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const storage = previewStorage(editor);
    if (!storage) return;
    storage.onRunReport = setReport;
    setReport(storage.runReport);
    return () => {
      storage.onRunReport = null;
    };
  }, [editor]);

  /**
   * Recompute when the pending set changes and when the document does: which
   * hunks anchor depends on the document (a chained hunk becomes paintable only
   * once the accept of the hunk before it arrives). `publish` dispatches a
   * meta-only transaction, so a repaint can't feed itself.
   */
  useEffect(() => {
    if (!editor || editor.isDestroyed || !ydoc) return;
    if (hunks.length === 0) {
      publish(editor, null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const recompute = (): void => {
      timer = null;
      if (editor.isDestroyed) return;
      let data: RunPreviewData | null = null;
      try {
        data = runHunksPreview(editor, yXmlFragmentToMarkdown(ydoc.getXmlFragment("default")), hunks);
      } catch {
        data = null;
      }
      publish(editor, data);
    };
    // Immediately for the hunk set (a decided hunk's ghost goes now), then debounced per document change.
    recompute();
    const onDocUpdate = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recompute, REPUBLISH_DEBOUNCE_MS);
    };
    ydoc.on("update", onDocUpdate);
    return () => {
      if (timer) clearTimeout(timer);
      ydoc.off("update", onDocUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, ydoc, hunks]);

  // Separate from the block diff, which a click must not re-run. Compared by
  // content: a set rebuilt each render would otherwise repaint in a loop.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const storage = previewStorage(editor);
    if (!storage) return;
    if (sameKeys(storage.runPending, pendingKeys)) return;
    storage.runPending = pendingKeys;
    repaint(editor);
  }, [editor, pendingKeys]);

  useEffect(() => {
    return () => {
      if (flashRef.current) clearTimeout(flashRef.current.timer);
    };
  }, []);

  const scrollToHunk = useCallback((key: HunkKey): boolean => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return false;
    const storage = previewStorage(ed);
    if (!storage || !storage.runReport.anchored.includes(key)) return false;

    // A scan rather than a selector, which would need the key escaped.
    let target: HTMLElement | null = null;
    for (const el of Array.from(ed.view.dom.querySelectorAll<HTMLElement>("[data-hunk-key]"))) {
      if (el.dataset.hunkKey === key) {
        target = el;
        break;
      }
    }
    // The widget isn't in the DOM yet: scroll to the anchored text, never moving focus or the caret.
    if (!target) {
      const at = storage.runAnchors.get(key);
      if (!at) return false;
      try {
        const node = ed.view.domAtPos(at.from).node;
        target = (node.nodeType === 1 ? (node as HTMLElement) : node.parentElement) ?? null;
      } catch {
        return false;
      }
      if (!target) return false;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }

    target.scrollIntoView({ block: "center", behavior: "smooth" });
    if (flashRef.current) {
      clearTimeout(flashRef.current.timer);
      flashRef.current.el.classList.remove(FLASH_CLASS);
    }
    const el = target;
    el.classList.add(FLASH_CLASS);
    flashRef.current = {
      el,
      timer: setTimeout(() => {
        el.classList.remove(FLASH_CLASS);
        flashRef.current = null;
      }, FLASH_MS),
    };
    return true;
  }, []);

  return { anchored: report.anchored, unanchored: report.unanchored, scrollToHunk };
}
