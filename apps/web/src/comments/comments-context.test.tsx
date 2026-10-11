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
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { CommentsProvider, useComments } = await import("./comments-context");
const { CommentDeepLink } = await import("./CommentDeepLink");
const { MemoryRouter, useLocation, useNavigate } = await import("react-router-dom");
const { toasts } = await import("../test/toast");
const { Docs } = await import("../api");
import type { StugaProvider } from "../sync/stuga-provider";
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
    // As Tiptap's: a destroyed view has no docView.
    get isDestroyed() {
      return !(view as unknown as { docView: unknown }).docView;
    },
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

/** Stands in for the document's socket: the slot the provider calls when the comments changed. */
const socket = { commentsListener: null as (() => void) | null };
let path = "";
let navigate: (to: string) => void = () => {};

function PathProbe() {
  const loc = useLocation();
  path = `${loc.pathname}${loc.search}`;
  navigate = useNavigate();
  return null;
}

async function mount(comments: Comment[], url?: string) {
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
      <MemoryRouter initialEntries={[url ?? "/doc/d1"]}>
        <CommentsProvider docId="d1" ydoc={ydoc} provider={socket as unknown as StugaProvider} onReveal={onReveal}>
          <Probe />
          <CommentDeepLink ready />
          <PathProbe />
        </CommentsProvider>
      </MemoryRouter>,
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

describe("comments that change elsewhere", () => {
  it("re-reads them when the document's socket says they changed", async () => {
    await mount([]);
    expect(ctx.comments).toEqual([]);
    shared.comments = [imported(3, "brown fox")];
    await act(async () => socket.commentsListener!());
    expect(ctx.comments.map((c) => c.num)).toEqual([3]);
  });

  it("asks once more after a read in flight, rather than once per word", async () => {
    await mount([]);
    vi.mocked(Docs.comments).mockClear();
    await act(async () => {
      socket.commentsListener!();
      socket.commentsListener!();
      socket.commentsListener!();
    });
    expect(Docs.comments).toHaveBeenCalledTimes(2);
  });
});

describe("a link to one comment", () => {
  beforeEach(() => {
    toasts.shown = [];
  });

  it("opens the thread a reply belongs to, then drops the parameter", async () => {
    await mount([imported(3, "brown fox"), imported(4, "", { parent_num: 3, anchor_quote: null })], "/doc/d1?comment=4");
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(onReveal).toHaveBeenCalledWith(3);
    expect(caret).toEqual([1 + PROSE.indexOf("brown fox")]);
    expect(path).toBe("/doc/d1");
  });

  it("says the comment was deleted when it is gone", async () => {
    await mount([imported(3, "brown fox")], "/doc/d1?comment=9");
    expect(onReveal).not.toHaveBeenCalled();
    expect(toasts.shown).toEqual([{ body: "That comment was deleted.", type: "info" }]);
    expect(path).toBe("/doc/d1");
  });

  it("reads afresh for a second link to the same comment, which was deleted since", async () => {
    await mount([imported(3, "brown fox")], "/doc/d1?comment=3");
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(onReveal).toHaveBeenCalledWith(3);
    shared.comments = [];
    await act(async () => navigate("/doc/d1?comment=3"));
    expect(toasts.shown).toEqual([{ body: "That comment was deleted.", type: "info" }]);
    expect(path).toBe("/doc/d1");
  });
});
