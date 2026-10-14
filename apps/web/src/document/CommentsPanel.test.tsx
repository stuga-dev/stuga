// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Comment, CommentAgents, UserInfo } from "../api";
import type { ThreadTurn } from "../ai/ai-coauthor-context";
import { mountInto, typeInto } from "../test/form-input";

/** The person reading, whose co-author writes as `panel:` them. */
const ME = "u_Me11liv3RtqW9nJs";

const ctx = vi.hoisted(() => ({
  comments: [] as Comment[],
  agents: {} as CommentAgents,
  canManage: false,
  activeNum: null as number | null,
  clickComment: vi.fn(),
  resolve: vi.fn(),
  del: vi.fn(),
  reply: vi.fn(async (_parent: number, _body: string): Promise<Comment | null> => null),
  reload: vi.fn(),
}));

const users = vi.hoisted(() => ({ resolve: vi.fn() }));

/** The page's co-author, or null where the page has none. */
const coauthor = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock("../comments/comments-context", () => ({ useComments: () => ctx }));
vi.mock("../ai/ai-coauthor-context", () => ({ useOptionalAiCoauthor: () => coauthor.current }));
vi.mock("../api", () => ({ Docs: { addComment: vi.fn() }, Users: users }));
vi.mock(import("../lib/http/client"), async (importOriginal) => ({ ...(await importOriginal()), getAlias: () => ME }));

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
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; record the element it is called on.
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, ...args: unknown[]) {
    scrollIntoView(this, ...args);
  } as HTMLElement["scrollIntoView"];
  users.resolve.mockReset().mockResolvedValue({ users: [] });
  ctx.agents = {};
  ctx.canManage = false;
  coauthor.current = null;
});

