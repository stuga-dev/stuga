/**
 * Collaborator carets: a thin line and a small name tag, styled in
 * styles/editor.css. The colour travels as `--peer-color`, so the caret, the
 * tag and the selection tint (which y-tiptap's default builds with a hex alpha
 * suffix) all read it. The tag shows while a peer arrives or starts a burst of
 * activity, and on hover, where WCAG 1.4.13 requires it to be hoverable and
 * dismissible with Escape. Activity is an attribute re-applied on every change,
 * not a mount animation, because ProseMirror reuses a widget's DOM while its key
 * matches; for the same reason the name and colour are re-read on every change.
 */
import CollaborationCaret, { type CollaborationCaretOptions } from "@tiptap/extension-collaboration-caret";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { DecorationAttrs, DecorationSet, EditorView } from "@tiptap/pm/view";
import { yCursorPlugin, yCursorPluginKey } from "@tiptap/y-tiptap";
import type { Awareness } from "y-protocols/awareness";
import { PEER_PALETTE } from "../state/identity";

/** How long a peer's name tag stays up once it is armed. */
export const PEER_LABEL_LINGER_MS = 2500;

/** The quiet period that ends a burst; longer than the linger, so a faded tag cannot re-arm at once. */
export const PEER_ACTIVITY_GAP_MS = 3000;

/** The only colour shape y-tiptap accepts without warning on every rebuild. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * What y-tiptap substitutes for a peer with no colour. Illegible under white
 * text, so it is read as absent; Stuga's palette never publishes it.
 */
const Y_TIPTAP_DEFAULT_COLOR = "#ffa500";

/** Within this of the editor's right edge a name tag is mirrored to the caret's left: its max-width plus slack. */
const LABEL_FLIP_PX = 168;

/** Set on the editor root while Escape has dismissed the hovered name tag (WCAG 1.4.13). */
export const PEER_LABELS_MUTED = "data-peer-labels-muted";

/** The `user` object a peer publishes through awareness. Everything is optional: it comes off the wire. */
interface PeerUser {
  name?: string;
  color?: string;
  [key: string]: unknown;
}

/** A peer without a usable colour gets a palette slot by client id, so unidentified peers still differ. */
export function peerColor(user: PeerUser, clientId: number): string {
  const published = typeof user.color === "string" ? user.color.toLowerCase() : "";
  if (HEX_COLOR.test(published) && published !== Y_TIPTAP_DEFAULT_COLOR) return published;
  const slot = Number.isFinite(clientId) ? Math.abs(Math.trunc(clientId)) : 0;
  return PEER_PALETTE[slot % PEER_PALETTE.length]!;
}

/** Coerced: a name off the wire may not be a string, and a peer that published one still named itself. */
export function peerName(user: PeerUser, clientId: number): string {
  const published = user.name == null ? "" : String(user.name);
  return published !== "" ? published : `User ${clientId}`;
}

/** The caret widget for one peer. Shape and classes are the contract with styles/editor.css. */
export function renderPeerCaret(user: PeerUser, clientId: number): HTMLElement {
  const caret = document.createElement("span");
  caret.classList.add("collaboration-carets__caret");
  caret.setAttribute("style", `--peer-color: ${peerColor(user, clientId)}`);
  caret.setAttribute("data-peer-caret", String(clientId));
  // PresenceStack announces who is present; a name inside a sentence derails a screen reader.
  caret.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.classList.add("collaboration-carets__label");
  // `name` is peer-supplied. The stylesheet shows it as generated content, which selections,
  // copies and double-click word boundaries skip.
  label.setAttribute("data-name", peerName(user, clientId));

  // A word joiner gives the zero-width caret an inline box without a line break opportunity. It is
  // the widget's only text, and must be real text: see styles/editor.css.
  const joiner = document.createElement("span");
  joiner.classList.add("collaboration-carets__joiner");
  joiner.textContent = "\u2060";

  caret.append(label, joiner);
  return caret;
}

/** Attributes for a peer's selection range. The tint itself (and its per-theme alpha) lives in CSS. */
export function peerSelectionAttrs(user: PeerUser, clientId: number): DecorationAttrs {
  return {
    class: "collaboration-carets__selection",
    style: `--peer-color: ${peerColor(user, clientId)}`,
  };
}

