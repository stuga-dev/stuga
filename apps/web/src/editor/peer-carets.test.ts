// @vitest-environment jsdom
/**
 * Collaborator carets as markup. The live-editor cases run the app's own
 * extensions against a second Awareness publishing real relative positions.
 * y-tiptap redraws carets a macrotask after an awareness change, hence
 * `vi.advanceTimersByTime(0)` after each publish, with fake timers installed
 * before the editor is built.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";
import { captureRelRange } from "./rel-range";
import { stugaEditorExtensions } from "./extensions";
import { PEER_PALETTE, colorFor } from "../state/identity";
import {
  PEER_ACTIVITY_GAP_MS,
  PEER_LABEL_LINGER_MS,
  PEER_LABELS_MUTED,
  PeerCarets,
  peerColor,
  peerLabelActivityKey,
  peerName,
  peerSelectionAttrs,
  renderPeerCaret,
} from "./peer-carets";

/** Where a client that published nothing usable lands in the palette. */
const paletteFor = (clientId: number) => PEER_PALETTE[clientId % PEER_PALETTE.length]!;

/** What y-tiptap substitutes for a peer with no colour. */
const Y_TIPTAP_ORANGE = "#ffa500";

/** The name a caret's tag shows, which the stylesheet renders from `data-name`. */
const nameOn = (caret: Element) => caret.querySelector(".collaboration-carets__label")!.getAttribute("data-name");

describe("renderPeerCaret", () => {
  it("builds an inline span caret carrying the peer's hue as a custom property", () => {
    const caret = renderPeerCaret({ name: "Liv", color: "#2563eb" }, 42);

    expect(caret.tagName).toBe("SPAN");
    expect(caret.classList.contains("collaboration-carets__caret")).toBe(true);
    expect(caret.style.getPropertyValue("--peer-color")).toBe("#2563eb");
    expect(caret.getAttribute("data-peer-caret")).toBe("42");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the name in an inline span, not a block that would span the column", () => {
    const caret = renderPeerCaret({ name: "Liv", color: "#2563eb" }, 42);
    const label = caret.querySelector(".collaboration-carets__label");

    expect(label).not.toBeNull();
    expect(label!.tagName).toBe("SPAN");
    expect(nameOn(caret)).toBe("Liv");
    expect(caret.querySelector("div")).toBeNull();
  });

  it("bakes no border-color or background-color into the markup", () => {
    // Colours come from --peer-color in styles/editor.css, so they can vary by theme.
    const caret = renderPeerCaret({ name: "Liv", color: "#2563eb" }, 42);
    const label = caret.querySelector<HTMLElement>(".collaboration-carets__label")!;

    expect(caret.style.borderColor).toBe("");
    expect(caret.style.backgroundColor).toBe("");
    expect(label.getAttribute("style")).toBeNull();
  });

  it("holds a word joiner as its only text, in a span of its own, and the name as an attribute", () => {
    // With no text node in the caret, Chromium's ArrowUp skips a line where it starts a soft-wrapped one.
    const caret = renderPeerCaret({ name: "Ada Lovelace", color: "#2563eb" }, 42);
    const label = caret.querySelector(".collaboration-carets__label");
    const joiner = caret.querySelector(".collaboration-carets__joiner");

    expect(caret.textContent).toBe("\u2060");
    expect(joiner!.tagName).toBe("SPAN");
    expect([...joiner!.childNodes].map((node) => node.nodeType)).toEqual([Node.TEXT_NODE]);
    expect([...caret.childNodes]).toEqual([label, joiner]);
    expect(nameOn(caret)).toBe("Ada Lovelace");
    // Selectability and layout are the stylesheet's.
    expect(caret.getAttribute("style")).toBe("--peer-color: #2563eb");
  });

  it("keeps a peer-supplied name an attribute value, so markup in it cannot become markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const caret = renderPeerCaret({ name: hostile, color: "#2563eb" }, 9);

    expect(caret.querySelector("img")).toBeNull();
    expect(caret.children).toHaveLength(2);
    expect(nameOn(caret)).toBe(hostile);
    expect(caret.querySelector(".collaboration-carets__label")!.childNodes).toHaveLength(0);
  });

  it("names a peer that published no usable name after their client id", () => {
    expect(nameOn(renderPeerCaret({ color: "#2563eb" }, 42))).toBe("User 42");
    expect(nameOn(renderPeerCaret({ name: "", color: "#2563eb" }, 7))).toBe("User 7");
  });

  it("falls back to a legible hue for a colour y-tiptap would reject", () => {
    // y-tiptap warns on `hsl(...)` and builds an invalid selection tint from it.
    expect(renderPeerCaret({ name: "Liv", color: "hsl(300,70%,55%)" }, 1).style.getPropertyValue("--peer-color")).toBe(
      paletteFor(1),
    );
    expect(renderPeerCaret({ name: "Liv" }, 1).style.getPropertyValue("--peer-color")).toBe(paletteFor(1));
  });
});

