/**
 * The one way a comment is posted: what each kind of writer may mention, who hears of it and as
 * whom, how an agent's quote is anchored, and the hourly allowance on an agent's notices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  addComment: vi.fn(),
  getComment: vi.fn(),
  listComments: vi.fn(),
  getMembersByUsername: vi.fn(),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
  getUserDisplayName: vi.fn(),
  agentOwners: vi.fn(),
}));

const { addComment, getComment, listComments, getMembersByUsername, getMemberRole, getUserDisplayName, agentOwners } = await import("@stuga/db");
import type { CommentRow, DocRow } from "@stuga/db";
import type { NotifyMessage } from "@stuga/protocol/internal/jobs";
import { SAMPLE_AGENT_ALIAS } from "@stuga/protocol/domain/workspaces";
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";
import { panelCtx } from "../internal/panel.js";
import { actorsAnswering, agentCtx, personCtx, recordingJobs, type CtxOverrides } from "../testing/ctx.js";
import { agentBudgetKey, agentNoticeBudget } from "./budget.js";
import {
  AGENT_PLACES_BY_QUOTE,
  DOCUMENT_BUSY,
  QUOTE_ANCHOR_WAIT_MS,
  QUOTE_NOT_ONCE,
  commentCaller,
  commentInput,
  postComment,
  type CommentRequest,
} from "./post.js";

/** Liv, Bob, Cy and Dee are members; Gus is a guest, who cannot open DOC; the owner owns it. */
const MEMBERS: Record<string, { alias: string; role: string | null; name: string }> = {
  liv: { alias: "u_liv", role: "member", name: "Liv" },
  bob: { alias: "u_bob", role: "member", name: "Bob" },
  cy: { alias: "u_cy", role: "member", name: "Cy" },
  dee: { alias: "u_dee", role: "member", name: "Dee" },
  eve: { alias: "u_eve", role: "member", name: "Eve" },
  gus: { alias: "u_gus", role: "guest", name: "Gus" },
  owner: { alias: "u_owner", role: "owner", name: "Olu" },
};
const byAlias = (alias: string) => Object.values(MEMBERS).find((m) => m.alias === alias);

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:u_owner",
  title: "Renovation",
  doc_type: "prose",
  parent_id: null,
  trashed: false,
  acl_principals: ["org:ws1"],
  acl_writers: ["org:ws1"],
  acl_commenters: [],
} as unknown as DocRow;

function row(num: number, parent_num: number | null, author: string, over: Partial<CommentRow> = {}): CommentRow {
  return {
    doc_id: "d1",
    num,
    parent_num,
    author,
    body: `comment ${num}`,
    anchor_start: null,
    anchor_end: null,
    anchor_quote: null,
    resolved: false,
    reactions: {},
    mentions: [],
    created_at: `2026-10-0${num}T10:00:00Z`,
    updated_at: `2026-10-0${num}T10:00:00Z`,
    ...over,
  };
}

/** Thread 1 is Liv's; thread 7 is Dee's co-author's question. Agent 9 has no person until a test gives it one. */
let comments: CommentRow[];
let jobs: ReturnType<typeof recordingJobs>;
const actorFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
const env = () => ({ jobs, docs: actorsAnswering(actorFetch) });

const person = (alias: string, displayName: string, over: CtxOverrides = {}): Ctx => personCtx({ alias, displayName, env: env(), ...over });
/** An agent of `onBehalfOf`, whose client calls it something else entirely. */
const agent = (over: CtxOverrides = {}): Ctx => agentCtx({ alias: "agent-7", onBehalfOf: "u_liv", displayName: "Totally Bob", env: env(), ...over });
const coauthor = (alias = "u_liv"): Ctx =>
  panelCtx({ sql: {}, jobs, docs: actorsAnswering(actorFetch), publicOrigin: "https://stuga.test" } as unknown as NodeEnv, {
    workspaceId: "ws1",
    principals: [`user:${alias}`, "org:ws1"],
    alias,
  })!;