/** Advances on each transaction in which y-tiptap rebuilt the caret decorations. */
export const peerLabelActivityKey = new PluginKey<number>("peerLabelActivity");

/**
 * Shows a peer's name tag for `lingerMs` after they arrive or start a burst.
 * y-tiptap redraws carets a macrotask after the awareness change, so changed
 * clients are queued and drained in the plugin view's update() once this
 * plugin's counter moves, when the new carets are in the DOM. It listens to
 * `change`, so a keepalive re-broadcast flashes nothing.
 */
function peerLabelActivityPlugin(awareness: Awareness, lingerMs: number = PEER_LABEL_LINGER_MS): Plugin<number> {
  return new Plugin<number>({
    key: peerLabelActivityKey,
    state: {
      init: () => 0,
      apply: (tr, count) => (tr.getMeta(yCursorPluginKey)?.awarenessUpdated ? count + 1 : count),
    },
    view: (view) => {
      /** Clients that changed since the last redraw, waiting for their caret to exist. */
      const pending = new Set<number>();
      const timers = new Map<number, ReturnType<typeof setTimeout>>();
      /** When each peer last changed, for the burst boundary. */
      const lastChangeAt = new Map<number, number>();
      /** Marked widget nodes; a rebuilt one reads as an arrival. */
      const marked = new WeakSet<HTMLElement>();

      // Escape mutes the tags until the pointer next moves over the editor.
      const unmute = () => view.dom.removeAttribute(PEER_LABELS_MUTED);
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        view.dom.setAttribute(PEER_LABELS_MUTED, "");
        view.dom.addEventListener("pointermove", unmute, { once: true });
      };
      // On the document, since focus may be elsewhere while the pointer is over a caret; the event is not consumed.
      document.addEventListener("keydown", onKeyDown);

      // Never cached: a widget rebuilt across blocks would leave a held node detached.
      const caretFor = (id: number) => view.dom.querySelector<HTMLElement>(`[data-peer-caret="${id}"]`);

      const cancel = (id: number) => {
        const timer = timers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(id);
      };

      // `render` baked in the name and colour when the widget was built; `updateUser` changes them.
      const refreshIdentity = (caret: HTMLElement, id: number) => {
        const user = (awareness.getStates().get(id)?.user ?? {}) as PeerUser;
        caret.style.setProperty("--peer-color", peerColor(user, id));
        const label = caret.querySelector<HTMLElement>(".collaboration-carets__label");
        const name = peerName(user, id);
        if (label && label.getAttribute("data-name") !== name) label.setAttribute("data-name", name);
      };

      const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        for (const id of removed) {
          pending.delete(id);
          lastChangeAt.delete(id);
          cancel(id);
        }
        // Our own caret has no widget.
        for (const id of added) if (id !== awareness.clientID) pending.add(id);
        for (const id of updated) if (id !== awareness.clientID) pending.add(id);
      };
      awareness.on("change", onChange);

      return {
        update(updatedView, prevState) {
          if (peerLabelActivityKey.getState(updatedView.state) === peerLabelActivityKey.getState(prevState)) return;
          const now = Date.now();
          // Zero width means no layout to read (jsdom, a detached view).
          const hostRight = view.dom.clientWidth > 0 ? view.dom.getBoundingClientRect().right : null;

          for (const id of pending) {
            const caret = caretFor(id);
            // Missing while a local structural edit outruns the Yjs mapping; the next publish restores it.
            if (!caret) continue;
            refreshIdentity(caret, id);

            // Past the text column the tag would widen the scroll area.
            if (hostRight !== null) {
              caret.toggleAttribute("data-flip", hostRight - caret.getBoundingClientRect().left < LABEL_FLIP_PX);
            }

            // A new node: the peer joined, or moved far enough for ProseMirror to rebuild the widget.
            const arrived = !marked.has(caret);
            marked.add(caret);
            const previous = lastChangeAt.get(id);
            lastChangeAt.set(id, now);
            // Mid-burst: re-arming would hold the tag up while they type.
            if (!arrived && previous !== undefined && now - previous < PEER_ACTIVITY_GAP_MS) continue;

            caret.setAttribute("data-active", "");
            cancel(id);
            timers.set(
              id,
              setTimeout(() => {
                timers.delete(id);
                caretFor(id)?.removeAttribute("data-active");
              }, lingerMs),
            );
          }
          pending.clear();
        },
        destroy() {
          document.removeEventListener("keydown", onKeyDown);
          view.dom.removeEventListener("pointermove", unmute);
          view.dom.removeAttribute(PEER_LABELS_MUTED);
          awareness.off("change", onChange);
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
          pending.clear();
          lastChangeAt.clear();
        },
      };
    },
  });
}