describe("peerName", () => {
  it("coerces whatever the peer published rather than rejecting it", () => {
    expect(peerName({ name: 42 as never }, 7)).toBe("42");
    expect(peerName({ name: "Ada" }, 7)).toBe("Ada");
  });

  it("names a peer with nothing to show after their client id", () => {
    expect(peerName({}, 7)).toBe("User 7");
    expect(peerName({ name: "" }, 7)).toBe("User 7");
    expect(peerName({ name: null as never }, 7)).toBe("User 7");
  });
});

describe("peerColor", () => {
  it("accepts exactly the 6-digit hex y-tiptap accepts", () => {
    expect(peerColor({ color: "#2563eb" }, 1)).toBe("#2563eb");
    expect(peerColor({ color: "#ABCDEF" }, 1)).toBe("#abcdef");
  });

  it("folds anything else onto the palette, per client", () => {
    for (const bad of ["hsl(300,70%,55%)", "rgb(1,2,3)", "#abc", "#2563eb70", "blue", "", 16777215, null, undefined]) {
      expect(peerColor({ color: bad as never }, 3), `for ${String(bad)}`).toBe(paletteFor(3));
    }
    expect(peerColor({}, 3)).not.toBe(peerColor({}, 4));
  });

  it("treats y-tiptap's substitute orange as no colour", () => {
    expect(peerColor({ color: Y_TIPTAP_ORANGE }, 3)).toBe(paletteFor(3));
  });

  it("survives a client id that is not a usable number", () => {
    expect(peerColor({}, Number.NaN)).toBe(PEER_PALETTE[0]);
    expect(peerColor({}, -7)).toBe(paletteFor(7));
  });
});