async function mount(props: { canAskAi?: boolean } = {}) {
  ({ host, root } = mountInto());
  await act(async () => {
    root.render(<CommentsPanel docId="doc1" {...props} />);
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

  it("names a co-author's comment with its person, looked up as the person, and gives the person's alias on hover", async () => {
    const liv: UserInfo = { alias: "u_L1vQr8sTu2VEv3eM", username: "liv", display_name: "Liv", email: null };
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    ctx.comments = [comment(1, { author: `panel:${liv.alias}` })];
    ctx.activeNum = null;

    await mount();

    expect(users.resolve).toHaveBeenCalledWith([liv.alias]);
    expect(authors()).toEqual(["\u00a0"]);
    await act(async () => answer({ users: [liv] }));
    expect(authors()).toEqual(["AI co-author · Liv"]);
    expect(host.querySelector(".comment-head strong > bdi")!.textContent).toBe("Liv");
    expect(host.querySelector(".comment-head strong")!.getAttribute("title")).toBe(liv.alias);
  });

  it("names an agent by the person it acts for, looked up as the person, and gives the agent's id on hover", async () => {
    const eve: UserInfo = { alias: "u_Ev3eLm0pQr8sTu2V", username: "eve", display_name: "Eve", email: null };
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    ctx.comments = [comment(1, { author: "agent-conn-AbCdEf123456" }), comment(2, { parent_num: 1, author: eve.alias })];
    ctx.agents = { "agent-conn-AbCdEf123456": eve.alias };
    ctx.activeNum = null;

    await mount();

    // The agent's id is no account to look up.
    expect(users.resolve).toHaveBeenCalledWith([eve.alias]);
    expect(authors()).toEqual(["\u00a0", "\u00a0"]);
    await act(async () => answer({ users: [eve] }));
    expect(authors()).toEqual(["Eve’s agent", "Eve"]);
    expect(host.querySelector(".comment-head strong > bdi")!.textContent).toBe("Eve");
    expect(host.querySelector(".comment-head strong")!.getAttribute("title")).toBe("agent-conn-AbCdEf123456");
  });

  it("names an agent whose person the node cannot say as an agent, with no lookup", async () => {
    ctx.comments = [comment(1, { author: "agent-key-Zz9" })];
    ctx.agents = { "agent-key-Zz9": null };
    ctx.activeNum = null;

    await mount();

    expect(users.resolve).not.toHaveBeenCalled();
    expect(authors()).toEqual(["Agent"]);
    expect(host.querySelector(".comment-head strong")!.getAttribute("title")).toBe("agent-key-Zz9");
  });
});

describe("CommentsPanel: who may resolve or delete", () => {
  const BOB = "u_Bb81bob4TqeW9nJs";
  /** Each comment's actions, by its text: a thread's root first, then its replies. */
  const actions = () =>
    Object.fromEntries(
      [...host.querySelectorAll(".comment-item > .comment-head, .comment-reply > .comment-head")].map((head) => [
        head.parentElement!.querySelector(":scope > .comment-text")!.textContent,
        [...head.querySelectorAll(".comment-actions button")].map((b) => b.getAttribute("aria-label") ?? b.textContent),
      ]),
    );

  it("offers them on what the reader or their co-author wrote, and on no one else's", async () => {
    ctx.comments = [
      comment(1, { author: ME }),
      comment(2, { parent_num: 1, author: BOB }),
      comment(3, { parent_num: 1, author: `panel:${ME}` }),
      comment(4, { author: BOB }),
      comment(5, { parent_num: 4, author: ME }),
      comment(6, { author: `panel:${BOB}` }),
    ];
    ctx.activeNum = null;

    await mount();

    expect(actions()).toEqual({
      "comment 1": ["Resolve", "Delete comment"],
      "comment 2": [],
      "comment 3": ["Delete reply"],
      "comment 4": [],
      "comment 5": ["Delete reply"],
      "comment 6": [],
    });
  });

  it("offers Reopen only to whoever may resolve the thread", async () => {
    ctx.comments = [comment(1, { author: BOB, resolved: true }), comment(2, { author: ME, resolved: true })];
    ctx.activeNum = 1;

    await mount();

    expect(actions()).toEqual({ "comment 1": [], "comment 2": ["Reopen", "Delete comment"] });
  });

  it("offers them on every comment to a reader who manages the document", async () => {
    ctx.comments = [comment(1, { author: BOB }), comment(2, { parent_num: 1, author: "agent-key-Zz9" }), comment(3, { author: "imported:Liv" })];
    ctx.canManage = true;
    ctx.activeNum = null;

    await mount();

    expect(actions()).toEqual({
      "comment 1": ["Resolve", "Delete comment"],
      "comment 2": ["Delete reply"],
      "comment 3": ["Resolve", "Delete comment"],
    });
  });
});

/** A co-author that can take a turn, with these thread turns. */
function aiWith(threadTurns: Map<number, ThreadTurn> = new Map(), over: Record<string, unknown> = {}) {
  const ai = {
    available: true,
    threadTurns,
    answerInThread: vi.fn(),
    retryThread: vi.fn(),
    clearThread: vi.fn(),
    showPanel: vi.fn(),
    ...over,
  };
  coauthor.current = ai;
  return ai;
}

const replyBox = () => host.querySelector<HTMLTextAreaElement>(".comment-reply-box textarea")!;
const sendToAi = () => host.querySelector<HTMLInputElement>('.comment-reply-box input[type="checkbox"]');
const focusReply = () => act(async () => replyBox().focus());
const pressEnter = () =>
  act(async () => {
    replyBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

describe("CommentsPanel: Send to AI", () => {
  it("is offered under a reply box in use, only where the co-author can take a turn", async () => {
    ctx.comments = [comment(1)];
    ctx.activeNum = null;

    aiWith();
    await mount({ canAskAi: true });
    expect(sendToAi()).toBeNull();
    await focusReply();
    expect(sendToAi()).not.toBeNull();
    expect(sendToAi()!.checked).toBe(false);
    expect(host.querySelector(".comment-reply-box")!.textContent).toContain("Send to AI");
  });

  it("is not offered to a reader, nor while AI chat is off", async () => {
    ctx.comments = [comment(1)];
    ctx.activeNum = null;

    aiWith();
    await mount({ canAskAi: false });
    await focusReply();
    expect(sendToAi()).toBeNull();

    aiWith(new Map(), { available: false });
    await mount({ canAskAi: true });
    await focusReply();
    expect(sendToAi()).toBeNull();
  });

  it("is ticked when the person's own co-author spoke last, and the reply then goes to it", async () => {
    ctx.comments = [
      comment(1, { author: "u_Bb81bob4TqeW9nJs", anchor_quote: "the bathtub" }),
      comment(2, { parent_num: 1, author: `panel:${ME}`, body: "Built-in or freestanding?" }),
    ];
    ctx.activeNum = null;
    ctx.reply.mockResolvedValue(comment(3, { parent_num: 1, author: ME, body: "Freestanding." }));
    const ai = aiWith();

    await mount({ canAskAi: true });
    await focusReply();
    expect(sendToAi()!.checked).toBe(true);
    await typeInto(replyBox(), "Freestanding.");
    await pressEnter();

    expect(ctx.reply).toHaveBeenCalledWith(1, "Freestanding.");
    expect(ai.answerInThread).toHaveBeenCalledWith(1, 3, "Freestanding.", "the bathtub");
  });

  it("keeps a reply from the AI when unticked, then goes back to its default", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: `panel:${ME}` })];
    ctx.activeNum = null;
    ctx.reply.mockResolvedValue(comment(3, { parent_num: 1, author: ME }));
    const ai = aiWith();

    await mount({ canAskAi: true });
    await focusReply();
    await act(async () => sendToAi()!.click());
    expect(sendToAi()!.checked).toBe(false);
    await typeInto(replyBox(), "Never mind.");
    await pressEnter();

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ai.answerInThread).not.toHaveBeenCalled();
    expect(sendToAi()!.checked).toBe(true);
  });

  it("keeps the default it had when the draft started, though a reply lands meanwhile", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: `panel:${ME}`, body: "Built-in or freestanding?" })];
    ctx.activeNum = null;
    ctx.reply.mockResolvedValue(comment(4, { parent_num: 1, author: ME, body: "Freestanding." }));
    const ai = aiWith();

    await mount({ canAskAi: true });
    await focusReply();
    await typeInto(replyBox(), "Freestanding.");
    ctx.comments = [...ctx.comments, comment(3, { parent_num: 1, author: "u_Bb81bob4TqeW9nJs" })];
    await act(async () => root.render(<CommentsPanel docId="doc1" canAskAi />));
    expect(sendToAi()!.checked).toBe(true);
    await pressEnter();
    expect(ai.answerInThread).toHaveBeenCalledWith(1, 4, "Freestanding.", null);

    // Sent, the box takes the thread's default again.
    expect(sendToAi()!.checked).toBe(false);
  });

  it("doesn't tick itself when the co-author answers mid-draft", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: "u_Bb81bob4TqeW9nJs" })];
    ctx.activeNum = null;
    ctx.reply.mockResolvedValue(comment(4, { parent_num: 1, author: ME, body: "Agreed." }));
    const ai = aiWith();

    await mount({ canAskAi: true });
    await focusReply();
    await typeInto(replyBox(), "Agreed.");
    ctx.comments = [...ctx.comments, comment(3, { parent_num: 1, author: `panel:${ME}` })];
    await act(async () => root.render(<CommentsPanel docId="doc1" canAskAi />));
    expect(sendToAi()!.checked).toBe(false);
    await pressEnter();
    expect(ctx.reply).toHaveBeenCalledWith(1, "Agreed.");
    expect(ai.answerInThread).not.toHaveBeenCalled();
  });

  it("sends nothing to the AI when the reply was not saved", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: `panel:${ME}` })];
    ctx.activeNum = null;
    ctx.reply.mockResolvedValue(null);
    const ai = aiWith();

    await mount({ canAskAi: true });
    await focusReply();
    await typeInto(replyBox(), "Freestanding.");
    await pressEnter();

    expect(ai.answerInThread).not.toHaveBeenCalled();
    expect(replyBox().value).toBe("Freestanding.");
  });
});

