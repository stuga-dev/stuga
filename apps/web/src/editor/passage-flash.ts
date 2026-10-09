/**
 * Highlights the block a citation or search hit landed on, for as long as the
 * animation in editor.css runs. It is a node decoration because ProseMirror
 * reads a class set by hand on an editable block as an edit, and redraws the
 * block without it before the flash shows. A decoration is redrawn with its
 * block, and moves with it when collaborators edit.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

/** As long as the citation-target-flash animation. */
export const FLASH_MS = 1_600;

const FLASH_ATTRS = { class: "citation-target--flash" };

interface FlashState {
  /** Counts flashes, so the end of one never cuts the next one short. */
  id: number;
  decos: DecorationSet;
}

type FlashMeta = { at: number } | { end: number };

const passageFlashKey = new PluginKey<FlashState>("passageFlash");

/**
 * Flashes the block `dom` renders. A decoration alone changes no document, so it
 * never enters undo history, and the transaction neither scrolls nor moves the
 * selection. An element ProseMirror cannot map to a block does not flash.
 */
export function flashBlock(view: EditorView, dom: HTMLElement): void {
  let at: number;
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(dom, 0));
    if ($pos.depth === 0) return;
    at = $pos.before();
  } catch {
    return;
  }
  // A node view's own DOM may wrap the element, as a mermaid block's does.
  if (!view.nodeDOM(at)?.contains(dom)) return;
  view.dispatch(view.state.tr.setMeta(passageFlashKey, { at } satisfies FlashMeta));
}

/**
 * How a transaction moved positions. y-sync applies a collaborator's edit by
 * replacing the whole document, which its mapping reads as deleting every block;
 * the difference between the two documents is the edit they made.
 */
function mappingOf(tr: Transaction): Mapping {
  const ySync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: unknown } | undefined;
  if (ySync?.isChangeOrigin !== true) return tr.mapping;
  const a = tr.before.content;
  const b = tr.doc.content;
  const start = a.findDiffStart(b);
  if (start == null) return new Mapping();
  let { a: endA, b: endB } = a.findDiffEnd(b)!;
  // Repeated content can put the end before the start, as in ProseMirror's own DOM diff.
  if (endA < start && a.size < b.size) {
    endB = start + (endB - endA);
    endA = start;
  } else if (endB < start) {
    endA = start + (endA - endB);
    endB = start;
  }
  return new Mapping([new StepMap([start, endA - start, endB - start])]);
}

function applyFlash(tr: Transaction, prev: FlashState): FlashState {
  const meta = tr.getMeta(passageFlashKey) as FlashMeta | undefined;
  if (meta && "at" in meta) {
    const node = tr.doc.nodeAt(meta.at);
    if (!node || node.isText) return prev;
    return { id: prev.id + 1, decos: DecorationSet.create(tr.doc, [Decoration.node(meta.at, meta.at + node.nodeSize, FLASH_ATTRS)]) };
  }
  if (meta && meta.end === prev.id) return { id: prev.id, decos: DecorationSet.empty };
  // Collaborators may edit while it shows; a deleted or split block drops it.
  if (!tr.docChanged || prev.decos === DecorationSet.empty) return prev;
  return { id: prev.id, decos: prev.decos.map(mappingOf(tr), tr.doc) };
}

export const PassageFlash = Extension.create({
  name: "passageFlash", // i18n-exempt: extension identifier

  addProseMirrorPlugins() {
    return [
      new Plugin<FlashState>({
        key: passageFlashKey,
        state: {
          init: () => ({ id: 0, decos: DecorationSet.empty }),
          apply: applyFlash,
        },
        props: {
          decorations: (state) => passageFlashKey.getState(state)?.decos,
        },
        // The plugin ends its own flash, so a destroyed editor never gets a late dispatch.
        view(editorView) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let shown = 0;
          const sync = (view: EditorView) => {
            const { id, decos } = passageFlashKey.getState(view.state)!;
            if (id === shown) return;
            shown = id;
            clearTimeout(timer);
            if (decos === DecorationSet.empty) return;
            timer = setTimeout(() => view.dispatch(view.state.tr.setMeta(passageFlashKey, { end: id } satisfies FlashMeta)), FLASH_MS);
          };
          // Reconfiguring the editor makes its plugin views anew, mid-flash or not.
          sync(editorView);
          return { update: sync, destroy: () => clearTimeout(timer) };
        },
      }),
    ];
  },
});