describe("peerSelectionAttrs", () => {
  it("tints a peer's range through --peer-color, not a hex alpha suffix", () => {
    const attrs = peerSelectionAttrs({ name: "Liv", color: "#2563eb" }, 1);

    expect(attrs.class).toBe("collaboration-carets__selection");
    expect(attrs.style).toContain("--peer-color: #2563eb");
    expect(attrs.style).not.toContain("background-color");
    expect(attrs.style).not.toMatch(/#[0-9a-f]{6}70/i);
  });

  it("falls back with the caret, so an unusable colour still paints a selection", () => {
    expect(peerSelectionAttrs({ color: "hsl(300,70%,55%)" }, 3).style).toBe(`--peer-color: ${paletteFor(3)}`);
  });
});

describe("the PeerCarets extension", () => {
  it("is still called collaborationCaret", () => {
    // `updateUser`, the extension's storage and its module augmentation are keyed by the name.
    expect(PeerCarets.name).toBe("collaborationCaret");
    expect(PeerCarets.configure({ provider: { awareness: {} } as never }).name).toBe("collaborationCaret");
  });

  it("defaults render and selectionRender to ours while keeping what the app configures", () => {
    const provider = { awareness: {} } as never;
    const user = { name: "liv", label: "Liv Smith", color: "#2563eb" };

    const options = PeerCarets.configure({ provider, user }).options;

    expect(options.render).toBe(renderPeerCaret);
    expect(options.selectionRender).toBe(peerSelectionAttrs);
    expect(options.provider).toBe(provider);
    // Extra fields on `user` travel through awareness; PresenceStack reads `label`.
    expect(options.user).toEqual(user);
  });
});

describe("a collaborator's caret in a live editor", () => {
  let ydoc: Y.Doc;
  let awareness: Awareness;
  let element: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    // Before the editor is built, which captures the timer implementation.
    vi.useFakeTimers();
    ydoc = new Y.Doc();
    awareness = new Awareness(ydoc);
    element = document.createElement("div");
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions: stugaEditorExtensions({ ydoc, awareness, alias: "me", onClickComment: () => {} }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "The quick brown fox jumps." }] },
        { type: "paragraph", content: [{ type: "text", text: "The lazy dog sleeps on." }] },
      ],
    });
  });

  afterEach(() => {
    // y-tiptap batches every editor's redraws behind one module-level timeout; one left pending,
    // as a focus that publishes our own cursor leaves it, would stall the next test's carets.
    vi.advanceTimersByTime(0);
    editor.destroy();
    awareness.destroy();
    element.remove();
    vi.useRealTimers();
  });

  /** Absolute position of a phrase in the live doc. */
  function posOf(phrase: string): number {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText) {
        const at = node.text!.indexOf(phrase);
        if (at >= 0) found = pos + at;
      }
    });
    expect(found, `"${phrase}" is in the fixture`).toBeGreaterThanOrEqual(0);
    return found;
  }

  /** A remote collaborator whose cursor is captured, encoded and applied as a real one is. */
  function connectPeer(name = "Liv", color: string | null = colorFor(name)) {
    const peer = new Awareness(new Y.Doc());
    let user: Record<string, unknown> = color === null ? { name } : { name, color };
    let cursor: unknown = null;

    /** Publish, and let the batched redraw land. */
    const publish = () => {
      peer.setLocalState({ user, cursor });
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "remote");
      vi.advanceTimersByTime(0);
    };

    return {
      clientID: peer.clientID,
      moveTo(from: number, to: number = from) {
        const rel = captureRelRange(editor.state, from, to);
        expect(rel, "the y-binding must be live or this is not a real cursor").not.toBeNull();
        cursor = { anchor: rel!.from, head: rel!.to };
        publish();
      },
      /** Rename or recolour in place, as `updateUser` does. */
      identifyAs(next: { name?: string; color?: string }) {
        user = { ...user, ...next };
        publish();
      },
    };
  }

  const caretFor = (id: number) => editor.view.dom.querySelector<HTMLElement>(`[data-peer-caret="${id}"]`);
  const isLit = (id: number) => caretFor(id)?.hasAttribute("data-active") ?? false;
  const litCarets = () => editor.view.dom.querySelectorAll("[data-peer-caret][data-active]").length;

  describe("markup", () => {
    it("paints a thin caret and an inline name tag, not a block across the paragraph", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"), posOf("brown") + "brown fox".length);

      const caret = caretFor(peer.clientID);
      expect(caret, "the peer published a cursor, so there is a caret").not.toBeNull();
      expect(caret!.tagName).toBe("SPAN");
      expect(caret!.style.getPropertyValue("--peer-color")).toBe(colorFor("Liv"));

      const label = caret!.querySelector(".collaboration-carets__label");
      expect(label!.tagName).toBe("SPAN");
      expect(nameOn(caret!)).toBe("Liv");
      expect(editor.view.dom.querySelector("div.collaboration-carets__label")).toBeNull();
    });

    it("paints the peer's selected range through --peer-color", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"), posOf("brown") + "brown fox".length);

      const selection = editor.view.dom.querySelector<HTMLElement>(".collaboration-carets__selection");
      expect(selection, "a peer with a non-empty range gets an inline decoration").not.toBeNull();
      expect(selection!.getAttribute("style")).toContain(`--peer-color: ${colorFor("Liv")}`);
      expect(selection!.style.getPropertyValue("--peer-color")).toBe(colorFor("Liv"));
      // On the computed value: a browser normalises a hex alpha suffix to rgba().
      expect(selection!.style.backgroundColor).toBe("");
    });

    it("leaves no inline border-color anywhere in the editor", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"), posOf("brown") + 5);

      const bordered = [...editor.view.dom.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.style.borderColor !== "" || el.style.borderLeftColor !== "")
        .map((el) => el.outerHTML);
      expect(bordered).toEqual([]);
    });

    it("never makes y-tiptap complain about the colour format", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      connectPeer().moveTo(posOf("fox"));

      expect(warn.mock.calls.flat().join(" ")).not.toContain("unsupported color format");
      warn.mockRestore();
    });

    it("publishes a colour y-tiptap can use for the local user", () => {
      // y-tiptap validates only remote users, so the configured local colour is checked here.
      const mounted = stugaEditorExtensions({
        ydoc: new Y.Doc(),
        awareness: {},
        alias: "liv",
        onClickComment: () => {},
      }).find((extension) => extension.name === "collaborationCaret");

      const published = (mounted!.options as { user: { color: string } }).user;
      expect(published.color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("gives a peer who published no colour a palette hue, not y-tiptap's orange", () => {
      const peer = connectPeer("Ada", null);
      peer.moveTo(posOf("fox"));

      const painted = caretFor(peer.clientID)!.style.getPropertyValue("--peer-color");
      expect(painted).toBe(paletteFor(peer.clientID));
      expect(painted).not.toBe(Y_TIPTAP_ORANGE);
    });

    it("picks up a rename without waiting for the peer to change block", () => {
      const peer = connectPeer("Liv", "#2563eb");
      peer.moveTo(posOf("brown"));
      const node = caretFor(peer.clientID);

      peer.identifyAs({ name: "Livia", color: "#15803d" });

      expect(caretFor(peer.clientID), "same node — render did not re-run").toBe(node);
      expect(node!.style.getPropertyValue("--peer-color")).toBe("#15803d");
      expect(nameOn(node!)).toBe("Livia");
    });

    it("still paints a caret for a peer whose colour it cannot use", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const peer = connectPeer("Ada", "hsl(300,70%,55%)");
      peer.moveTo(posOf("quick"), posOf("quick") + 5);

      expect(caretFor(peer.clientID)!.style.getPropertyValue("--peer-color")).toBe(paletteFor(peer.clientID));
      const selection = editor.view.dom.querySelector<HTMLElement>(".collaboration-carets__selection");
      expect(selection!.style.getPropertyValue("--peer-color")).toBe(paletteFor(peer.clientID));
      warn.mockRestore();
    });

    it("keeps the collaborationCaret identity the rest of the app reads", () => {
      const peer = connectPeer("Ada");
      peer.moveTo(posOf("fox"));

      expect(typeof editor.commands.updateUser).toBe("function");
      const users = editor.storage.collaborationCaret.users as { clientId: number; name?: string }[];
      expect(users.map((u) => u.clientId)).toContain(peer.clientID);
    });
  });

  describe("the name tag flash", () => {
    it("lights a peer's name tag when they arrive and drops it after the linger", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"));
      expect(isLit(peer.clientID)).toBe(true);

      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS - 1);
      expect(isLit(peer.clientID)).toBe(true);

      vi.advanceTimersByTime(1);
      expect(isLit(peer.clientID)).toBe(false);
      expect(caretFor(peer.clientID)).not.toBeNull();
    });

    it("shows the tag once per burst, so a peer who keeps typing cannot pin it up", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("quick"));
      expect(isLit(peer.clientID)).toBe(true);

      // Positions must differ, or awareness reports no change.
      for (let elapsed = 100; elapsed <= PEER_LABEL_LINGER_MS + 400; elapsed += 100) {
        vi.advanceTimersByTime(100);
        peer.moveTo(posOf("quick") + (elapsed / 100) % 5);
      }

      expect(isLit(peer.clientID), "the tag retired on schedule despite the typing").toBe(false);
    });

    it("re-arms once the peer has gone quiet and come back", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("quick"));
      vi.advanceTimersByTime(PEER_ACTIVITY_GAP_MS);
      expect(isLit(peer.clientID)).toBe(false);

      // Same block, so the widget is reused and only the gap can re-arm it.
      peer.moveTo(posOf("jumps"));
      expect(isLit(peer.clientID)).toBe(true);
    });

    it("times each peer's tag from their own last move", () => {
      const ada = connectPeer("Ada", "#2563eb");
      const grace = connectPeer("Grace", "#15803d");

      ada.moveTo(posOf("quick"));
      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS - 10);
      grace.moveTo(posOf("dog"));

      expect(isLit(ada.clientID)).toBe(true);
      expect(isLit(grace.clientID)).toBe(true);

      vi.advanceTimersByTime(10);
      expect(isLit(ada.clientID)).toBe(false);
      expect(isLit(grace.clientID)).toBe(true);

      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS);
      expect(litCarets()).toBe(0);
    });

    it("follows a peer that jumps to another block, where the widget is rebuilt", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"));
      const first = caretFor(peer.clientID);
      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS);

      peer.moveTo(posOf("lazy"));

      const second = caretFor(peer.clientID);
      expect(second, "the peer still has exactly one caret").not.toBeNull();
      expect(second).not.toBe(first);
      expect(editor.view.dom.querySelectorAll(`[data-peer-caret="${peer.clientID}"]`)).toHaveLength(1);
      expect(second!.hasAttribute("data-active")).toBe(true);
      expect(litCarets()).toBe(1);
    });

    it("does not let a jump mid-flash strand a caret lit forever", () => {
      // A timer holding the first node would leave the caret on screen lit.
      const peer = connectPeer();
      peer.moveTo(posOf("brown"));
      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS - 1);

      peer.moveTo(posOf("lazy"));
      expect(isLit(peer.clientID)).toBe(true);

      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS);
      expect(isLit(peer.clientID)).toBe(false);
      expect(litCarets()).toBe(0);
    });

    it("survives a peer disconnecting while their tag is still up", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"));
      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS / 2);
      expect(isLit(peer.clientID)).toBe(true);

      removeAwarenessStates(awareness, [peer.clientID], "remote");
      vi.advanceTimersByTime(0);

      expect(caretFor(peer.clientID)).toBeNull();
      expect(() => vi.advanceTimersByTime(PEER_LABEL_LINGER_MS * 2)).not.toThrow();
    });

    it("never renders or flashes the local user's own cursor", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"));
      vi.advanceTimersByTime(PEER_LABEL_LINGER_MS);
      expect(isLit(peer.clientID)).toBe(false);

      const rel = captureRelRange(editor.state, posOf("dog"), posOf("dog"));
      awareness.setLocalStateField("cursor", { anchor: rel!.from, head: rel!.to });
      awareness.setLocalStateField("user", { name: "me", color: "#7c3aed" });
      editor.commands.insertContentAt(posOf("quick"), "very ");
      vi.advanceTimersByTime(0);

      expect(caretFor(awareness.clientID)).toBeNull();
      expect(litCarets()).toBe(0);
    });

    it("waits for y-tiptap's redraw rather than reacting to the awareness event", () => {
      const before = peerLabelActivityKey.getState(editor.state);
      editor.commands.insertContentAt(posOf("dog"), "big ");
      expect(peerLabelActivityKey.getState(editor.state)).toBe(before);

      connectPeer().moveTo(posOf("fox"));
      expect(peerLabelActivityKey.getState(editor.state)).toBe(before! + 1);
    });
  });

  describe("dismissing a hovered name tag (WCAG 1.4.13)", () => {
    const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const muted = () => editor.view.dom.hasAttribute(PEER_LABELS_MUTED);

    it("puts the tag away on Escape without the pointer moving", () => {
      connectPeer().moveTo(posOf("brown"));
      expect(muted()).toBe(false);

      escape();

      expect(muted()).toBe(true);
    });

    it("comes back on the next pointer move, so the affordance is not switched off", () => {
      escape();
      expect(muted()).toBe(true);

      editor.view.dom.dispatchEvent(new Event("pointermove"));

      expect(muted()).toBe(false);
      escape();
      expect(muted()).toBe(true);
      editor.view.dom.dispatchEvent(new Event("pointermove"));
      expect(muted()).toBe(false);
    });

    it("never consumes the Escape, which also closes menus and popovers", () => {
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("ignores every other key", () => {
      for (const key of ["a", "Enter", "Tab", "ArrowLeft"]) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key }));
        expect(muted(), `for ${key}`).toBe(false);
      }
    });

    it("stops listening on the document once the editor is destroyed", () => {
      // Or a second editor on the page would be muted by the first's listener.
      const dom = editor.view.dom;
      editor.destroy();
      escape();
      expect(dom.hasAttribute(PEER_LABELS_MUTED)).toBe(false);
    });
  });

  describe("a click on a peer's flag or name tag", () => {
    /** A left-button mousedown dispatched as the browser does, through ProseMirror's own listener. */
    const pressOn = (target: Element, init: MouseEventInit = {}) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
      target.dispatchEvent(event);
      return event;
    };
    /** The plugins' answer alone, where ProseMirror's own handler needs a layout jsdom lacks. */
    const takenOver = (target: Element, init: MouseEventInit = {}) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
      Object.defineProperty(event, "target", { value: target });
      return editor.view.someProp("handleDOMEvents", (handlers) => handlers.mousedown?.(editor.view, event)) ?? false;
    };
    const selected = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to);

    it("puts your cursor at their caret, not at the document's start", () => {
      // The flag is the caret's ::before, so the caret is the target; Chromium's own click goes to position 1.
      const peer = connectPeer();
      peer.moveTo(posOf("quick") + 2);
      editor.commands.setTextSelection(posOf("lazy"));

      const event = pressOn(caretFor(peer.clientID)!);

      expect(event.defaultPrevented).toBe(true);
      expect(editor.state.selection.empty).toBe(true);
      expect(editor.state.selection.from).toBe(posOf("quick") + 2);
    });

    it("does the same from a hovered name tag", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("brown"));

      const event = pressOn(caretFor(peer.clientID)!.querySelector(".collaboration-carets__label")!);

      expect(event.defaultPrevented).toBe(true);
      expect(editor.state.selection.from).toBe(posOf("brown"));
    });

    it("acts as clicks on the text there would: Shift extends, a double-click takes the word, a triple-click the block", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("quick") + 2);
      const caret = caretFor(peer.clientID)!;

      editor.commands.setTextSelection(posOf("lazy"));
      pressOn(caret, { shiftKey: true });
      expect([editor.state.selection.anchor, editor.state.selection.head]).toEqual([posOf("lazy"), posOf("quick") + 2]);

      pressOn(caret, { detail: 2 });
      expect(selected()).toBe("quick");

      pressOn(caret, { detail: 3 });
      expect(selected()).toBe("The quick brown fox jumps.");
    });

    it("leaves every other mousedown to ProseMirror", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("quick") + 2);

      expect(takenOver(editor.view.dom.querySelector("p")!)).toBe(false);
      expect(takenOver(caretFor(peer.clientID)!, { button: 2 })).toBe(false);
    });
  });

  describe("double-click on a peer's caret", () => {
    /** What ProseMirror asks its plugins on a double-click at `pos`: true means one took it over. */
    const doubleClick = (pos: number, init: MouseEventInit = {}) =>
      editor.view.someProp("handleDoubleClick", (handle) => handle(editor.view, pos, new MouseEvent("mousedown", { detail: 2, ...init }))) ??
      false;
    const selected = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
    /** A pointerdown at fractional coordinates, which the mousedown after it rounds down. */
    const pointerDown = (x: number, y: number) => {
      const event = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
      editor.view.dom.dispatchEvent(event);
    };

    it("selects the whole word when it lands on a caret mid-word", () => {
      // The browser's own word ends at the widget when the click resolves to the position before it.
      connectPeer().moveTo(posOf("quick") + 2);

      expect(doubleClick(posOf("quick") + 2)).toBe(true);
      expect(selected()).toBe("quick");
    });

    it("selects what continues from a caret at a word's edge, as with no caret", () => {
      // There the browser's own selection is empty.
      const peer = connectPeer();
      peer.moveTo(posOf("quick"));
      expect(doubleClick(posOf("quick"))).toBe(true);
      expect(selected()).toBe("quick");

      peer.moveTo(posOf(" brown"));
      expect(doubleClick(posOf(" brown"))).toBe(true);
      expect(selected()).toBe(" ");
    });

    it("leaves every other double-click to the browser", () => {
      const peer = connectPeer();
      peer.moveTo(posOf("quick") + 2);
      expect(doubleClick(posOf("quick")), "elsewhere in the same word").toBe(false);
      expect(doubleClick(posOf("quick") + 4), "elsewhere in the same word").toBe(false);
      expect(doubleClick(posOf("brown") + 2), "another word").toBe(false);

      peer.moveTo(posOf("jumps.") + "jumps.".length);
      expect(doubleClick(posOf("jumps.") + "jumps.".length), "a caret at the paragraph's end").toBe(false);
    });

    it("resolves the click where the pointer went down, a character past ProseMirror's whole-pixel pos", () => {
      // Chromium hits 190.6, past the middle of the "u" before the caret; the mousedown says 190, before it.
      const caret = posOf("quick") + 2;
      connectPeer().moveTo(caret);
      vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({ pos: left > 190.4 ? caret : caret - 1, inside: -1 }));

      pointerDown(190.6, 20);
      expect(doubleClick(caret - 1, { clientX: 190, clientY: 20 })).toBe(true);
      expect(selected()).toBe("quick");
    });

    it("and leaves a click that lands a character past the caret to the browser", () => {
      // ProseMirror's 217 says the caret; Chromium's 217.8 is past the middle of the space after it.
      const caret = posOf(" brown");
      connectPeer().moveTo(caret);
      vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({ pos: left > 217.5 ? caret + 1 : caret, inside: -1 }));

      pointerDown(217.8, 20);
      expect(doubleClick(caret, { clientX: 217, clientY: 20 })).toBe(false);
    });

    it("leaves a word next to a mention to the browser, whose word takes in the mention's text", () => {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ask " },
              { type: "mention", attrs: { alias: "amy", label: "amy" } },
              { type: "text", text: "'s notes" },
            ],
          },
        ],
      });
      const peer = connectPeer();
      peer.moveTo(posOf("'s notes"));

      expect(doubleClick(posOf("'s notes"))).toBe(false);
    });

    it("counts a hard break as the end of a line, not a leaf the browser's word takes in", () => {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "line one" }, { type: "hardBreak" }, { type: "text", text: "Wordy here" }],
          },
        ],
      });
      connectPeer().moveTo(posOf("Wordy") + 2);

      expect(doubleClick(posOf("Wordy") + 2)).toBe(true);
      expect(selected()).toBe("Wordy");
    });
  });

  describe("dragging after a double-click on a peer's caret", () => {
    const doubleClick = (pos: number) =>
      editor.view.someProp("handleDoubleClick", (handle) => handle(editor.view, pos, new MouseEvent("mousedown", { detail: 2 }))) ??
      false;
    const selected = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "|");
    /** The drag listens on the document; clientX is the position the pointer is over, clientY picks the line. */
    const dragTo = (pos: number, init: MouseEventInit = {}) =>
      document.dispatchEvent(new MouseEvent("mousemove", { buttons: 1, clientX: pos, clientY: 50, ...init }));

    beforeEach(() => {
      // jsdom has no layout: the editor spans the page, and every position is on one line.
      vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 10_000, 10_000));
      vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({ pos: left, inside: -1 }));
      vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 100 });
      connectPeer().moveTo(posOf("quick") + 2);
      expect(doubleClick(posOf("quick") + 2)).toBe(true);
    });

    it("extends by words either way from the word, as the browser's own drag does", () => {
      dragTo(posOf("brown") + 3);
      expect(selected()).toBe("quick brown");

      dragTo(posOf("The quick") + 1);
      expect(selected()).toBe("The quick");
      expect(editor.state.selection.anchor, "anchored at the word's far edge").toBe(posOf("quick") + 5);

      dragTo(posOf("quick") + 4);
      expect(selected()).toBe("quick");
    });

    it("takes in the break to the next block past a block's last word", () => {
      dragTo(posOf("jumps.") + "jumps.".length);

      expect(editor.state.selection.head).toBe(posOf("The lazy"));
    });

    it("stops at a soft-wrapped line's end, short of the next line's first word", () => {
      // The pointer is above the line "brown" starts.
      vi.mocked(editor.view.coordsAtPos).mockReturnValue({ left: 0, right: 0, top: 100, bottom: 120 });

      dragTo(posOf("brown"));

      expect(selected()).toBe("quick ");
    });

    it("keeps the word through an edit made during the drag", () => {
      editor.commands.insertContentAt(posOf("The quick"), "Oh, ");

      dragTo(posOf("brown") + 3);

      expect(selected()).toBe("quick brown");
    });

    it("ends when the button comes up", () => {
      document.dispatchEvent(new MouseEvent("mouseup"));
      dragTo(posOf("brown") + 3);
      expect(selected()).toBe("quick");
    });

    it("ends on a move with the button already up, as when it came up outside the window", () => {
      dragTo(posOf("brown") + 3, { buttons: 0 });
      dragTo(posOf("fox") + 1);
      expect(selected()).toBe("quick");
    });
  });

  describe("the stylesheet the markup is a contract with", () => {
    /** Tiptap ships no CSS for these classes and jsdom applies none, so the declarations are read from disk. */
    // vitest stubs CSS imports, and cwd is the package root.
    const css = readFileSync(resolve(process.cwd(), "src/styles/editor.css"), "utf8");
    const block = css.slice(css.indexOf("collaborator carets"), css.indexOf("in-editor comment highlight"));

    it("is present at all", () => {
      expect(block, "the caret rules were removed from styles/editor.css").not.toBe("");
    });

    it("draws the caret line, which no inline style provides", () => {
      expect(block).toMatch(/\.collaboration-carets__caret\s*\{[^}]*border-left:\s*2px solid/);
    });

    it("keeps the caret inline, since an inline-block would add a line break opportunity mid-word", () => {
      expect(block).toMatch(/\.collaboration-carets__caret\s*\{[^}]*display:\s*inline;/);
    });

    /** Rules on the caret element itself, not on its tag or a pseudo-element. */
    const caretRules = (css: string) =>
      // Innermost rules, comments dropped; `block` starts inside the section's heading comment.
      [...css.replace(/(?:\/\*|^)[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(([, selectors]) =>
        // A comma inside :not(…) or :is(…) does not end a selector.
        selectors!
          .split(/,(?![^(]*\))/)
          .some((s) => /\.collaboration-carets__caret(\[[^\]]*\]|:[a-z-]+(\([^)]*\))?)*$/.test(s.trim())),
      );

    it("leaves the caret itself selectable", () => {
      // With `user-select: none` on it, Chromium puts a click past the end of its line at the line's start.
      const onCaret = caretRules(block);

      expect(onCaret.length).toBeGreaterThan(0);
      for (const [, selectors, body] of onCaret) expect(body, selectors!.trim()).not.toMatch(/user-select:\s*none/);
    });

    it("counts a rule behind a functional pseudo-class as a rule on the caret", () => {
      expect(caretRules(".e .collaboration-carets__caret:not([data-active]) { user-select: none; }")).toHaveLength(1);
      expect(caretRules(".e .collaboration-carets__caret:is([data-a], [data-b]) { user-select: none; }")).toHaveLength(1);
      expect(caretRules(".e .collaboration-carets__caret::after, .e .collaboration-carets__label { content: none; }")).toEqual([]);
    });

    it("keeps the caret's word joiner real text, and out of every selection", () => {
      expect(block).toMatch(/\.collaboration-carets__joiner\s*\{[^}]*user-select:\s*none/);
      // As generated content it would leave the caret with no text node.
      expect(block).not.toMatch(/\.collaboration-carets__caret::after\s*\{[^}]*content:/);
    });

    it("shows the name the markup carries in data-name", () => {
      expect(block).toMatch(/\.collaboration-carets__label::after\s*\{[^}]*content:\s*attr\(data-name\)/);
    });

    it("keeps the name tag out of a selection's highlight", () => {
      const label = block.slice(block.indexOf(".collaboration-carets__label {"));
      expect(label.slice(0, label.indexOf("}"))).toMatch(/user-select:\s*none/);
    });

    it("keeps the name tag out of the prose, and out of the scroll width when idle", () => {
      const label = block.slice(block.indexOf(".collaboration-carets__label {"));
      expect(label).toMatch(/position:\s*absolute/);
      // `opacity: 0` alone still widens the scroll area near a line end.
      expect(label).toMatch(/display:\s*none/);
    });

    it("is what gives data-active its meaning", () => {
      expect(block).toMatch(/\[data-active\][^{]*\.collaboration-carets__label[^{]*\{[^}]*display:\s*inline-block/);
    });

    it("lets the pointer travel onto a hover-revealed tag", () => {
      expect(block).toMatch(/:hover \.collaboration-carets__label\s*\{[^}]*pointer-events:\s*auto/);
    });

    it("hides a hovered tag while Escape has muted it", () => {
      expect(block).toMatch(/\[data-peer-labels-muted\][^{]*:hover[^{]*\{[^}]*display:\s*none/);
      // A tag up because its peer is active was not summoned by hover.
      expect(block).toMatch(/\[data-peer-labels-muted\][^{]*:not\(\[data-active\]\)/);
    });

    it("tints a peer's selection, which is the decoration's only appearance", () => {
      expect(block).toMatch(/\.collaboration-carets__selection\s*\{[^}]*background-color:/);
    });
  });

  describe("teardown", () => {
    /** The editor's change listeners on our awareness. */
    const changeListeners = () =>
      (awareness as unknown as { _observers: Map<string, Set<unknown>> })._observers.get("change")?.size ?? 0;

    it("stops listening and cancels its timers when the editor is destroyed", () => {
      // A leaked timer would not throw on a detached DOM, so the flash's own handle must be seen cleared.
      const armed = vi.spyOn(globalThis, "setTimeout");
      const cleared = vi.spyOn(globalThis, "clearTimeout");

      const peer = connectPeer();
      peer.moveTo(posOf("brown"));
      expect(isLit(peer.clientID), "a flash is in flight").toBe(true);
      expect(changeListeners()).toBeGreaterThan(0);

      const flash = armed.mock.calls.findIndex(([, ms]) => ms === PEER_LABEL_LINGER_MS);
      expect(flash, "the flash armed a timer for the linger").toBeGreaterThanOrEqual(0);
      const handle = armed.mock.results[flash]!.value;

      editor.destroy();

      expect(changeListeners()).toBe(0);
      expect(cleared).toHaveBeenCalledWith(handle);
      armed.mockRestore();
      cleared.mockRestore();

      expect(() => {
        removeAwarenessStates(awareness, [peer.clientID], "remote");
        vi.advanceTimersByTime(PEER_LABEL_LINGER_MS * 2);
      }).not.toThrow();
    });
  });
});
