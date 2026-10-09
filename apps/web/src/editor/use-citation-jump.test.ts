// @vitest-environment jsdom
// Matching a Markdown excerpt against rendered DOM; landing nowhere beats landing on the wrong passage.
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { act, createElement } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { stugaEditorExtensions } from "./extensions";
import { CitationJump, findPassage, findTarget, jumpTo } from "./use-citation-jump";
import { FLASH_MS } from "./passage-flash";
import { citationHref } from "../ai/citations";
import { hitHref } from "../lib/snippet";
import { mountInto } from "../test/form-input";
import { toastBodies, toasts } from "../test/toast";

/** The editor the hook reads, set by each hook test. */
const shared = vi.hoisted(() => ({ editor: null as unknown }));
vi.mock("./editor-context", () => ({
  useSharedEditor: () => ({ editor: shared.editor, setEditor: () => {} }),
}));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

/** A stand-in for the editor's rendered body. */
function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const DOC = render(`
  <h1>Upkeep</h1>
  <p>An introduction that mentions repairs in passing.</p>
  <h2>Week 2 — Repairs</h2>
  <p>Turn the listed repairs into <strong>dated</strong> jobs.</p>
  <h2>Week 2 — Repairs in Review</h2>
  <p>A later section whose heading merely starts the same way.</p>
  <h2>Costs</h2>
  <table><tbody><tr><td>Hosting</td><td>1200</td></tr></tbody></table>
`);

describe("findTarget", () => {
  it("lands on the section heading, so the reader can see which section they are in", () => {
    const el = findTarget(DOC, "Turn the listed repairs into dated jobs", "Upkeep > Week 2 — Repairs");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Week 2 — Repairs");
  });

  it("climbs to the section heading when only the snippet matches", () => {
    const el = findTarget(DOC, "into dated jobs", "");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Week 2 — Repairs");
  });

  it("falls back to the section heading when the snippet cannot match", () => {
    const el = findTarget(DOC, "text that appears nowhere in this document", "Upkeep > Costs");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Costs");
  });

  it("uses the block itself when the passage has no heading above it", () => {
    const NO_HEADING = render(`<p>A preamble before any heading at all.</p><h2>Later</h2>`);
    const el = findTarget(NO_HEADING, "preamble before any heading", "");
    expect(el?.tagName).toBe("P");
  });

  describe("repeated section names", () => {
    const REPEATED = render(`
      <h1>Spec</h1>
      <h2>Feature A</h2>
      <h3>Acceptance criteria</h3>
      <p>Alpha rules.</p>
      <h2>Feature B</h2>
      <h3>Acceptance criteria</h3>
      <p>Beta rules.</p>
    `);

    it("uses the ancestors to pick the right one", () => {
      const b = findTarget(REPEATED, "", "Spec > Feature B > Acceptance criteria");
      expect(b?.nextElementSibling?.textContent).toBe("Beta rules.");

      const a = findTarget(REPEATED, "", "Spec > Feature A > Acceptance criteria");
      expect(a?.nextElementSibling?.textContent).toBe("Alpha rules.");
    });

    it("still returns something when no ancestor matches", () => {
      const el = findTarget(REPEATED, "", "Spec > Feature Z > Acceptance criteria");
      expect(el?.textContent).toBe("Acceptance criteria");
    });
  });

  it("requires the heading to match exactly, not by prefix", () => {
    const el = findTarget(DOC, "", "Upkeep > Week 2 — Repairs");
    expect(el?.textContent).toBe("Week 2 — Repairs");
  });

  it("shows the section for a passage that renders only as a table cell", () => {
    const el = findTarget(DOC, "Hosting", "");
    expect(el?.textContent).toBe("Costs");
  });

  it("returns nothing rather than guessing", () => {
    expect(findTarget(DOC, "", "")).toBeNull();
    expect(findTarget(DOC, "nowhere at all", "No Such Section")).toBeNull();
  });

  it("round-trips a real citation through the link and back to the passage", () => {
    const href = citationHref({
      doc_id: "d1",
      heading_path: "Upkeep > Week 2 — Repairs",
      content: "## Week 2 — Repairs\n\nTurn the listed repairs into **dated** jobs.",
    });
    const params = new URL(href, "https://x.test").searchParams;
    const el = findTarget(DOC, params.get("q") ?? "", params.get("sec") ?? "");
    expect(el?.tagName).toBe("H2");
    expect(el?.textContent).toBe("Week 2 — Repairs");
    expect(el?.nextElementSibling?.textContent).toContain("Turn the listed repairs");
  });
});

