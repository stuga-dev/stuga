// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";
import { captureRelRange } from "../editor/rel-range";

const toasts = vi.hoisted(() => ({ shown: [] as string[] }));
const shared = vi.hoisted(() => ({ editor: null as unknown }));

vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string }) => toasts.shown.push(t.body),
}));
// The tooltip needs a Layer host and no assertion is about it.
vi.mock("@astryxdesign/core/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../editor/editor-context", () => ({
  useSharedEditor: () => ({ editor: shared.editor, setEditor: () => {} }),
}));

const { stugaEditorExtensions } = await import("../editor/extensions");
const { PresenceStack, __TIMINGS } = await import("./PresenceStack");
import type { StugaProvider } from "../sync/stuga-provider";

let ydoc: Y.Doc;
let awareness: Awareness;
let editor: Editor;
let container: HTMLElement;
let scroller: HTMLElement;
let root: Root;
/** jsdom implements no scrollIntoView; this both supplies one and records its use. */
let scrolledIntoView: unknown[];
Element.prototype.scrollIntoView = function scrollIntoViewStub(this: Element, arg?: unknown) {
  scrolledIntoView.push(arg);
};

/** PresenceStack reads only these two fields off the provider. */
const providerStub = () => ({ awareness, doc: ydoc }) as unknown as StugaProvider;

beforeEach(() => {
  vi.useFakeTimers();
  toasts.shown = [];
  scrolledIntoView = [];
  ydoc = new Y.Doc();
  awareness = new Awareness(ydoc);
  // jumpTo scrolls the `.doc-main` the editor lives in.
  scroller = document.createElement("div");
  scroller.className = "doc-main";
  document.body.appendChild(scroller);
  const host = document.createElement("div");
  scroller.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: stugaEditorExtensions({ ydoc, awareness, alias: "me", onClickComment: () => {} }),
  });
  editor.commands.setContent({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "The quick brown fox jumps." }] },
      { type: "paragraph", content: [{ type: "text", text: "The lazy dog sleeps on." }] },
    ],
  });
  shared.editor = editor;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  editor.destroy();
  awareness.destroy();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const render = () => act(() => root.render(<PresenceStack provider={providerStub()} />));
/** Render and let the "already here" grace window lapse, so later changes announce. */
const renderAndSettle = () => {
  render();
  act(() => void vi.advanceTimersByTime(__TIMINGS.ANNOUNCE_AFTER_MS));
};

/** Absolute position of a phrase in the live doc. */
function posOf(phrase: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText) {
      const at = node.text!.indexOf(phrase);
      if (at >= 0) found = pos + at;
    }
  });
  return found;
}

/** A remote collaborator, optionally with a caret somewhere in the document. */
function connect(label: string, opts: { at?: string; selecting?: [string, string]; name?: string } = {}) {
  const peer = new Awareness(new Y.Doc());
  const user = { name: opts.name ?? label.split("@")[0], label, color: "#2563eb" };
  let cursor: unknown = null;
  if (opts.selecting) {
    // A real selection: anchor where they started, head where their caret is.
    const [from, to] = opts.selecting;
    const rel = captureRelRange(editor.state, posOf(from), posOf(to) + to.length);
    cursor = { anchor: rel!.from, head: rel!.to };
  } else if (opts.at) {
    const rel = captureRelRange(editor.state, posOf(opts.at), posOf(opts.at));
    cursor = { anchor: rel!.from, head: rel!.to };
  }
  const publish = () =>
    act(() => {
      peer.setLocalState({ user, cursor });
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "remote");
    });
  publish();
  return {
    clientID: peer.clientID,
    /** A keepalive: the same connection re-publishing its state with a bumped clock. */
    renew: publish,
  };
}

/** The people badges, without the "+N" overflow chip that shares their class. */
const badges = () =>
  [...container.querySelectorAll<HTMLElement>(".presence-badge")].filter(
    (b) => !b.classList.contains("presence-badge--overflow"),
  );
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button.presence-badge")];
const live = () => container.querySelector(".presence-live")?.textContent ?? "";
/** The local user has a badge too, so peers are addressed by name. */
const LOCAL = 1;
const buttonFor = (label: string) => {
  const found = buttons().filter((b) => b.getAttribute("aria-label") === `Go to ${label}`);
  expect(found, `exactly one badge for ${label}`).toHaveLength(1);
  return found[0]!;
};

