/**
 * Paints the agent-run ledger's pending hunks inline as a view-only diff: the
 * old text struck, a ghost of the new text with its own Accept/Reject. Like
 * CommentHighlight, the decorations come from the extension's `storage` (kept in
 * sync by `useRunPreview`) and never touch the document or the CRDT.
 *
 * A hunk that rewords one text block paints word by word; anything structural
 * strikes the changed region and ghosts the replacement blocks. Segments can
 * address one list item, table row or quoted paragraph, not only top-level blocks.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { WordOp } from "@stuga/crdt-ops";
import { hash32 } from "../../lib/hash";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { resolveRelRange, type RelRange } from "../rel-range";
import {
  ghostVariant,
  ghostWidgetKey,
  numberHunks,
  partRoles,
  planRunPaint,
  tableRowContext,
  type HunkKey,
  type PartRole,
  type RunPreviewData,
  type RunReport,
} from "./plan";
import { ghostIsEmpty, holdWhileComposing, isInHunkNote, runGhost } from "./ghost-dom";

interface RunPreviewOptions {
  /** The shared Y.Doc the segments' relative anchors resolve against. */
  ydoc: Y.Doc | null;
}

export const EMPTY_REPORT: RunReport = { anchored: [], unanchored: [], why: {} };
const EMPTY_PENDING: ReadonlySet<HunkKey> = new Set<HunkKey>();

interface RunPreviewStorage {
  runPreview: RunPreviewData | null;
  /** Hunk keys with a decision in flight: dimmed, buttons disabled. */
  runPending: ReadonlySet<HunkKey>;
  /** Classification produced by the most recent paint. */
  runReport: RunReport;
  /** Notified asynchronously whenever `runReport` changes. */
  onRunReport: ((report: RunReport) => void) | null;
  /** Where each anchored hunk's topmost ghost sat at the last paint (scrollToHunk). */
  runAnchors: Map<HunkKey, { from: number; to: number }>;
  /** The reviewer's history of typing and decisions; null leaves undo to the editor alone. */
  history: ReviewHistoryHandle | null;
}

/** What the run preview needs of the review history (review/review-history.ts). */
export interface ReviewHistoryHandle {
  /** True when the latest action was a decision, now being undone; false leaves it to the editor. */
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
}

const runPreviewKey = new PluginKey("runPreview");

export const RunPreview = Extension.create<RunPreviewOptions, RunPreviewStorage>({
  name: "runPreview",
  // Ahead of Collaboration (1000), whose Mod-Z runs when the history leaves typing to it.
  priority: 1100,

  addOptions() {
    return { ydoc: null };
  },

  addStorage() {
    return {
      runPreview: null,
      runPending: EMPTY_PENDING,
      runReport: EMPTY_REPORT,
      onRunReport: null,
      runAnchors: new Map(),
      history: null,
    };
  },

  addKeyboardShortcuts() {
    const redo = () => this.storage.history?.redo() ?? false;
    return { "Mod-z": () => this.storage.history?.undo() ?? false, "Shift-Mod-z": redo, "Mod-y": redo };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const storage = this.storage;
    const editor = this.editor;
    // decorations() runs on every transaction; nothing it paints depends on the
    // selection, so the set is memoized on the document and the two storage fields.
    let cache: {
      doc: PMNode;
      runs: RunPreviewData | null;
      pending: ReadonlySet<HunkKey>;
      set: DecorationSet;
    } | null = null;

    return [
      new Plugin({
        key: runPreviewKey,
        props: {
          decorations(state) {
            const ydoc = options.ydoc;
            const runs = storage.runPreview;
            const pendingKeys = storage.runPending;
            if (!ydoc || !runs) {
              publishReport(storage, EMPTY_REPORT, new Map());
              return DecorationSet.empty;
            }
            if (cache && cache.doc === state.doc) {
              if (cache.runs === runs && cache.pending === pendingKeys) return cache.set;
              // A rebuilt ghost would end a note's composition, so a repaint the document doesn't need waits for its end.
              if (holdWhileComposing(() => repaint(editor))) return cache.set;
            }

            const size = state.doc.content.size;
            const clamp = (r: { from: number; to: number }) => {
              const from = Math.max(0, Math.min(r.from, size));
              return { from, to: Math.max(from, Math.min(r.to, size)) };
            };
            const decos: Decoration[] = [];

            const anchors = new Map<HunkKey, { from: number; to: number }>();
            const report = paintRuns(ydoc, state, runs, pendingKeys, clamp, decos, anchors);
            publishReport(storage, report, anchors);

            const set = DecorationSet.create(state.doc, decos);
            cache = { doc: state.doc, runs, pending: pendingKeys, set };
            return set;
          },
        },
      }),
    ];
  },
});

