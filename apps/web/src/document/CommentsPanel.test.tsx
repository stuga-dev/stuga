// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Comment, UserInfo } from "../api";

const ctx = vi.hoisted(() => ({
  comments: [] as Comment[],
  activeNum: null as number | null,
  clickComment: vi.fn(),
  resolve: vi.fn(),
  del: vi.fn(),
  reply: vi.fn(async () => true),
  reload: vi.fn(),
}));

const users = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("../comments/comments-context", () => ({ useComments: () => ctx }));
vi.mock("../api", () => ({ Docs: { addComment: vi.fn() }, Users: users }));

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
  users.resolve.mockReset().mockResolvedValue({ users: [] });
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

// The name cache lives for the file, so each case names its own people.
describe("CommentsPanel: the quoted passage", () => {
  it("takes its own text's direction, so an Arabic quote is marked where it starts", async () => {
    ctx.comments = [comment(1, { anchor_quote: "نص مقتبس" })];
    ctx.activeNum = null;

    await mount();

    const quote = host.querySelector<HTMLButtonElement>(".comment-quote")!;
    expect(quote.textContent).toBe("“نص مقتبس”");
    expect(quote.dir).toBe("auto");
  });
});

describe("CommentsPanel: authors", () => {
  const ada: UserInfo = { alias: "u_QH52ada7RzkP4mXe", username: "ada", display_name: "Ada", email: null };
  const bob: UserInfo = { alias: "u_Bb81bob4TqeW9nJs", username: "bob", display_name: "Bob", email: null };
  /** The name heading each comment, root first. */
  const authors = () => [...host.querySelectorAll(".comment-head strong")].map((s) => s.textContent);

  it("falls back to the short id once the lookup fails", async () => {
    users.resolve.mockRejectedValue(new Error("offline"));
    ctx.comments = [comment(1, { author: "u_Kcjz0unreachable" })];
    ctx.activeNum = null;

    await mount();

    expect(users.resolve).toHaveBeenCalledTimes(1);
    expect(authors()).toEqual(["u_Kcjz…"]);
  });

  it("shows no raw id while names load, then the names", async () => {
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    ctx.comments = [comment(1, { author: ada.alias }), comment(2, { parent_num: 1, author: bob.alias })];
    ctx.activeNum = null;

    await mount();

    expect(users.resolve).toHaveBeenCalledWith([ada.alias, bob.alias]);
    // Blanks that keep the heading's height.
    expect(authors()).toEqual(["\u00a0", "\u00a0"]);
    expect(host.textContent).not.toMatch(/u_QH52|u_Bb81/);

    await act(async () => answer({ users: [ada, bob] }));
    expect(authors()).toEqual(["Ada", "Bob"]);
  });

  it("names an imported author as the archive did, with no lookup, and shows no storage prefix on hover", async () => {
    ctx.comments = [comment(1, { author: "imported:Liv" }), comment(2, { parent_num: 1, author: "imported:Ops team" })];
    ctx.activeNum = null;

    await mount();

    expect(users.resolve).not.toHaveBeenCalled();
    expect(authors()).toEqual(["Liv · imported", "Ops team · imported"]);
    expect([...host.querySelectorAll(".comment-head strong")].map((s) => s.getAttribute("title"))).toEqual([null, null]);
    // Isolated from the marker, so a direction mark in the name cannot turn it around.
    expect([...host.querySelectorAll(".comment-head strong > bdi")].map((b) => b.textContent)).toEqual(["Liv", "Ops team"]);
  });

  it("names Sample agent, which posts a sample's comment, as the rest of the app does", async () => {
    ctx.comments = [comment(1, { author: "agent-sample" })];
    ctx.activeNum = null;

    await mount();

    expect(authors()).toEqual(["Sample agent"]);
    expect(host.querySelector(".comment-head strong")!.getAttribute("title")).toBe("agent-sample");
  });

  it("names an agent by its whole id at once, while a person's name loads", async () => {
    const eve: UserInfo = { alias: "u_Ev3eLm0pQr8sTu2V", username: "eve", display_name: "Eve", email: null };
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    ctx.comments = [comment(1, { author: "agent-conn-AbCdEf123456" }), comment(2, { parent_num: 1, author: eve.alias })];
    ctx.activeNum = null;

    await mount();

    expect(authors()).toEqual(["agent-conn-AbCdEf123456", "\u00a0"]);
    await act(async () => answer({ users: [eve] }));
    expect(authors()).toEqual(["agent-conn-AbCdEf123456", "Eve"]);
  });
});