describe("the roster as an accessibility surface", () => {
  it("names itself on a role that permits naming", () => {
    connect("ada@acme.com");
    connect("grace@acme.com");
    render();

    const group = container.querySelector("[role='group']");
    expect(group, "the stack is a named group, not a bare div").not.toBeNull();
    expect(group!.getAttribute("aria-label")).toContain("ada@acme.com");
    expect(group!.getAttribute("aria-label")).toContain("grace@acme.com");
  });

  it("makes each collaborator a keyboard-reachable button that says what it does", () => {
    connect("ada@acme.com", { at: "brown" });
    render();

    const badge = buttonFor("ada@acme.com");
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.getAttribute("type")).toBe("button");
    expect(badge.textContent).toBe("AD");
  });

  it("keeps the overflow count out of the a11y tree, since the group already names everyone", () => {
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) connect(`${n}@acme.com`);
    render();

    // Five badges shown, one of them the reader's.
    expect(badges()).toHaveLength(5);
    expect(buttons()).toHaveLength(5 - LOCAL);
    const overflow = container.querySelector(".presence-badge--overflow")!;
    expect(overflow.textContent).toBe(`+${7 + LOCAL - 5}`);
    expect(overflow.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("[role='group']")!.getAttribute("aria-label")).toContain("g@acme.com");
  });

  it("still collapses one person's two tabs into one badge", () => {
    connect("ada@acme.com", { at: "brown" });
    connect("ada@acme.com", { at: "lazy" });
    render();

    expect(badges()).toHaveLength(1 + LOCAL);
    buttonFor("ada@acme.com"); // asserts there is exactly one
  });
});

describe("announcing arrivals and departures", () => {
  it("says nothing about who was already here", () => {
    connect("ada@acme.com");
    connect("grace@acme.com");
    renderAndSettle();

    expect(live()).toBe("");
  });

  it("says nothing about peers who arrive while the document is still opening", () => {
    // Peer states arrive a round trip after connect.
    render();
    connect("ada@acme.com");
    connect("grace@acme.com");
    act(() => void vi.advanceTimersByTime(__TIMINGS.ANNOUNCE_AFTER_MS));

    expect(live()).toBe("");
    expect(badges()).toHaveLength(2 + LOCAL);
  });

  it("announces someone joining, politely", () => {
    connect("ada@acme.com");
    renderAndSettle();

    connect("grace@acme.com");

    expect(live()).toBe("grace@acme.com joined.");
    const region = container.querySelector(".presence-live")!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("role")).toBe("status");
  });

  it("announces someone leaving, once their grace period has passed", () => {
    connect("ada@acme.com");
    const grace = connect("grace@acme.com");
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [grace.clientID], "timeout"));
    expect(live(), "not yet — they may just have blipped").toBe("");

    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));
    expect(live()).toBe("grace@acme.com left.");
  });

  it("stays quiet when a peer drops and comes straight back", () => {
    const ada = connect("ada@acme.com");
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [ada.clientID], "timeout"));
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS / 2));
    connect("ada@acme.com"); // reconnected: a new clientId, the same person
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));

    expect(live()).toBe("");
  });

  it("stays quiet when a throttled tab is culled and renews itself", () => {
    // A throttled background tab misses renewals past the 30s cull and returns on the same client id.
    const ada = connect("ada@acme.com", { at: "brown" });
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [ada.clientID], "timeout"));
    expect(badges(), "the badge goes at once — only the narration waits").toHaveLength(LOCAL);

    act(() => void vi.advanceTimersByTime(30_000)); // their next throttled renewal
    ada.renew();
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));

    expect(badges()).toHaveLength(1 + LOCAL);
    expect(live(), "nobody came or went — the heartbeat was just late").toBe("");
  });

  it("still announces a departure that outlasts the grace", () => {
    const ada = connect("ada@acme.com");
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [ada.clientID], "timeout"));
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));

    expect(live()).toBe("ada@acme.com left.");
  });

  it("waits long enough for a late heartbeat, but not so long that a departure is lost", () => {
    // The tests above hold for any grace, so the value itself is bounded here.
    // Floor: a half-open socket is detected after 60-75s, so a blip returns within about 61s.
    expect(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS).toBeGreaterThanOrEqual(55_000);
    // Ceiling on the reader's wait: the cull comes up to 33s after the last heartbeat, then the grace.
    const CULL_MS = 33_000;
    expect(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS + CULL_MS).toBeLessThanOrEqual(95_000);

    // Long enough for peer replies after connect, short enough to announce an early arrival.
    expect(__TIMINGS.ANNOUNCE_AFTER_MS).toBeGreaterThanOrEqual(1_000);
    expect(__TIMINGS.ANNOUNCE_AFTER_MS).toBeLessThanOrEqual(5_000);
  });

  it("announces a goodbye at once", () => {
    const ada = connect("ada@acme.com");
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [ada.clientID], "remote"));

    expect(live()).toBe("ada@acme.com left.");
  });

  it("welcomes back someone it has already announced as gone", () => {
    const ada = connect("ada@acme.com");
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [ada.clientID], "timeout"));
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));
    expect(live()).toBe("ada@acme.com left.");

    connect("ada@acme.com");

    expect(live()).toBe("ada@acme.com joined.");
  });

  it("never narrates the reader's own departure", () => {
    connect("ada@acme.com");
    renderAndSettle();

    act(() => removeAwarenessStates(awareness, [awareness.clientID], "local"));
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));

    expect(live()).toBe("");
  });

  it("batches simultaneous departures instead of losing all but the last", () => {
    const ada = connect("ada@acme.com");
    const grace = connect("grace@acme.com");
    connect("cy@acme.com");
    renderAndSettle();

    // A live region announces only the last value it is given.
    act(() => removeAwarenessStates(awareness, [ada.clientID, grace.clientID], "timeout"));
    act(() => void vi.advanceTimersByTime(__TIMINGS.INFERRED_DEPARTURE_GRACE_MS));

    expect(live()).toBe("ada@acme.com, grace@acme.com left.");
  });
});

