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
import { RunPreview } from "./extension";
import { useRunPreview } from "./use-run-preview";
import type { HunkKey, RunPreviewHunk } from "./plan";

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

function Probe({ hunks }: { hunks: RunPreviewHunk[] }) {
  const preview = useRunPreview(editor, ydoc, hunks, new Set());
  seen = { anchored: preview.anchored, unanchored: preview.unanchored };
  return null;
}

async function render(hunks: RunPreviewHunk[]): Promise<void> {
  await act(async () => {
    root.render(<Probe hunks={hunks} />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    expect(cell!.querySelectorAll(".ai-preview-hunk-btn")).toHaveLength(2);
  });

  it("keeps a non-table change on the plain div form", async () => {
    await render([{ runId: "run_a", id: "h1", old_string: "Intro paragraph.", new_string: "Intro rewritten." }]);
    expect(seen.anchored).toEqual(["run_a:h1"]);
    const dom = editor.view.dom;
    expect(dom.querySelector("tr.ai-preview-ghost-row")).toBeNull();
    expect(dom.querySelector(".ai-preview-ghost")).not.toBeNull();
  });
});
