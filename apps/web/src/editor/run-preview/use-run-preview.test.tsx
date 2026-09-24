// @vitest-environment jsdom
/**
 * The run paint follows the document, not just the pending set. Driven through
 * a real editor bound to a Y.Doc, so the hook sees both the live document and
 * the CRDT's markdown.
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

/** Two identical lines: h2 is unique only AFTER h1 has run. */
const MD = ["Alpha", "", "Sized in points.", "", "Beta", "", "Sized in points.", ""].join("\n");
const H1: RunPreviewHunk = {
  runId: "run_a",
  id: "h1",
  old_string: "Alpha\n\nSized in points.",
  new_string: "Alpha\n\nSized in days.",
};
const H2: RunPreviewHunk = { runId: "run_a", id: "h2", old_string: "Sized in points.", new_string: "Sized in days." };

const NONE_IN_FLIGHT: ReadonlySet<HunkKey> = new Set();

let container: HTMLDivElement;
let root: Root;
let ydoc: Y.Doc;
let editor: Editor;
let seen: { anchored: readonly HunkKey[]; unanchored: readonly HunkKey[] };

function Probe({ hunks }: { hunks: RunPreviewHunk[] }) {
  const preview = useRunPreview(editor, ydoc, hunks, NONE_IN_FLIGHT);
  seen = { anchored: preview.anchored, unanchored: preview.unanchored };
  return null;
}

async function render(hunks: RunPreviewHunk[]): Promise<void> {
  await act(async () => {
    root.render(<Probe hunks={hunks} />);
  });
}

/** Let the debounce fire, plus the microtask the report notification defers to. */
async function settle(): Promise<void> {
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

describe("useRunPreview", () => {
  it("re-anchors a chained hunk once its predecessor lands in the document", async () => {
    await render([H1, H2]);
    await settle();
    expect([...seen.anchored].sort()).toEqual(["run_a:h1", "run_a:h2"]);
    expect(seen.unanchored).toEqual([]);

    // An optimistic accept of h1 leaves h2 measured against a document where it matches twice.
    await render([H2]);
    expect(seen.anchored).toEqual([]);
    expect(seen.unanchored).toEqual(["run_a:h2"]);

    await act(async () => {
      applyMarkdownToYXmlFragment(ydoc.getXmlFragment("default"), MD.replace("Alpha\n\nSized in points.", "Alpha\n\nSized in days."), {
        originalMarkdown: MD,
      });
    });
    await settle();
    expect(seen.anchored).toEqual(["run_a:h2"]);
    expect(seen.unanchored).toEqual([]);
  });

  it("unanchors a hunk when a collaborator edits its text away", async () => {
    await render([H1]);
    await settle();
    expect(seen.anchored).toEqual(["run_a:h1"]);

    await act(async () => {
      applyMarkdownToYXmlFragment(
        ydoc.getXmlFragment("default"),
        MD.replace("Alpha\n\nSized in points.", "Alpha\n\nSomething else entirely."),
        { originalMarkdown: MD },
      );
    });
    await settle();
    expect(seen.anchored).toEqual([]);
    expect(seen.unanchored).toEqual(["run_a:h1"]);
  });
});