describe("CommentsPanel: how a reply sent to the AI stands", () => {
  const status = () => host.querySelector(".comment-ai-status");
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".comment-ai-status button")].find((b) => b.textContent === label);

  it("says it is working, and opens the AI tab from there", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: ME })];
    ctx.activeNum = null;
    const ai = aiWith(new Map([[1, { state: "working", replyNum: 2 }]]));

    await mount({ canAskAi: true });
    await act(async () => button("Working…")!.click());
    expect(ai.showPanel).toHaveBeenCalledTimes(1);
  });

  it("says it is waiting, or why it was not sent, with Retry where retrying helps", async () => {
    ctx.comments = [comment(1), comment(2), comment(3), comment(4), comment(5)];
    ctx.activeNum = null;
    const ai = aiWith(
      new Map<number, ThreadTurn>([
        [1, { state: "queued", replyNum: 6 }],
        [2, { state: "failed", replyNum: 7, retry: true }],
        [3, { state: "dropped", replyNum: 8, retry: true }],
        [4, { state: "failed", replyNum: 9, message: "This comment thread was resolved or deleted.", retry: false }],
        [5, { state: "failed", replyNum: 10, message: "The AI turn failed.", retry: true }],
      ]),
    );

    await mount({ canAskAi: true });
    const lines = [...host.querySelectorAll(".comment-ai-status")].map((l) => l.textContent);
    expect(lines).toEqual([
      "Waiting for the AI…",
      "Couldn’t send to AI.Retry",
      "Connection lost. The AI may still be working.Retry",
      "This comment thread was resolved or deleted.",
      "The AI turn failed.Retry",
    ]);
    const retries = [...host.querySelectorAll<HTMLButtonElement>(".comment-ai-status button")];
    await act(async () => retries[1]!.click());
    expect(ai.retryThread).toHaveBeenCalledWith(3);
  });

  it("clears once the answer is in the thread", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: ME }), comment(3, { parent_num: 1, author: `panel:${ME}` })];
    ctx.activeNum = null;
    const ai = aiWith(new Map([[1, { state: "working", replyNum: 2, replied: 3 }]]));

    await mount({ canAskAi: true });
    expect(status()).toBeNull();
    expect(ai.clearThread).toHaveBeenCalledWith(1, 2);
  });

  it("clears a turn whose connection dropped once the co-author's answer is in the thread", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: ME }), comment(3, { parent_num: 1, author: `panel:${ME}` })];
    ctx.activeNum = null;
    const ai = aiWith(new Map([[1, { state: "dropped", replyNum: 2, retry: true }]]));

    await mount({ canAskAi: true });
    expect(status()).toBeNull();
    expect(ai.clearThread).toHaveBeenCalledWith(1, 2);
  });

  it("keeps a dropped turn whose thread holds only an earlier answer", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: `panel:${ME}` }), comment(3, { parent_num: 1, author: ME })];
    ctx.activeNum = null;
    const ai = aiWith(new Map([[1, { state: "dropped", replyNum: 3, retry: true }]]));

    await mount({ canAskAi: true });
    expect(status()!.textContent).toBe("Connection lost. The AI may still be working.Retry");
    expect(ai.clearThread).not.toHaveBeenCalled();
  });

  it("speaks the line in the thread's live region, there before the first state", async () => {
    ctx.comments = [comment(1), comment(2)];
    ctx.activeNum = null;
    aiWith(new Map([[2, { state: "queued", replyNum: 3 }]]));
    const regions = () => [...host.querySelectorAll('.comment-item > [role="status"]')].map((r) => r.textContent);

    await mount({ canAskAi: true });
    expect(regions()).toEqual(["", "Waiting for the AI…"]);
    expect(host.querySelector(".comment-ai-status[role]")).toBeNull();

    await mount({ canAskAi: false });
    expect(regions()).toEqual([]);
  });

  it("still reads as working while the answer is on its way to the list", async () => {
    ctx.comments = [comment(1), comment(2, { parent_num: 1, author: ME })];
    ctx.activeNum = null;
    const ai = aiWith(new Map([[1, { state: "working", replyNum: 2, replied: 3 }]]));

    await mount({ canAskAi: true });
    expect(button("Working…")).toBeDefined();
    expect(ai.clearThread).not.toHaveBeenCalled();
  });
});