/** Resolve every segment first, so ghosts are numbered in document order, then build the decorations. */
function paintRuns(
  ydoc: Y.Doc,
  state: EditorState,
  data: RunPreviewData,
  pendingKeys: ReadonlySet<HunkKey>,
  clamp: (r: { from: number; to: number }) => { from: number; to: number },
  decos: Decoration[],
  anchors: Map<HunkKey, { from: number; to: number }>,
): RunReport {
  const resolve = (rel: RelRange) => {
    const r = resolveRelRange(ydoc, state, rel);
    return r ? clamp(r) : null;
  };
  const { placed, report } = planRunPaint(data, resolve);
  const { ordinals, totals } = numberHunks(report);
  const roleMap = partRoles(placed);

  // In document order, so a hunk with several segments anchors on its topmost one.
  for (const seg of [...placed].sort((a, b) => a.from - b.from || a.build - b.build)) {
    // A hunk's buttons decide all of it, so only its last segment carries them.
    const roles = roleMap.get(seg.build) ?? new Map<HunkKey, PartRole>();
    for (const key of seg.keys) if (!anchors.has(key)) anchors.set(key, { from: seg.from, to: seg.to });
    // A reworded block is diffed on its own live text, so it is not shown twice. Should the block
    // have changed since the diff was made, the ghost shows the diff instead and the block stays unmarked.
    const words = seg.parts.length === 1 ? seg.parts[0]!.words : undefined;
    const inline = words ? inlineWordDecos(state.doc, seg.from, seg.to, words, seg.build) : null;
    if (inline) decos.push(...inline);
    else if (!words && seg.from < seg.to) {
      decos.push(Decoration.inline(seg.from, seg.to, { class: "ai-preview-delete" }));
    }
    railBlocks(state.doc, seg.from, seg.to, decos);
    // Even a pure deletion gets a widget, for its buttons; one continuing into the next segment has none to carry.
    const parts = seg.parts;
    if (parts.length === 0 || ghostIsEmpty(parts, !!inline, roles)) continue;
    // Asked at `seg.to`, where the widget mounts, and folded into the key so a
    // <div> ghost is never reused where a <tr> shell belongs.
    const tableCols = tableRowContext(state.doc, seg.to);
    decos.push(
      Decoration.widget(seg.to, (view) => runGhost(parts, ordinals, totals, pendingKeys, view, seg.from, tableCols, roles, !!inline), {
        side: 1,
        // A change's note is a field of its own: its keys, clicks and caret are not the editor's.
        stopEvent: isInHunkNote,
        ignoreSelection: true,
        key: ghostWidgetKey(
          seg.build,
          seg.keys,
          ghostVariant(parts, ordinals, totals, pendingKeys, roles) + (tableCols ? `-t${tableCols}` : "") + (inline ? "-i" : ""),
        ),
      }),
    );
  }
  return report;
}

/**
 * The rail down the left of a change's live blocks, which runs on through its ghost, so the parts
 * of one change read as one. Table rows go without: a border there would draw on the grid.
 */
function railBlocks(doc: PMNode, from: number, to: number, decos: Decoration[]): void {
  for (let pos = from; pos < to; ) {
    const node = doc.nodeAt(pos);
    if (!node) return;
    if (!node.type.spec.tableRole) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "ai-preview-part" }));
    pos += node.nodeSize;
  }
}

/**
 * A word diff drawn on the live textblock between `from` and `to`: deletions struck in place,
 * insertions as widgets. Null unless the block still holds exactly the text the diff was made from.
 */
function inlineWordDecos(doc: PMNode, from: number, to: number, words: WordOp[], build: number): Decoration[] | null {
  const node = doc.nodeAt(from);
  if (!node || !node.isTextblock || from + node.nodeSize !== to) return null;
  const old = words.filter((op) => op.type !== "ins").map((op) => op.text).join("");
  if (node.textContent !== old || node.content.size !== old.length) return null;
  const out: Decoration[] = [];
  let at = from + 1;
  words.forEach((op, i) => {
    if (op.type === "ins") {
      const text = op.text;
      out.push(
        Decoration.widget(
          at,
          () => {
            const el = document.createElement("ins");
            el.className = "ai-preview-insert";
            el.setAttribute("contenteditable", "false");
            el.textContent = text;
            return el;
          },
          { side: 1, marks: [], key: `ai-preview-ins-${build}-${i}-${hash32(text)}` },
        ),
      );
      return;
    }
    if (op.type === "del") out.push(Decoration.inline(at, at + op.text.length, { class: "ai-preview-delete" }));
    at += op.text.length;
  });
  return out;
}

/** Store the paint's classification and notify React when it actually changed. */
function publishReport(storage: RunPreviewStorage, report: RunReport, anchors: Map<HunkKey, { from: number; to: number }>): void {
  storage.runAnchors = anchors;
  const prev = storage.runReport;
  if (
    prev.anchored.join("|") === report.anchored.join("|") &&
    prev.unanchored.join("|") === report.unanchored.join("|") &&
    prev.unanchored.every((k) => prev.why[k] === report.why[k])
  ) {
    return;
  }
  storage.runReport = report;
  const notify = storage.onRunReport;
  if (!notify) return;
  // Deferred out of ProseMirror's view update, where a React setState must not run.
  queueMicrotask(() => notify(report));
}

/** The extension's storage (not in Tiptap's typed global map). */
export function previewStorage(editor: Editor): RunPreviewStorage | undefined {
  return (editor.storage as unknown as Record<string, RunPreviewStorage | undefined>).runPreview;
}

/** Undo through the review history: a decision when it was the latest action, else the editor's own undo. */
export function historyUndo(editor: Editor): boolean {
  return previewStorage(editor)?.history?.undo() === true || editor.commands.undo();
}

export function historyRedo(editor: Editor): boolean {
  return previewStorage(editor)?.history?.redo() === true || editor.commands.redo();
}

/** Whether the toolbar's Undo or Redo has anything to do. */
export function historyCan(editor: Editor, which: "undo" | "redo"): boolean {
  const history = previewStorage(editor)?.history;
  return which === "undo" ? history?.canUndo() === true || editor.can().undo() : history?.canRedo() === true || editor.can().redo();
}

/** Ask the view to repaint (storage is not part of ProseMirror state). */
export function repaint(editor: Editor): void {
  try {
    editor.view.dispatch(editor.state.tr.setMeta(runPreviewKey, true));
  } catch {
    // The view isn't mounted yet; its first state change paints.
  }
}

/** Write the preview into storage and repaint. */
export function publish(editor: Editor, preview: RunPreviewData | null): void {
  const storage = previewStorage(editor);
  if (!storage) return;
  storage.runPreview = preview;
  repaint(editor);
}