describe("going to a collaborator", () => {
  it("moves the local selection to where they are", () => {
    connect("ada@acme.com", { at: "lazy" });
    renderAndSettle();
    expect(editor.state.selection.from).not.toBe(posOf("lazy"));

    act(() => buttonFor("ada@acme.com").click());

    expect(editor.state.selection.from).toBe(posOf("lazy"));
    expect(toasts.shown).toEqual([]);
    // jsdom reports zero-size rects, so the delta is jumpTo's own 12px gap below the toolbar.
    expect(scrolledIntoView).toEqual([]);
    expect(scroller.scrollTop).toBe(-12);
  });

  it("takes their caret, not their selection", () => {
    connect("ada@acme.com", { selecting: ["brown", "jumps"] });
    renderAndSettle();

    act(() => buttonFor("ada@acme.com").click());

    const { from, to } = editor.state.selection;
    expect(from, "the selection is collapsed").toBe(to);
    expect(from, "and sits at their head, not their anchor").toBe(posOf("jumps") + "jumps".length);
  });

  it("tries every tab a person has open before giving up on them", () => {
    // Only the focused tab publishes a cursor.
    connect("ada@acme.com"); // an idle second tab, no cursor — heard about first
    connect("ada@acme.com", { at: "lazy" }); // the one they are actually typing in
    renderAndSettle();

    act(() => buttonFor("ada@acme.com").click());

    expect(toasts.shown).toEqual([]);
    expect(editor.state.selection.from).toBe(posOf("lazy"));
  });

  it("moves focus to the block on a locked document, where the caret cannot move", () => {
    connect("ada@acme.com", { at: "lazy" });
    editor.setEditable(false);
    renderAndSettle();

    act(() => buttonFor("ada@acme.com").click());

    // On the element: <body> would contain the words too.
    const landed = document.activeElement as HTMLElement;
    expect(landed.tagName).toBe("P");
    expect(landed.textContent).toBe("The lazy dog sleeps on.");
    expect(editor.view.dom.contains(landed), "the focused block is inside the editor").toBe(true);
    expect(landed.tabIndex).toBe(-1);
  });

  it("does not offer to send you to yourself", () => {
    connect("ada@acme.com", { at: "lazy" });
    renderAndSettle();

    const self = badges().filter((b) => b.tagName !== "BUTTON");
    expect(self).toHaveLength(1);
    expect(self[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("says so when they are here but have no cursor in the document", () => {
    connect("ada@acme.com");
    renderAndSettle();
    const before = editor.state.selection.from;

    act(() => buttonFor("ada@acme.com").click());

    expect(editor.state.selection.from).toBe(before);
    expect(toasts.shown).toEqual(["ada@acme.com doesn't have a cursor in this document right now."]);
  });
});
