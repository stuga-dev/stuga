// @vitest-environment jsdom
/**
 * A ghost mounted among table rows must be a <tr>: a <div> in a <tbody> gets an
 * anonymous column-1 cell that stretches the live table. Driven through a real
 * editor so the assertion is on the DOM ProseMirror rendered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { applyMarkdownToYXmlFragment, stugaExtensions } from "@stuga/crdt-ops";
import { RunPreview, previewStorage } from "./extension";
import { useRunPreview } from "./use-run-preview";
import { RUN_HUNK_EVENT, type HunkKey, type RunHunkDecisionDetail, type RunPreviewHunk } from "./plan";

const MD = [
  "Intro paragraph.",
  "",
  "| Level | Focus |",
  "| --- | --- |",
  "| Season | Why we keep the cottage |",
  "| Job | Which rooms come first |",
  "",
].join("\n");

/** Rewords one cell of the second row. */
const ROW_HUNK: RunPreviewHunk = {
  runId: "run_a",
  id: "h1",
  old_string: "Why we keep the cottage",
  new_string: "Why we keep the cottage, checked yearly",
};

let container: HTMLDivElement;
let root: Root;
let ydoc: Y.Doc;
let editor: Editor;
let seen: { anchored: readonly HunkKey[]; unanchored: readonly HunkKey[] };

function Probe({ hunks, inFlight }: { hunks: RunPreviewHunk[]; inFlight: ReadonlySet<HunkKey> }) {
  const preview = useRunPreview(editor, ydoc, hunks, inFlight);
  seen = { anchored: preview.anchored, unanchored: preview.unanchored };
  return null;
}