describe("jumpTo", () => {
  // The fallback case needs no leftover scroller in the document.
  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** A scroller at y=100 with a 40px sticky toolbar, and a target 500px down. */
  function scene({ targetTop }: { targetTop: number }) {
    const scroller = document.createElement("div");
    scroller.className = "doc-main";
    const toolbar = document.createElement("div");
    toolbar.className = "editor-toolbar-bar";
    const target = document.createElement("p");
    scroller.append(toolbar, target);
    document.body.append(scroller);

    scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    toolbar.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: targetTop }) as DOMRect;
    scroller.scrollTop = 0;
    return { scroller, target };
  }

  it("puts the passage at the top, below the sticky toolbar", () => {
    const { scroller, target } = scene({ targetTop: 600 });
    jumpTo(target);
    // 600 - 100 (scroller top) - 40 (toolbar) - 12 (gap) = 448
    expect(scroller.scrollTop).toBe(448);
  });

  it("scrolls backwards when the passage is above the viewport", () => {
    const { scroller, target } = scene({ targetTop: -200 });
    scroller.scrollTop = 900;
    jumpTo(target);
    expect(scroller.scrollTop).toBe(900 + (-200 - 100 - 40 - 12));
  });

  it("sets scrollTop outright instead of animating through scrollIntoView", () => {
    const { target } = scene({ targetTop: 600 });
    let called = false;
    target.scrollIntoView = () => {
      called = true;
    };
    jumpTo(target);
    expect(called).toBe(false);
  });

  it("falls back to scrollIntoView when there is no scroller", () => {
    const orphan = document.createElement("p");
    document.body.append(orphan);
    let opts: ScrollIntoViewOptions | undefined;
    orphan.scrollIntoView = (o?: boolean | ScrollIntoViewOptions) => {
      opts = o as ScrollIntoViewOptions;
    };
    jumpTo(orphan);
    expect(opts).toEqual({ behavior: "auto", block: "start" });
  });
});

describe("findPassage", () => {
  it("lands on the block that holds the hit, not its section heading", () => {
    const el = findPassage(DOC, "Turn the listed repairs into dated jobs");
    expect(el?.tagName).toBe("P");
    expect(el?.textContent).toContain("Turn the listed repairs");
  });

  it("passes over an earlier mention of the hit word, since the words around it differ", () => {
    // The introduction mentions "repairs" first.
    expect(findPassage(DOC, "the listed repairs into")?.textContent).toContain("Turn the listed");
  });

  it("lands on a heading when the hit is in it", () => {
    expect(findPassage(DOC, "Week 2 — Repairs")?.tagName).toBe("H2");
  });

  it("flashes the innermost block, so a list item's paragraph or a quoted one stands alone", () => {
    const NESTED = render(`
      <ul><li><p>Outer item about gutters</p><ul><li><p>Nested item about drains</p></li></ul></li></ul>
      <blockquote><p>First quoted line.</p><p>Second quoted line about repairs.</p></blockquote>
    `);
    expect(findPassage(NESTED, "Outer item about gutters")?.tagName).toBe("P");
    expect(findPassage(NESTED, "Nested item about drains")?.textContent).toBe("Nested item about drains");
    expect(findPassage(NESTED, "quoted line about repairs")?.textContent).toBe("Second quoted line about repairs.");
  });

  it("returns nothing rather than guessing", () => {
    expect(findPassage(DOC, "text that appears nowhere in this document")).toBeNull();
    // A hand-edited link with a scrap of text would match by chance.
    expect(findPassage(DOC, "repairs")).toBeNull();
    expect(findPassage(DOC, "")).toBeNull();
  });

  it("round-trips a real search hit through the link and back to the passage", () => {
    const href = hitHref("d1", { title: "Upkeep", snippet: "## Week 2 — Repairs\n\nTurn the listed ⟦repairs⟧ into **dated** jobs." }, "repairs");
    const hint = new URL(href, "https://x.test").searchParams.get("hit") ?? "";
    const el = findPassage(DOC, hint);
    expect(el?.tagName).toBe("P");
    expect(el?.textContent).toBe("Turn the listed repairs into dated jobs.");
  });
});

