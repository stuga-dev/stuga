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
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { DecorationAttrs } from "@tiptap/pm/view";
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
  // `name` is peer-supplied.
  label.textContent = peerName(user, clientId);

  // Word joiners give the zero-width caret an inline box without adding a line break opportunity.
  caret.append("\u2060", label, "\u2060");
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
        if (label && label.textContent !== name) label.textContent = name;
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
    ];
  },
});