const request = (body: string, over: Partial<CommentRequest> = {}): CommentRequest => ({
  body,
  parentNum: null,
  anchorStart: null,
  anchorEnd: null,
  anchorQuote: null,
  ...over,
});

const notices = () => jobs.sent().filter((m) => m.kind === "notify") as unknown as NotifyMessage[];
const told = () => notices().map((n) => [n.recipient, n.eventType, "relation" in n.params ? n.params.relation : undefined]);
const pagesTold = () => actorFetch.mock.calls.filter(([url]) => url.includes("/comments-changed")).length;

beforeEach(() => {
  vi.clearAllMocks();
  jobs = recordingJobs();
  comments = [
    row(1, null, "u_liv"),
    row(2, 1, "u_bob"),
    row(3, 1, "agent-9"),
    row(4, 1, "imported:Old Name"),
    row(5, 1, "panel:u_cy"),
    row(6, 1, "u_gus"),
    row(7, null, "panel:u_dee"),
  ];
  vi.mocked(getComment).mockImplementation(async (_sql, _doc, num) => comments.find((c) => c.num === num) ?? null);
  vi.mocked(listComments).mockImplementation(async () => comments);
  vi.mocked(addComment).mockImplementation(async (_sql, input) => {
    const c = row(9, input.parentNum ?? null, input.author, { body: input.body, mentions: input.mentions ?? [], created_at: "2026-10-09T10:00:00Z" });
    comments.push(c);
    return c;
  });
  vi.mocked(getMembersByUsername).mockImplementation(async (_sql, usernames) =>
    usernames.flatMap((u) => (MEMBERS[u] ? [{ alias: MEMBERS[u]!.alias, username: u }] : [])),
  );
  vi.mocked(getMemberRole).mockImplementation(async (_sql, _ws, alias) => (byAlias(alias)?.role ?? null) as never);
  vi.mocked(getUserDisplayName).mockImplementation(async (_sql, alias) => byAlias(alias)?.name ?? null);
  vi.mocked(agentOwners).mockResolvedValue(new Map());
});

describe("commentInput", () => {
  it("takes a passage's text as `quote`, held to a stored quote's length", () => {
    expect(commentInput({ body: "Here.", quote: "bathtub" })).toMatchObject({ quote: "bathtub" });
    expect(commentInput({ body: "Here.", quote: null })).not.toHaveProperty("quote");
    expect(commentInput({ body: "Here." })).not.toHaveProperty("quote");
    expect(commentInput({ body: "Here.", quote: "" })).toBe("invalid quote");
    expect(commentInput({ body: "Here.", quote: 7 })).toBe("invalid quote");
    expect(commentInput({ body: "Here.", quote: "x".repeat(2_001) })).toBe("quote too long");
  });
});

describe("commentCaller", () => {
  it("tells a person, an agent and a person's co-author apart", () => {
    expect(commentCaller(person("u_bob", "Bob"))).toBe("person");
    expect(commentCaller(agent())).toBe("agent");
    expect(commentCaller(coauthor())).toBe("coauthor");
  });
});