/** A live collaborative editor holding `md`, inside the document's scroller as DocPage lays it out. */
function liveEditor(md: string): { editor: Editor; ydoc: Y.Doc; awareness: Awareness } {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  // jumpTo scrolls the `.doc-main` the editor lives in.
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.className = "doc-main";
  const editor = new Editor({
    element: scroller.appendChild(document.createElement("div")),
    extensions: stugaEditorExtensions({ ydoc, awareness, alias: "me", onClickComment: () => {} }),
  });
  editor.commands.setContent(md);
  onTestFinished(() => {
    editor.destroy();
    awareness.destroy();
    scroller.remove();
  });
  return { editor, ydoc, awareness };
}

/** Navigates the open document's router, as the palette does. */
let go: NavigateFunction;
function Go(): null {
  go = useNavigate();
  return null;
}

/** Opens `url` on the editor the hook reads. */
async function open(url: string): Promise<void> {
  const { root } = mountInto();
  await act(async () =>
    root.render(createElement(MemoryRouter, { initialEntries: [url] }, createElement(CitationJump), createElement(Go))),
  );
}

/** The text of each block flashing now. */
function flashing(editor: Editor): string[] {
  return Array.from(editor.view.dom.querySelectorAll(".citation-target--flash"), (el) => el.textContent ?? "");
}

// The hit is not the last block, where setContent leaves the caret.
const MD = ["## Week 2 — Repairs", "Turn the listed repairs into **dated** jobs.", "## Costs", "Hosting runs to twelve hundred a year."].join("\n\n");
const PASSAGE = "Turn the listed repairs into dated jobs.";
const HIT = `/doc/d1?hit=${encodeURIComponent("the listed repairs into dated")}`;
const CITE = `/doc/d1?q=${encodeURIComponent("into dated jobs")}`;

describe("CitationJump", () => {
  let live: Editor;

  beforeEach(() => {
    vi.useFakeTimers();
    toasts.shown = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    shared.editor = null;
  });

  /** Opens `url` on a document holding `md`. */
  async function openDoc(url: string, md = MD): Promise<void> {
    live = liveEditor(md).editor;
    shared.editor = live;
    await open(url);
  }

  it("lands a search hit on its block, not the section heading", async () => {
    await openDoc(HIT);
    expect(flashing(live)).toEqual([PASSAGE]);
  });

  it("waits for a body that arrives in frames", async () => {
    await openDoc(HIT, "");
    await act(async () => vi.advanceTimersByTime(300));
    expect(flashing(live)).toEqual([]);
    live.commands.setContent(MD);
    await act(async () => vi.advanceTimersByTime(150));
    expect(flashing(live)).toEqual([PASSAGE]);
  });

  it("leaves the document at the top, without a word, when a search hit is not found", async () => {
    await openDoc(`/doc/d1?hit=${encodeURIComponent("text that appears nowhere here")}`);
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(flashing(live)).toEqual([]);
    expect(document.querySelector<HTMLElement>(".doc-main")?.scrollTop).toBe(0);
    expect(toastBodies()).toEqual([]);
  });

  it("still lands a citation on its section heading", async () => {
    await openDoc(CITE);
    expect(flashing(live)).toEqual(["Week 2 — Repairs"]);
  });

  it("still says when a cited passage is not found", async () => {
    await openDoc(`/doc/d1?q=${encodeURIComponent("nowhere at all")}`);
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(toastBodies()).toEqual([
      "Couldn’t find “nowhere at all” in this document. It may have changed since that answer was written.",
    ]);
  });

  it("lands again when the palette picks the passage already open", async () => {
    await openDoc(HIT);
    for (const jump of [1, 2]) {
      // The flash has faded and the reader has scrolled on.
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(flashing(live)).toEqual([]);
      await act(async () => go(HIT, { state: { jump } }));
      expect(flashing(live)).toEqual([PASSAGE]);
    }
  });

  it("leaves the reader where they scrolled when a later visit to the same link is no new pick", async () => {
    await openDoc(HIT);
    await act(async () => go(HIT, { state: { jump: 1 } }));
    await act(async () => vi.advanceTimersByTime(2_000));
    await act(async () => go(HIT));
    expect(flashing(live)).toEqual([]);
  });

  it("follows a citation's hints over a search hit's", async () => {
    await openDoc(`/doc/d1?q=${encodeURIComponent("into dated jobs")}&hit=${encodeURIComponent("the listed repairs into dated")}`);
    expect(flashing(live)).toEqual(["Week 2 — Repairs"]);
  });
});

