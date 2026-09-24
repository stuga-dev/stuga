// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Comment } from "../api";

const ctx = vi.hoisted(() => ({
  comments: [] as Comment[],
  activeNum: null as number | null,
  clickComment: vi.fn(),
  resolve: vi.fn(),
  del: vi.fn(),
  reply: vi.fn(async () => true),
  reload: vi.fn(),
}));

vi.mock("../comments/comments-context", () => ({ useComments: () => ctx }));
vi.mock("../state/identity", () => ({
  authorLabel: (a: string) => a,
  principalName: (p: string) => p,
  useUserNames: () => new Map<string, string>(),
  rememberUsers: () => {},
  Avatar: () => null,
}));
vi.mock("../api", () => ({ Docs: { addComment: vi.fn() } }));

const { CommentsPanel } = await import("./CommentsPanel");

function comment(num: number, over: Partial<Comment> = {}): Comment {
  return {
    num,
    doc_id: "doc1",
    parent_num: null,
    author: "alice",
    body: `comment ${num}`,
    anchor_start: null,
    anchor_end: null,
    anchor_quote: null,
    resolved: false,
    mentions: [],
    created_at: "2026-09-05T00:00:00Z",
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
const scrollIntoView = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no scrollIntoView; record the element it is called on.
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, ...args: unknown[]) {
    scrollIntoView(this, ...args);
  } as HTMLElement["scrollIntoView"];
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => {
    root = createRoot(host);
    root.render(<CommentsPanel docId="doc1" />);
  });
}

describe("CommentsPanel follows the active comment", () => {
  it("scrolls the active thread into view on mount", async () => {
    ctx.comments = [comment(1), comment(2), comment(3)];
    ctx.activeNum = 2;

    await mount();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const target = scrollIntoView.mock.calls[0]![0] as HTMLElement;
    expect(target.classList.contains("comment-item")).toBe(true);
    expect(target.classList.contains("active")).toBe(true);
    expect(target.textContent).toContain("comment 2");
  });

  it("targets the thread root when the active comment is a reply", async () => {
    ctx.comments = [comment(1), comment(2), comment(3, { parent_num: 1 })];
    ctx.activeNum = 3;

    await mount();

    const target = scrollIntoView.mock.calls[0]![0] as HTMLElement;
    expect(target.textContent).toContain("comment 1");
  });

  it("unhides the resolved list when the active thread is resolved, then scrolls to it", async () => {
    ctx.comments = [comment(1), comment(2, { resolved: true })];
    ctx.activeNum = 2;

    await mount();

    expect(host.textContent).toContain("Hide 1 resolved");
    const target = scrollIntoView.mock.calls.at(-1)![0] as HTMLElement;
    expect(target.classList.contains("resolved")).toBe(true);
    expect(target.textContent).toContain("comment 2");
  });

  it("does nothing without an active comment", async () => {
    ctx.comments = [comment(1)];
    ctx.activeNum = null;

    await mount();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("resolved");
  });
});