describe("an agent's comment", () => {
  it("refuses a sixth mention, and saves and sends nothing", async () => {
    const out = await postComment(agent(), DOC, request("@bob @cy @dee @eve @owner @liv, have a look"));
    expect(out).toEqual({ status: 400, error: "an agent's comment may mention at most 5 people" });
    expect(addComment).not.toHaveBeenCalled();
    expect(jobs.sent()).toEqual([]);
    // Usernames that name no member are not mentions.
    expect(await postComment(agent(), DOC, request("@bob @cy @dee @eve @owner @nobody @nobody2"))).toMatchObject({ suppressed: 0 });
  });

  it("names the agent by its person in every notice, never by its client's name", async () => {
    await postComment(agent(), DOC, request("@bob, the grout"));
    expect(notices()).toEqual([
      expect.objectContaining({ recipient: "u_bob", eventType: "MENTIONED_IN_COMMENT", actor: "agent-7", params: { actor: { agent_of: "Liv" }, doc: "Renovation", excerpt: "@bob, the grout" } }),
      expect.objectContaining({ recipient: "u_owner", eventType: "COMMENT_ON_OWNED_DOC", params: expect.objectContaining({ actor: { agent_of: "Liv" }, kind: "comment" }) }),
    ]);
    expect(JSON.stringify(jobs.sent())).not.toContain("Totally Bob");
  });

  it("names Sample agent as itself, as the comment shows it, not as its importer's agent", async () => {
    await postComment(agent({ alias: SAMPLE_AGENT_ALIAS, onBehalfOf: "u_liv" }), DOC, request("@liv, start here"));
    expect(notices()).toEqual([
      expect.objectContaining({ recipient: "u_liv", eventType: "MENTIONED_IN_COMMENT", params: expect.objectContaining({ actor: "Sample agent" }) }),
      expect.objectContaining({ recipient: "u_owner", eventType: "COMMENT_ON_OWNED_DOC", params: expect.objectContaining({ actor: "Sample agent" }) }),
    ]);
  });

  it("tells the document's open pages", async () => {
    await postComment(agent(), DOC, request("Noted."));
    expect(pagesTold()).toBe(1);
  });

  it("notifies the person it acts for as anyone else, since an agent often works while they are away", async () => {
    await postComment(agent({ onBehalfOf: "u_owner" }), DOC, request("@bob done"));
    expect(told()).toEqual([
      ["u_bob", "MENTIONED_IN_COMMENT", undefined],
      ["u_owner", "COMMENT_ON_OWNED_DOC", undefined],
    ]);
    jobs = recordingJobs();
    await postComment(agent({ onBehalfOf: "u_owner" }), DOC, request("@owner @bob done"));
    expect(told()).toEqual([
      ["u_owner", "MENTIONED_IN_COMMENT", undefined],
      ["u_bob", "MENTIONED_IN_COMMENT", undefined],
    ]);
  });

  it("holds the notices past its person's hour's allowance, and still saves the comment", async () => {
    const ctx = agent({ onBehalfOf: "u_dee" });
    expect(agentNoticeBudget.reserve(agentBudgetKey("ws1", "u_dee"), 59)).toBe(59);
    const out = await postComment(ctx, DOC, request("@bob see this"));
    expect(out).toMatchObject({ comment: { num: 9 }, suppressed: 1 });
    expect(told()).toEqual([["u_bob", "MENTIONED_IN_COMMENT", undefined]]);
    // Every agent of Dee's draws on the same allowance.
    const other = await postComment(agent({ alias: "agent-8", onBehalfOf: "u_dee" }), DOC, request("And again."));
    expect(other).toMatchObject({ suppressed: 1 });
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(notices()).toHaveLength(1);
  });

  it("is not held back by the allowance of another person's agents", async () => {
    agentNoticeBudget.reserve(agentBudgetKey("ws1", "u_eve"), 60);
    expect(await postComment(agent({ onBehalfOf: "u_cy" }), DOC, request("@bob ok"))).toMatchObject({ suppressed: 0 });
    expect(notices()).toHaveLength(2);
  });
});

