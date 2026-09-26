// @vitest-environment jsdom
/**
 * Clicking a comment moves the caret to where the editor paints it, so a comment
 * placed by its quote (an imported one has no anchor) is jumped to like any other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import { getStugaSchema, applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import type { Comment } from "../api";

const shared = vi.hoisted(() => ({ editor: null as unknown, comments: [] as Comment[] }));

vi.mock("../api", () => ({ Docs: { comments: vi.fn(async () => ({ comments: shared.comments })) } }));
vi.mock("../editor/editor-context", () => ({ useSharedEditor: () => ({ editor: shared.editor }) }));

const { CommentsProvider, useComments } = await import("./comments-context");
const { commentHighlightPlugin } = await import("./comment-highlight");

const PROSE = "The quick brown fox jumps over the lazy dog.";

/** Where the caret was put, one entry per jump. */
const caret: number[] = [];
const onReveal = vi.fn();
const scrolled = vi.fn();

/** The highlight extension's storage, which the provider mirrors its state into. */
const highlight = { comments: [] as Comment[], activeNum: null as number | null, flashNum: null as number | null };

/** The slice of a Tiptap editor the provider touches, over a live Y-bound view. */
function editorOver(view: EditorView) {
  const chain = {
    focus: () => chain,
    setTextSelection: (pos: number) => {
      caret.push(pos);
      return chain;
    },
    run: () => true,
  };
  return {
    isDestroyed: false,
    storage: { commentHighlight: highlight },
    view,
    get state() {
      return view.state;
    },
    chain: () => chain,
  };
}

function imported(num: number, quote: string, over: Partial<Comment> = {}): Comment {
  return {
    num,
    doc_id: "d1",
    parent_num: null,
    author: "imported:Liv",
    body: `comment ${num}`,
    anchor_start: null,
    anchor_end: null,
    anchor_quote: quote,
    resolved: false,
    mentions: [],
    created_at: "2025-03-01T09:00:00Z",
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
let view: EditorView;
let ctx!: ReturnType<typeof useComments>;

function Probe() {
  ctx = useComments();
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no scrollIntoView.
  HTMLElement.prototype.scrollIntoView = scrolled;
  caret.length = 0;
  highlight.flashNum = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  view.destroy();
  host.remove();
  vi.clearAllMocks();
});

async function mount(comments: Comment[]) {
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment("default");
  applyMarkdownToYXmlFragment(frag, PROSE);
  view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ schema: getStugaSchema(), plugins: [ySyncPlugin(frag), commentHighlightPlugin({ ydoc }, highlight)] }),
  });
  shared.editor = editorOver(view);
  shared.comments = comments;
  await act(async () => {
    root = createRoot(host);
    root.render(
      <CommentsProvider docId="d1" ydoc={ydoc} onReveal={onReveal}>
        <Probe />
      </CommentsProvider>,
    );
  });
}

/** Click a comment, and let the frame that scrolls to it run while the view is alive. */
async function click(num: number) {
  await act(async () => ctx.clickComment(num));
  await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
}

describe("clickComment", () => {
  it("jumps to the one place an unanchored comment's quote occurs", async () => {
    await mount([imported(3, "brown fox")]);
    await click(3);
    expect(onReveal).toHaveBeenCalledWith(3);
    expect(caret).toEqual([1 + PROSE.indexOf("brown fox")]);
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("flashes a resolved one, as it does an anchored thread", async () => {
    await mount([imported(3, "lazy dog", { resolved: true })]);
    await click(3);
    expect(caret).toEqual([1 + PROSE.indexOf("lazy dog")]);
    expect(highlight.flashNum).toBe(3);
  });

  it("reveals an unplaced one in the panel and leaves the caret alone", async () => {
    // "he" occurs twice, so the quote does not say where.
    await mount([imported(3, "he"), imported(4, "not in the text")]);
    await click(3);
    await click(4);
    expect(onReveal.mock.calls).toEqual([[3], [4]]);
    expect(caret).toEqual([]);
    expect(scrolled).not.toHaveBeenCalled();
    expect(highlight.flashNum).toBeNull();
  });
});