describe("placing the reader at the passage", () => {
  let awareness: Awareness;
  let live: Editor;

  beforeEach(() => {
    vi.useFakeTimers();
    toasts.shown = [];
    ({ editor: live, awareness } = liveEditor(MD));
    shared.editor = live;
  });

  afterEach(() => {
    shared.editor = null;
    vi.useRealTimers();
  });

  /** The block the caret is in, and how far into it. */
  function caret() {
    const { $from, empty } = live.state.selection;
    return { block: $from.parent.textContent, offset: $from.parentOffset, empty };
  }

  it("puts the caret at the start of a search hit's block without focusing the editor", async () => {
    const before = document.activeElement;
    await open(HIT);
    expect(caret()).toEqual({ block: PASSAGE, offset: 0, empty: true });
    // Opening a document is reading; focus would raise a phone's keyboard.
    expect(document.activeElement).toBe(before);
    expect(live.view.hasFocus()).toBe(false);
    // Nor do collaborators see it until the reader focuses the editor.
    expect(awareness.getLocalState()?.cursor ?? null).toBeNull();
  });

  it("puts the caret at a citation's section heading", async () => {
    await open(CITE);
    expect(caret()).toEqual({ block: "Week 2 — Repairs", offset: 0, empty: true });
    expect(live.view.hasFocus()).toBe(false);
  });

  it("does not scroll to the caret, which would undo jumpTo's room for the toolbar", async () => {
    const scrolls: boolean[] = [];
    live.on("transaction", ({ transaction }) => scrolls.push(transaction.scrolledIntoView));
    await open(HIT);
    await act(async () => vi.advanceTimersByTime(FLASH_MS));
    // The caret, the flash and its end.
    expect(scrolls).toEqual([false, false, false]);
  });

  it("leaves undo history alone, so undo still takes back the reader's last edit", async () => {
    live.commands.insertContentAt(live.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "A late edit." }] });
    const undo = yUndoPluginKey.getState(live.state)!.undoManager;
    undo.stopCapturing();
    const depth = undo.undoStack.length;

    await open(HIT);
    expect(caret().block).toBe(PASSAGE);
    await act(async () => vi.advanceTimersByTime(FLASH_MS));
    expect(flashing(live)).toEqual([]);
    expect(undo.undoStack.length).toBe(depth);

    live.commands.undo();
    expect(live.getText()).not.toContain("A late edit.");
  });

  it("leaves the caret where it landed when the flash ends", async () => {
    await open(HIT);
    const landed = live.state.selection.toJSON();
    await act(async () => vi.advanceTimersByTime(FLASH_MS));
    expect(live.state.selection.toJSON()).toEqual(landed);
    expect(live.view.hasFocus()).toBe(false);
  });

  it("focuses a search hit's block on a read-only document, where there is no caret", async () => {
    live.setEditable(false);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    onTestFinished(() => focus.mockRestore());
    await open(HIT);
    // On the element: <body> would contain the words too.
    const landed = document.activeElement as HTMLElement;
    expect(landed.tagName).toBe("P");
    expect(landed.textContent).toBe(PASSAGE);
    expect(live.view.dom.contains(landed)).toBe(true);
    expect(landed.tabIndex).toBe(-1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("focuses a citation's section heading on a read-only document", async () => {
    live.setEditable(false);
    await open(CITE);
    const landed = document.activeElement as HTMLElement;
    expect(landed.tagName).toBe("H2");
    expect(landed.textContent).toBe("Week 2 — Repairs");
  });

  it("leaves the caret and focus where they were when a search hit is not found", async () => {
    const before = live.state.selection.toJSON();
    await open(`/doc/d1?hit=${encodeURIComponent("text that appears nowhere here")}`);
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(live.state.selection.toJSON()).toEqual(before);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("flashing the landed block", () => {
  let ydoc: Y.Doc;
  let live: Editor;

  beforeEach(() => {
    vi.useFakeTimers();
    toasts.shown = [];
    ({ editor: live, ydoc } = liveEditor(MD));
    shared.editor = live;
  });

  afterEach(() => {
    shared.editor = null;
    vi.useRealTimers();
  });

  /** Makes `edit` on a peer's copy and delivers it, as the socket does a collaborator's. */
  function fromPeer(edit: (body: Y.XmlFragment) => void): void {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    edit(peer.getXmlFragment("default"));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));
  }

  /** Where the landed passage sits among the document's top-level blocks. */
  const passageIndex = (body: Y.XmlFragment) => body.toArray().findIndex((el) => el.toString().includes("Turn the listed"));

  it("shows on an editable document, whose blocks ProseMirror redraws when their classes are set by hand", async () => {
    await open(HIT);
    // Lets ProseMirror's DOM observer run, as the browser does before it paints.
    await act(async () => {});
    expect(flashing(live)).toEqual([PASSAGE]);
  });

  it("survives ProseMirror redrawing the block", async () => {
    await open(HIT);
    const drawn = live.view.dom.querySelector(".citation-target--flash")!;
    // An attribute set from outside reads as an edit, and ProseMirror redraws the block from the document.
    await act(async () => drawn.setAttribute("data-outside", ""));
    const redrawn = live.view.dom.querySelector(".citation-target--flash");
    expect(redrawn).not.toBe(drawn);
    expect(redrawn?.textContent).toBe(PASSAGE);
  });

  it("ends when the animation does", async () => {
    await open(HIT);
    await act(async () => vi.advanceTimersByTime(FLASH_MS - 1));
    expect(flashing(live)).toEqual([PASSAGE]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(flashing(live)).toEqual([]);
  });

  it("is not cut short by the end of the flash before it", async () => {
    await open(HIT);
    await act(async () => vi.advanceTimersByTime(1_000));
    await act(async () => go(HIT, { state: { jump: 1 } }));
    await act(async () => vi.advanceTimersByTime(FLASH_MS - 1));
    expect(flashing(live)).toEqual([PASSAGE]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(flashing(live)).toEqual([]);
  });

  it("follows its block through a collaborator's edits", async () => {
    await open(HIT);
    await act(async () =>
      fromPeer((body) => {
        const line = new Y.XmlElement("paragraph");
        line.insert(0, [new Y.XmlText("A collaborator's new opening line.")]);
        body.insert(0, [line]);
      }),
    );
    expect(live.getText()).toContain("A collaborator's new opening line.");
    expect(flashing(live)).toEqual([PASSAGE]);

    await act(async () =>
      fromPeer((body) => {
        const text = (body.get(passageIndex(body)) as Y.XmlElement).get(0) as Y.XmlText;
        text.insert(text.length, " Soon.");
      }),
    );
    expect(flashing(live)).toEqual([`${PASSAGE} Soon.`]);
  });

  it("ends when a collaborator deletes its block, rather than flashing another", async () => {
    await open(HIT);
    await act(async () => fromPeer((body) => body.delete(passageIndex(body), 1)));
    expect(live.getText()).not.toContain("Turn the listed");
    expect(flashing(live)).toEqual([]);
  });

  it("shows on a read-only document the same way", async () => {
    live.setEditable(false);
    await open(HIT);
    expect(flashing(live)).toEqual([PASSAGE]);
    await act(async () => vi.advanceTimersByTime(FLASH_MS));
    expect(flashing(live)).toEqual([]);
  });
});