describe("a reply", () => {
  it("notifies the root's author and the thread's earlier people, never an agent with no person, archives or someone who cannot read it", async () => {
    const out = await postComment(person("u_dee", "Dee"), DOC, request("Agreed.", { parentNum: 1 }));
    expect(out).toMatchObject({ suppressed: 0 });
    expect(told()).toEqual([
      ["u_liv", "COMMENT_REPLY", "comment"],
      ["u_bob", "COMMENT_REPLY", "thread"],
      ["u_cy", "COMMENT_REPLY", "thread"],
      ["u_owner", "COMMENT_ON_OWNED_DOC", undefined],
    ]);
    expect(notices()[0]).toMatchObject({
      commentNum: 9,
      actor: "u_dee",
      thread: `1@${Date.parse("2026-10-01T10:00:00Z")}`,
      params: { actor: "Dee", doc: "Renovation", excerpt: "Agreed.", relation: "comment" },
    });
    expect(notices()[3]).toMatchObject({ params: { kind: "reply" } });
  });

  it("records its event at the reply's own time, which the feed compares with its root's", async () => {
    await postComment(person("u_dee", "Dee"), DOC, request("Agreed.", { parentNum: 1 }));
    expect(jobs.sent().filter((m) => m.kind === "event")).toEqual([
      expect.objectContaining({ type: "comment.added", actor: "user:u_dee", at: "2026-10-09T10:00:00.000Z", payload: expect.objectContaining({ num: 9, parent_num: 1 }) }),
    ]);
  });

  it("never notifies the one replying", async () => {
    await postComment(person("u_bob", "Bob"), DOC, request("Freestanding, then.", { parentNum: 1 }));
    expect(told().map(([to]) => to)).toEqual(["u_liv", "u_cy", "u_owner"]);
  });

  it("attaches a reply to a reply to its thread's root", async () => {
    await postComment(person("u_dee", "Dee"), DOC, request("Yes.", { parentNum: 5 }));
    expect(vi.mocked(addComment).mock.calls[0]![1]).toMatchObject({ parentNum: 1 });
    expect(told()[0]).toEqual(["u_liv", "COMMENT_REPLY", "comment"]);
  });

  it("refuses a reply to a comment that is not there", async () => {
    expect(await postComment(person("u_dee", "Dee"), DOC, request("Yes.", { parentNum: 42 }))).toEqual({ status: 400, error: "parent comment not found" });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("tells a person a reply answers their co-author's question", async () => {
    await postComment(person("u_bob", "Bob"), DOC, request("Built-in.", { parentNum: 7 }));
    expect(told()).toEqual([
      ["u_dee", "COMMENT_REPLY", "coauthor_question"],
      ["u_owner", "COMMENT_ON_OWNED_DOC", undefined],
    ]);
  });

  it("gives each person one notice, a mention before a reply before the owner's", async () => {
    comments.push(row(8, 1, "panel:u_liv"));
    await postComment(person("u_dee", "Dee"), DOC, request("@liv @owner over to you", { parentNum: 1 }));
    expect(told()).toEqual([
      ["u_liv", "MENTIONED_IN_COMMENT", undefined],
      ["u_owner", "MENTIONED_IN_COMMENT", undefined],
      ["u_bob", "COMMENT_REPLY", "thread"],
      ["u_cy", "COMMENT_REPLY", "thread"],
    ]);
  });

  it("tells the person an agent works for of a reply to their agent's comment, or in a thread it wrote in", async () => {
    vi.mocked(agentOwners).mockResolvedValue(new Map([["agent-9", "u_eve"]]));
    comments.push(row(8, null, "agent-9"));
    await postComment(person("u_dee", "Dee"), DOC, request("Noted.", { parentNum: 8 }));
    expect(told()).toEqual([
      ["u_eve", "COMMENT_REPLY", "agent_comment"],
      ["u_owner", "COMMENT_ON_OWNED_DOC", undefined],
    ]);
    expect(vi.mocked(agentOwners).mock.calls[0]![1]).toEqual(["agent-9"]);
    jobs = recordingJobs();
    await postComment(person("u_dee", "Dee"), DOC, request("Agreed.", { parentNum: 1 }));
    expect(told()).toEqual([
      ["u_liv", "COMMENT_REPLY", "comment"],
      ["u_bob", "COMMENT_REPLY", "thread"],
      ["u_eve", "COMMENT_REPLY", "thread"],
      ["u_cy", "COMMENT_REPLY", "thread"],
      ["u_owner", "COMMENT_ON_OWNED_DOC", undefined],
    ]);
  });

  it("never tells a person of their own reply, or their co-author's, in a thread their agent started", async () => {
    vi.mocked(agentOwners).mockResolvedValue(new Map([["agent-9", "u_liv"]]));
    comments.push(row(8, null, "agent-9"));
    await postComment(person("u_liv", "Liv"), DOC, request("Thanks.", { parentNum: 8 }));
    await postComment(coauthor("u_liv"), DOC, request("Done.", { parentNum: 8, parentCreatedAt: "2026-10-08T10:00:00.000Z" }));
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(told()).toEqual([["u_owner", "COMMENT_ON_OWNED_DOC", undefined]]);
  });

  it("tells no one through an agent whose person cannot read the document, nor through Sample agent", async () => {
    vi.mocked(agentOwners).mockResolvedValue(new Map([["agent-9", "u_gus"]]));
    await postComment(person("u_dee", "Dee"), DOC, request("Agreed.", { parentNum: 1 }));
    expect(told().map(([to]) => to)).toEqual(["u_liv", "u_bob", "u_cy", "u_owner"]);
    jobs = recordingJobs();
    vi.mocked(agentOwners).mockClear();
    comments.push(row(8, null, SAMPLE_AGENT_ALIAS));
    await postComment(person("u_dee", "Dee"), DOC, request("Got it.", { parentNum: 8 }));
    expect(told()).toEqual([["u_owner", "COMMENT_ON_OWNED_DOC", undefined]]);
    expect(agentOwners).not.toHaveBeenCalled();
  });

  it("counts an agent's reply notices against its person's allowance", async () => {
    agentNoticeBudget.reserve(agentBudgetKey("ws1", "u_bob"), 58);
    const out = await postComment(agent({ onBehalfOf: "u_bob" }), DOC, request("Logged.", { parentNum: 1 }));
    // Bob is in the thread, and hears of his agent's reply as anyone in it does.
    expect(out).toMatchObject({ suppressed: 2 });
    expect(told()).toEqual([
      ["u_liv", "COMMENT_REPLY", "comment"],
      ["u_bob", "COMMENT_REPLY", "thread"],
    ]);
  });
});

describe("the owner", () => {
  it("hears nothing once they have left the workspace, whoever writes", async () => {
    const left = { ...DOC, owner: "user:u_gone" } as DocRow;
    await postComment(person("u_bob", "Bob"), left, request("The grout?"));
    await postComment(agent(), left, request("Logged."));
    await postComment(person("u_dee", "Dee"), left, request("Agreed.", { parentNum: 1 }));
    expect(notices().map((n) => n.recipient)).not.toContain("u_gone");
    expect(notices().filter((n) => n.eventType === "COMMENT_ON_OWNED_DOC")).toEqual([]);
  });
});

describe("the co-author", () => {
  it("asks without notifying anyone, resolving mentions or telling the pages", async () => {
    const out = await postComment(coauthor(), DOC, request("@bob: built-in or freestanding?"));
    expect(out).toMatchObject({ comment: { author: "panel:u_liv", mentions: [] }, suppressed: 0 });
    expect(getMembersByUsername).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    expect(pagesTold()).toBe(0);
  });

  it("answers in a thread, notifying its people as its person's AI co-author, but not its person or the owner", async () => {
    const out = await postComment(coauthor(), DOC, request("Done: the plinth line is gone.", { parentNum: 1, parentCreatedAt: "2026-10-01T10:00:00.000Z" }));
    expect(out).toMatchObject({ comment: { parent_num: 1 } });
    expect(told()).toEqual([
      ["u_bob", "COMMENT_REPLY", "thread"],
      ["u_cy", "COMMENT_REPLY", "thread"],
    ]);
    expect(notices()[0]).toMatchObject({ actor: "panel:u_liv", params: { actor: { coauthor_of: "Liv" } } });
    expect(pagesTold()).toBe(0);
  });

  it("finds a thread closed that was resolved, is a reply, or took a deleted root's number", async () => {
    const answer = (parentNum: number, parentCreatedAt: string) => postComment(coauthor(), DOC, request("Done.", { parentNum, parentCreatedAt }));
    expect(await answer(1, "2026-09-01T10:00:00.000Z")).toEqual({ status: 409, error: "thread closed" });
    expect(await answer(2, "2026-10-02T10:00:00.000Z")).toEqual({ status: 409, error: "thread closed" });
    comments[0] = { ...comments[0]!, resolved: true };
    expect(await answer(1, "2026-10-01T10:00:00.000Z")).toEqual({ status: 409, error: "thread closed" });
    expect(addComment).not.toHaveBeenCalled();
  });
});

describe("an agent's quote", () => {
  const anchorAnswer = (anchor: unknown) => actorFetch.mockImplementation(async () => Response.json({ anchor }));
  const quoted = (quote: string) => postComment(agent(), DOC, request("Built-in or freestanding?", { quote }));
  const lookups = () => actorFetch.mock.calls.filter(([url]) => url.includes("/quote-anchor")).length;

  /** A co-author turn on DOC's actor: lookups wait until `end`, then find the passage. */
  function holdActor(): { end: () => Promise<void> } {
    let open!: () => void;
    const ended = new Promise<void>((resolve) => {
      open = resolve;
    });
    actorFetch.mockImplementation(async (url) => {
      if (new URL(url).searchParams.get("docId") === "d1") await ended;
      return Response.json({ anchor: { start: "s1", end: "e1", quote: "bathtub" } });
    });
    return {
      end: async () => {
        open();
        // Let the waiting lookup settle and clear its document.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
  }

  afterEach(() => {
    actorFetch.mockReset().mockImplementation(async () => new Response(null, { status: 204 }));
  });

  it("anchors a new thread where the document's actor finds it", async () => {
    anchorAnswer({ start: "s1", end: "e1", quote: "bathtub" });
    expect(await quoted("bathtub")).toMatchObject({ suppressed: 0 });
    const [url, init] = actorFetch.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/quote-anchor");
    expect(new URL(url).searchParams.get("docId")).toBe("d1");
    expect(JSON.parse(String(init!.body))).toEqual({ quote: "bathtub" });
    expect(vi.mocked(addComment).mock.calls[0]![1]).toMatchObject({ anchorStart: "s1", anchorEnd: "e1", anchorQuote: "bathtub" });
  });

  it("refuses a quote that is not in the text exactly once, exactly as written, and pinned at both ends", async () => {
    for (const anchor of [null, { start: "s1", end: "e1", quote: "it’s built in" }, { start: null, end: null, quote: "it's built in" }]) {
      anchorAnswer(anchor);
      expect(await quoted("it's built in")).toEqual({ status: 400, error: QUOTE_NOT_ONCE });
    }
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses an agent's positions, which would pin its comment wherever they point, and saves nothing", async () => {
    for (const over of [{ anchorStart: "s1", anchorEnd: "e1", anchorQuote: "bathtub" }, { anchorStart: "s1" }, { anchorEnd: "e1", quote: "bathtub" }]) {
      expect(await postComment(agent(), DOC, request("Here.", over))).toEqual({ status: 400, error: AGENT_PLACES_BY_QUOTE });
    }
    expect(actorFetch).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it("finds an agent's `anchor_quote` as strictly as its quote", async () => {
    anchorAnswer({ start: "s1", end: "e1", quote: "bathtub" });
    expect(await postComment(agent(), DOC, request("Here.", { anchorQuote: "bathtub" }))).toMatchObject({ suppressed: 0 });
    expect(JSON.parse(String(actorFetch.mock.calls[0]![1]!.body))).toEqual({ quote: "bathtub" });
    expect(vi.mocked(addComment).mock.calls[0]![1]).toMatchObject({ anchorStart: "s1", anchorEnd: "e1", anchorQuote: "bathtub" });
    anchorAnswer(null);
    expect(await postComment(agent(), DOC, request("Here.", { anchorQuote: "tub" }))).toEqual({ status: 400, error: QUOTE_NOT_ONCE });
    expect(await postComment(agent(), DOC, request("Yes.", { parentNum: 1, anchorQuote: "bathtub" }))).toMatchObject({ status: 400 });
    expect(addComment).toHaveBeenCalledTimes(1);
    // An empty one quotes nothing, as a missing one does.
    await postComment(agent(), DOC, request("Anywhere.", { anchorQuote: "" }));
    expect(vi.mocked(addComment).mock.calls[1]![1]).toMatchObject({ anchorStart: null, anchorEnd: null, anchorQuote: null });
    expect(lookups()).toBe(2);
  });

  it("keeps the positions and quote a person's editor found, and finds a person's `quote` as strictly as an agent's", async () => {
    const bob = () => person("u_bob", "Bob");
    await postComment(bob(), DOC, request("Here.", { anchorStart: "s9", anchorEnd: "e9", anchorQuote: "as selected" }));
    await postComment(bob(), DOC, request("Here.", { anchorQuote: "quote only" }));
    expect(lookups()).toBe(0);
    expect(vi.mocked(addComment).mock.calls.map(([, c]) => [c.anchorStart, c.anchorEnd, c.anchorQuote])).toEqual([
      ["s9", "e9", "as selected"],
      [null, null, "quote only"],
    ]);
    anchorAnswer(null);
    expect(await postComment(bob(), DOC, request("Here.", { quote: "tub" }))).toEqual({ status: 400, error: QUOTE_NOT_ONCE });
    anchorAnswer({ start: "s1", end: "e1", quote: "bathtub" });
    await postComment(bob(), DOC, request("Here.", { quote: "bathtub" }));
    expect(vi.mocked(addComment).mock.calls[2]![1]).toMatchObject({ anchorStart: "s1", anchorEnd: "e1", anchorQuote: "bathtub" });
  });

  it("refuses a quote on a reply, which keeps its thread's passage", async () => {
    const out = await postComment(agent(), DOC, request("Yes.", { parentNum: 1, quote: "bathtub" }));
    expect(out).toMatchObject({ status: 400 });
    expect(actorFetch).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses a quote in a database, which has no text to anchor to", async () => {
    const out = await postComment(agent(), { ...DOC, doc_type: "database" } as DocRow, request("Row 3?", { quote: "Row 3" }));
    expect(out).toMatchObject({ status: 400 });
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("gives up on a document whose actor a co-author turn holds, and saves nothing", async () => {
    const turn = holdActor();
    vi.useFakeTimers();
    try {
      const pending = quoted("bathtub");
      await vi.advanceTimersByTimeAsync(QUOTE_ANCHOR_WAIT_MS);
      expect(await pending).toEqual({ status: 503, error: DOCUMENT_BUSY });
      expect(addComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await turn.end();
    }
  });

  it("keeps one lookup waiting per document, so a retry is busy at once rather than queueing another", async () => {
    const turn = holdActor();
    const first = quoted("bathtub");
    expect(await quoted("bathtub")).toEqual({ status: 503, error: DOCUMENT_BUSY });
    expect(lookups()).toBe(1);
    // Another document's actor is asked as usual.
    expect(await postComment(agent(), { ...DOC, doc_id: "d2" } as DocRow, request("Here?", { quote: "bathtub" }))).toMatchObject({ suppressed: 0 });
    expect(lookups()).toBe(2);
    await turn.end();
    expect(await first).toMatchObject({ comment: { num: 9 } });
    // Once the turn lets it through, the document takes the next.
    expect(await quoted("bathtub")).toMatchObject({ suppressed: 0 });
    expect(lookups()).toBe(3);
  });
});
