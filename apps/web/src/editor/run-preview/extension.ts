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
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { resolveRelRange, type RelRange } from "../rel-range";
import { ghostVariant, ghostWidgetKey, numberHunks, planRunPaint, tableRowContext, type HunkKey, type RunPreviewData, type RunReport } from "./plan";
import { runGhost } from "./ghost-dom";

interface RunPreviewOptions {
  /** The shared Y.Doc the segments' relative anchors resolve against. */
  ydoc: Y.Doc | null;
}

export const EMPTY_REPORT: RunReport = { anchored: [], unanchored: [] };
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
}

const runPreviewKey = new PluginKey("runPreview");

export const RunPreview = Extension.create<RunPreviewOptions, RunPreviewStorage>({
  name: "runPreview",

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
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const storage = this.storage;
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
            if (cache && cache.doc === state.doc && cache.runs === runs && cache.pending === pendingKeys) {
              return cache.set;
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

  // In document order, so a hunk with several segments anchors on its topmost one.
  for (const seg of [...placed].sort((a, b) => a.from - b.from || a.build - b.build)) {
    for (const key of seg.keys) if (!anchors.has(key)) anchors.set(key, { from: seg.from, to: seg.to });
    // The word form shows its deletions inside the ghost, so the live block isn't struck.
    const wordForm = seg.parts.length === 1 && !!seg.parts[0]!.words;
    if (!wordForm && seg.from < seg.to) {
      decos.push(Decoration.inline(seg.from, seg.to, { class: "ai-preview-delete" }));
    }
    // Even a pure deletion gets a widget: it carries the Accept/Reject buttons.
    const parts = seg.parts;
    if (parts.length === 0) continue;
    // Asked at `seg.to`, where the widget mounts, and folded into the key so a
    // <div> ghost is never reused where a <tr> shell belongs.
    const tableCols = tableRowContext(state.doc, seg.to);
    decos.push(
      Decoration.widget(seg.to, (view) => runGhost(parts, ordinals, totals, pendingKeys, view, seg.from, tableCols), {
        side: 1,
        key: ghostWidgetKey(seg.build, seg.keys, ghostVariant(parts, ordinals, totals, pendingKeys) + (tableCols ? `-t${tableCols}` : "")),
      }),
    );
  }
  return report;
}

/** Store the paint's classification and notify React when it actually changed. */
function publishReport(storage: RunPreviewStorage, report: RunReport, anchors: Map<HunkKey, { from: number; to: number }>): void {
  storage.runAnchors = anchors;
  const prev = storage.runReport;
  if (prev.anchored.join("|") === report.anchored.join("|") && prev.unanchored.join("|") === report.unanchored.join("|")) {
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