/** Word boundaries for a double-click on a peer's caret. Missing in Firefox before 125. */
const WORDS = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** What a leaf counts as in a block's text, unless it is a line break. */
const LEAF = "\ufffc";

interface Segment {
  from: number;
  to: number;
  /** A leaf other than a line break is in or next to it: the browser's word takes in what it renders. */
  leaf: boolean;
}

/** The word, or the space, that `pos` starts or falls inside, as the browser picks one with no caret there. */
function segmentAt(doc: ProseMirrorNode, pos: number): Segment | null {
  if (!WORDS) return null;
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if (!block.inlineContent) return null;
  // One character per position, so segment offsets are position offsets.
  const text = block.textBetween(0, block.content.size, undefined, (leaf) =>
    leaf.type.spec.linebreakReplacement ? "\n" : LEAF,
  );
  if (text.length !== block.content.size) return null;
  const segment = WORDS.segment(text).containing(pos - $pos.start());
  if (!segment) return null;
  const end = segment.index + segment.segment.length;
  return {
    from: $pos.start() + segment.index,
    to: $pos.start() + end,
    leaf: segment.segment.includes(LEAF) || text[segment.index - 1] === LEAF || text[end] === LEAF,
  };
}

/** Whether a peer's caret sits at `pos`. Carets carry a key; a peer's selection tint does not. */
function caretAt(state: EditorState, pos: number): boolean {
  const decorations: DecorationSet | undefined = yCursorPluginKey.getState(state);
  return !!decorations?.find(pos, pos, (spec: { key?: unknown }) => typeof spec.key === "string").length;
}

/** Where a drag forward by words ends for a pointer at `pos`, `top` px down, as the browser's does. */
function dragEnd(view: EditorView, pos: number, top: number): number {
  const { doc } = view.state;
  const segment = segmentAt(doc, pos);
  // Past a soft-wrapped line's end it stops there, short of the next line's first word.
  if (segment) return segment.from === pos && top < view.coordsAtPos(pos, 1).top ? pos : segment.to;
  // Past a block's last word it takes in the break to the next line of text.
  const $pos = doc.resolve(pos);
  if (!$pos.parent.inlineContent || pos !== $pos.end()) return pos;
  return Selection.findFrom(doc.resolve($pos.after()), 1, true)?.from ?? pos;
}

/** The word a double-click at a peer's caret selected, mapped through edits while the drag after it lasts. */
const caretWordKey = new PluginKey<Segment | null>("peerCaretWord");

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * ProseMirror makes every widget `contenteditable="false"`, and Chromium mishandles a caret's island:
 * a click on its flag or tag goes to the document's start, and a double-click that resolves just before
 * it ends the word there. Both are taken over, the double-click with its word-by-word drag. The position
 * is re-read from the pointerdown, whose coordinates are fractional like Chromium's hit test.
 */