/** Paint `hunks` as the pending ones, with the decisions on `inFlight` posted and not yet answered. */
async function render(hunks: RunPreviewHunk[], inFlight: ReadonlySet<HunkKey> = new Set()): Promise<void> {
  await act(async () => {
    root.render(<Probe hunks={hunks} inFlight={inFlight} />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ydoc = new Y.Doc();
  applyMarkdownToYXmlFragment(ydoc.getXmlFragment("default"), MD);
  container = document.createElement("div");
  document.body.appendChild(container);
  editor = new Editor({
    element: container.appendChild(document.createElement("div")),
    extensions: [
      ...stugaExtensions(),
      Collaboration.configure({ document: ydoc, field: "default" }),
      RunPreview.configure({ ydoc }),
    ],
  });
  root = createRoot(container.appendChild(document.createElement("div")));
});

afterEach(() => {
  act(() => root.unmount());
  editor.destroy();
  container.remove();
  vi.useRealTimers();
});

describe("a run ghost over a table row", () => {
  it("renders as a <tr> in the LIVE table's tbody, never a bare <div>", async () => {
    await render([ROW_HUNK]);
    // The hunk painted, so the DOM assertions below can't pass vacuously.
    expect(seen.anchored).toEqual(["run_a:h1"]);

    const dom = editor.view.dom;
    expect(dom.querySelector("tbody > div.ai-preview-ghost")).toBeNull();

    const shell = dom.querySelector<HTMLTableRowElement>("tr.ai-preview-ghost-row");
    expect(shell).not.toBeNull();
    // In the live table, not the ghost's own mini table.
    expect(shell!.closest("table")!.classList.contains("ai-preview-ghost-table")).toBe(false);
    expect(shell!.parentElement!.tagName).toBe("TBODY");
    expect(shell!.parentElement!.querySelectorAll("tr").length).toBeGreaterThan(1);
  });

  it("spans the whole grid with ONE cell, so no single column absorbs its width", async () => {
    await render([ROW_HUNK]);
    const cell = editor.view.dom.querySelector<HTMLTableCellElement>("td.ai-preview-ghost-cell");
    expect(cell).not.toBeNull();
    expect(cell!.colSpan).toBe(2);
    expect(cell!.parentElement!.children).toHaveLength(1);
    expect(cell!.querySelector(".ai-preview-ghost")).not.toBeNull();
    expect(cell!.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(3);
  });

  it("keeps a non-table change on the plain div form", async () => {
    await render([{ runId: "run_a", id: "h1", old_string: "Intro paragraph.", new_string: "Intro rewritten." }]);
    expect(seen.anchored).toEqual(["run_a:h1"]);
    const dom = editor.view.dom;
    expect(dom.querySelector("tr.ai-preview-ghost-row")).toBeNull();
    expect(dom.querySelector(".ai-preview-ghost")).not.toBeNull();
  });
});

describe("a change painted in several places", () => {
  // One hunk rewording two paragraphs with an untouched one between: two segments.
  const SPREAD = ["First line.", "", "Kept as is.", "", "Last line.", ""].join("\n");
  const HUNK: RunPreviewHunk = {
    runId: "run_a",
    id: "h1",
    old_string: "First line.\n\nKept as is.\n\nLast line.",
    new_string: "First line, edited.\n\nKept as is.\n\nLast line, edited.",
  };

  it("carries its buttons once, at its last part, and links the earlier part to them", async () => {
    await act(async () => {
      applyMarkdownToYXmlFragment(ydoc.getXmlFragment("default"), SPREAD);
    });
    await render([HUNK]);
    expect(seen.anchored).toEqual(["run_a:h1"]);

    const dom = editor.view.dom;
    const parts = dom.querySelectorAll<HTMLElement>('[data-hunk-key="run_a:h1"]');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.querySelector(".ai-preview-hunk-btn")).toBeNull();
    expect(parts[0]!.querySelector(".ai-preview-hunk-part")!.textContent).toBe("Part 1 of 2 · Go to decision");
    expect(parts[0]!.getAttribute("aria-label")).toMatch(/^Change 1 of 1, part 1 of 2: /);
    expect(parts[1]!.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(3);
    expect(parts[1]!.querySelector(".ai-preview-hunk-scope")!.textContent).toBe("Applies to both parts");

    // Go to decision lands keyboard focus on the Accept that decides both parts.
    const accept = parts[1]!.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--accept")!;
    accept.scrollIntoView = () => {};
    parts[0]!.querySelector<HTMLButtonElement>(".ai-preview-hunk-goto")!.click();
    expect(document.activeElement).toBe(accept);
    expect(accept.getAttribute("aria-describedby")).toBe(parts[1]!.querySelector(".ai-preview-hunk-scope")!.id);
  });

  it("reads adjacent blocks of one change as one part, with one set of buttons after it", async () => {
    const ADJACENT = ["Keep.", "", "Gone paragraph.", "", "Old ending here.", ""].join("\n");
    await act(async () => {
      applyMarkdownToYXmlFragment(ydoc.getXmlFragment("default"), ADJACENT);
    });
    await render([{ runId: "run_a", id: "h1", old_string: "Gone paragraph.\n\nOld ending here.", new_string: "New ending here." }]);
    expect(seen.anchored).toEqual(["run_a:h1"]);

    const dom = editor.view.dom;
    expect(dom.querySelectorAll(".ai-preview-hunk-btn--accept")).toHaveLength(1);
    expect(dom.querySelector(".ai-preview-hunk-part")).toBeNull();
    expect(dom.querySelector(".ai-preview-hunk-scope")).toBeNull();
    // Two segments: the deletion struck, and the rewording diffed on its own text.
    expect(dom.querySelector(".ai-preview-delete")!.textContent).toBe("Gone paragraph.");
    expect(dom.querySelector("p ins.ai-preview-insert")!.textContent).toBe("New");
    // Both live paragraphs wear the rail; the untouched one does not.
    const railed = [...dom.querySelectorAll("p.ai-preview-part")].map((p) => p.textContent);
    expect(railed.some((t) => t?.includes("Gone paragraph."))).toBe(true);
    expect(railed.some((t) => t?.includes("Keep."))).toBe(false);
    // The buttons come after everything the change touches.
    const accept = dom.querySelector(".ai-preview-hunk-btn--accept")!;
    const ending = [...dom.querySelectorAll("p")].find((p) => p.textContent?.includes("ending"))!;
    expect(ending.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("a reworded paragraph", () => {
  const REWORD: RunPreviewHunk = { runId: "run_a", id: "h1", old_string: "Intro paragraph.", new_string: "Opening paragraph." };

  it("is diffed on its own text, so the paragraph is not shown twice", async () => {
    await render([REWORD]);
    expect(seen.anchored).toEqual(["run_a:h1"]);
    const dom = editor.view.dom;
    const live = dom.querySelector("p")!;
    expect(live.querySelector(".ai-preview-delete")!.textContent).toBe("Intro");
    expect(live.querySelector("ins.ai-preview-insert")!.textContent).toBe("Opening");
    // The ghost below carries only the buttons, no second copy of the text.
    const ghost = dom.querySelector(".ai-preview-ghost")!;
    expect(ghost.classList.contains("ai-preview-ghost--inline")).toBe(true);
    expect(ghost.textContent).not.toContain("paragraph");
    expect(ghost.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(3);
    // The document itself is untouched.
    expect(editor.state.doc.textContent).toContain("Intro paragraph.");
    expect(editor.state.doc.textContent).not.toContain("Opening");
  });
});

describe("Mod-Z with a review history", () => {
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, bubbles: true, cancelable: true, ...init });
    return editor.view.someProp("handleKeyDown", (f) => f(editor.view, event)) === true;
  };

  it("asks the history before the editor's own undo, and redo the same way", () => {
    const calls: string[] = [];
    previewStorage(editor)!.history = {
      undo: () => (calls.push("undo"), true),
      redo: () => (calls.push("redo"), true),
      canUndo: () => true,
      canRedo: () => true,
    };
    expect(press({ key: "z" })).toBe(true);
    expect(press({ key: "z", shiftKey: true })).toBe(true);
    expect(press({ key: "y" })).toBe(true);
    expect(calls).toEqual(["undo", "redo", "redo"]);
  });

  it("falls through to typing undo when the history declines", () => {
    previewStorage(editor)!.history = { undo: () => false, redo: () => false, canUndo: () => false, canRedo: () => false };
    editor.commands.insertContentAt(1, "Typed ");
    expect(editor.state.doc.textContent).toContain("Typed");
    press({ key: "z" });
    expect(editor.state.doc.textContent).not.toContain("Typed");
  });
});

describe("a change's note", () => {
  const INTRO: RunPreviewHunk = { runId: "run_a", id: "h1", old_string: "Intro paragraph.", new_string: "Intro rewritten." };
  /** Another change, further down, which renumbers the first ("1 of 2") and so builds its ghost anew. */
  const SECOND: RunPreviewHunk = { ...ROW_HUNK, id: "h2" };
  const noteButton = () => editor.view.dom.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--request_changes");
  const field = () => editor.view.dom.querySelector<HTMLTextAreaElement>(".ai-preview-hunk-note__field");
  const type = (text: string) => {
    field()!.value = text;
    field()!.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (k: string) => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  /** Focus on a control outside the editor, as the reviewer moves on. */
  const focusElsewhere = () => {
    const other = container.appendChild(document.createElement("button"));
    other.focus();
    return other;
  };
  /** Let the frame that focuses the note run, and whatever a timer holds. */
  const frame = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

  it("names the button for what the note does, and sends with the same words", async () => {
    await render([{ ...INTRO, noteMode: "revise" }]);
    expect(noteButton()!.textContent).toBe("Revise…");
    noteButton()!.click();
    // The note takes the row's place, so nothing else can be decided while it is written.
    expect(editor.view.dom.querySelector(".ai-preview-hunk-actions")).toBeNull();
    const submit = editor.view.dom.querySelector<HTMLButtonElement>(".ai-preview-hunk-btn--submit")!;
    expect(submit.textContent).toBe("Revise");
    expect(submit.disabled).toBe(true);
    expect(editor.view.dom.querySelector(".ai-preview-hunk-note__hint")).toBeNull();
    key("Escape");
  });

  it("says where an agent's note goes", async () => {
    await render([INTRO]);
    expect(noteButton()!.textContent).toBe("Reject with note…");
    noteButton()!.click();
    expect(editor.view.dom.querySelector(".ai-preview-hunk-btn--submit")!.textContent).toBe("Reject with note");
    expect(editor.view.dom.querySelector(".ai-preview-hunk-note__hint")!.textContent).toMatch(/next time it works here/);
    key("Escape");
  });

  it("sends the note on Enter, as a decision on that one change", async () => {
    await render([INTRO]);
    const sent: RunHunkDecisionDetail[] = [];
    const listen = (e: Event) => sent.push((e as CustomEvent<RunHunkDecisionDetail>).detail);
    document.addEventListener(RUN_HUNK_EVENT, listen);
    noteButton()!.click();
    key("Enter");
    expect(sent).toEqual([]);
    type("  Keep it shorter.  ");
    key("Enter");
    document.removeEventListener(RUN_HUNK_EVENT, listen);
    expect(sent).toEqual([{ runId: "run_a", hunkId: "h1", decision: "request_changes", note: "Keep it shorter." }]);
    // The document is the editor's, and the keys in the note were not.
    expect(editor.state.doc.textContent).toContain("Intro paragraph.");
    // The rejection lands, and the note leaves with its change.
    await render([]);
  });

  it("gives the note back, as written, when its rejection doesn't land", async () => {
    await render([INTRO]);
    noteButton()!.click();
    type("Keep it shorter.");
    key("Enter");
    // In flight the change leaves the page; failed or blocked, it is pending again.
    await render([], new Set(["run_a:h1"]));
    expect(field()).toBeNull();
    await render([INTRO]);
    expect(field()!.value).toBe("Keep it shorter.");
    key("Escape");
  });

  it("gives it back without taking the focus from where the reviewer moved it meanwhile", async () => {
    await render([INTRO]);
    noteButton()!.click();
    await frame();
    type("Keep it shorter.");
    key("Enter");
    await render([], new Set(["run_a:h1"]));
    const banner = focusElsewhere();
    await render([INTRO]);
    expect(field()!.value).toBe("Keep it shorter.");
    expect(document.activeElement).toBe(banner);
    key("Escape");
  });

  it("takes the focus when opened, though a repaint builds it anew before the next frame", async () => {
    await render([INTRO]);
    // The note button keeps focus where it was, as a press on it must leave the editor's caret.
    focusElsewhere();
    noteButton()!.click();
    await render([INTRO, SECOND]);
    expect(document.activeElement).toBe(field());
    key("Escape");
  });

  it("drops the note when its change is decided some other way, so an Undo brings back the buttons", async () => {
    await render([INTRO]);
    noteButton()!.click();
    type("Half a thought");
    // Reject all, or a collaborator's decision: the change leaves review with nothing in flight here.
    await render([]);
    await render([INTRO]);
    expect(field()).toBeNull();
    expect(noteButton()).not.toBeNull();
  });

  it("leaves an input method's Enter and Escape to it", async () => {
    await render([INTRO]);
    const sent: RunHunkDecisionDetail[] = [];
    const listen = (e: Event) => sent.push((e as CustomEvent<RunHunkDecisionDetail>).detail);
    document.addEventListener(RUN_HUNK_EVENT, listen);
    noteButton()!.click();
    type("再短一点");
    // Safari's Enter that picks a candidate comes after compositionend, with the IME's keyCode 229.
    field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
    field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    document.removeEventListener(RUN_HUNK_EVENT, listen);
    expect(sent).toEqual([]);
    expect(field()!.value).toBe("再短一点");
    key("Escape");
  });

  it("puts the row back on Escape, with focus on the note button", async () => {
    await render([INTRO]);
    noteButton()!.click();
    type("Half a thought");
    key("Escape");
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(noteButton());
    // Opened again, it starts empty.
    noteButton()!.click();
    expect(field()!.value).toBe("");
    key("Escape");
  });

  it("keeps the note being written when the ghost is painted again", async () => {
    await render([INTRO]);
    noteButton()!.click();
    type("Not this word");
    const before = field();
    // A second change renumbers the first ("1 of 2"), which builds its ghost anew.
    await render([INTRO, ROW_HUNK]);
    expect(field()).not.toBe(before);
    expect(field()!.value).toBe("Not this word");
    expect(document.activeElement).toBe(field());
    key("Escape");
  });

  it("keeps the caret and the selection when the ghost is built anew", async () => {
    await render([INTRO]);
    noteButton()!.click();
    await frame();
    type("Not this word");
    field()!.setSelectionRange(4, 8, "backward");
    await render([INTRO, SECOND]);
    expect(document.activeElement).toBe(field());
    expect([field()!.selectionStart, field()!.selectionEnd, field()!.selectionDirection]).toEqual([4, 8, "backward"]);
    key("Escape");
  });

  it("holds a repaint while an input method composes, and paints it once the candidate is picked", async () => {
    await render([INTRO]);
    noteButton()!.click();
    await frame();
    type("Not th");
    const composing = field()!;
    composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await render([INTRO, SECOND]);
    expect(field()).toBe(composing);
    composing.value = "Not this";
    composing.dispatchEvent(new Event("input", { bubbles: true }));
    composing.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await frame();
    // The renumbering held back paints now, around the note as written.
    expect(field()).not.toBe(composing);
    expect(field()!.value).toBe("Not this");
    expect(editor.view.dom.querySelector(".ai-preview-hunk-note")!.getAttribute("aria-label")).toMatch(/change 1 of 2/);
    key("Escape");
  });
});