function peerCaretPointerPlugin(): Plugin<Segment | null> {
  /** The last pointerdown's coordinates. */
  let pointer: { x: number; y: number } | null = null;
  let endDrag: ((clear: boolean) => void) | null = null;

  const startDrag = (view: EditorView) => {
    endDrag?.(false);
    const move = (event: MouseEvent) => {
      const word = caretWordKey.getState(view.state);
      if (!(event.buttons & 1) || !word) return endDrag?.(true);
      // Past the text column, or above or below the editor, the drag holds at the edge.
      const box = view.dom.getBoundingClientRect();
      const top = clamp(event.clientY, box.top + 1, box.bottom - 1);
      const hit = view.posAtCoords({ left: clamp(event.clientX, box.left + 1, box.right - 1), top });
      if (!hit) return;
      const { doc } = view.state;
      let [anchor, head] = [word.from, word.to];
      if (hit.pos < word.from) [anchor, head] = [word.to, segmentAt(doc, hit.pos)?.from ?? hit.pos];
      else if (hit.pos > word.to) head = dragEnd(view, hit.pos, top);
      const selection = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
      if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection).setMeta("pointer", true));
    };
    const up = () => endDrag?.(true);
    const root = view.root as Document;
    root.addEventListener("mousemove", move);
    root.addEventListener("mouseup", up);
    endDrag = (clear) => {
      root.removeEventListener("mousemove", move);
      root.removeEventListener("mouseup", up);
      endDrag = null;
      if (clear && caretWordKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(caretWordKey, null));
    };
  };

  /** Selects the word at a caret at `pos`; false where the browser's own word is right. */
  const selectWord = (view: EditorView, pos: number): boolean => {
    const word = segmentAt(view.state.doc, pos);
    if (!word || word.leaf) return false;
    const selection = TextSelection.create(view.state.doc, word.from, word.to);
    view.dispatch(view.state.tr.setSelection(selection).setMeta("pointer", true).setMeta(caretWordKey, word));
    startDrag(view);
    return true;
  };

  return new Plugin<Segment | null>({
    key: caretWordKey,
    state: {
      init: () => null,
      apply(tr, word) {
        const set: Segment | null | undefined = tr.getMeta(caretWordKey);
        if (set !== undefined) return set;
        if (!word || !tr.docChanged) return word;
        const from = tr.mapping.map(word.from, 1);
        return { ...word, from, to: Math.max(from, tr.mapping.map(word.to, -1)) };
      },
    },
    view: () => ({ destroy: () => endDrag?.(false) }),
    props: {
      handleDOMEvents: {
        pointerdown(_view, event) {
          pointer = { x: event.clientX, y: event.clientY };
          return false;
        },
        // The flag and a hovered tag are the only parts that take the pointer.
        mousedown(view, event) {
          const target = event.button === 0 ? (event.target as Partial<Element> | null) : null;
          const caret = target?.closest?.(".collaboration-carets__caret");
          if (!caret) return false;
          event.preventDefault();
          view.focus();
          const pos = view.posAtDOM(caret, 0);
          // Clicks there act as they would on the text at the caret.
          if (event.detail === 2 && selectWord(view, pos)) return true;
          const { doc, selection } = view.state;
          const $pos = doc.resolve(pos);
          const next =
            event.detail > 2
              ? TextSelection.create(doc, $pos.start(), $pos.end())
              : event.shiftKey
                ? TextSelection.between(selection.$anchor, $pos)
                : TextSelection.create(doc, pos);
          view.dispatch(view.state.tr.setSelection(next).setMeta("pointer", true));
          return true;
        },
      },
      handleDoubleClick(view, pos, event) {
        const at =
          pointer && Math.abs(pointer.x - event.clientX) < 1 && Math.abs(pointer.y - event.clientY) < 1
            ? (view.posAtCoords({ left: pointer.x, top: pointer.y })?.pos ?? pos)
            : pos;
        return caretAt(view.state, at) && selectWord(view, at);
      },
    },
  });
}

/** Same options as CollaborationCaret, but with the `clientId` y-tiptap actually passes as a second argument. */
interface PeerCaretsOptions extends Omit<CollaborationCaretOptions, "render" | "selectionRender"> {
  render(user: PeerUser, clientId: number): HTMLElement;
  selectionRender(user: PeerUser, clientId: number): DecorationAttrs;
}

/** CollaborationCaret with Stuga's carets, keeping its name so `updateUser` and its storage still work. */
export const PeerCarets = CollaborationCaret.extend<PeerCaretsOptions>({
  addOptions() {
    return { ...this.parent!(), render: renderPeerCaret, selectionRender: peerSelectionAttrs };
  },
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? [];
    const awareness = (this.options.provider as { awareness?: Awareness } | null)?.awareness;
    // getSchema() builds extensions without awareness.
    if (!awareness || typeof awareness.on !== "function") return plugins;
    const { render, selectionRender } = this.options;
    return [
      // The parent's wrapped builders drop the clientId y-tiptap passes, so the cursor plugin is rebuilt; peerColor() still sanitizes.
      ...plugins.map((plugin) =>
        plugin.spec.key === yCursorPluginKey
          ? yCursorPlugin(awareness, { cursorBuilder: render, selectionBuilder: selectionRender })
          : plugin,
      ),
      peerLabelActivityPlugin(awareness),
      peerCaretPointerPlugin(),
    ];
  },
});
