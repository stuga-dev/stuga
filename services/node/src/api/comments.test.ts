import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(),
  setCommentResolved: vi.fn(),
  deleteComment: vi.fn(),
  getMembersByUsername: vi.fn(),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
  listComments: vi.fn(async () => []),
  agentOwners: vi.fn(async () => new Map()),
  getUserDisplayName: vi.fn(async () => null),
}));

const { getDoc, addComment, getMembersByUsername, getMemberRole, getComment, setCommentResolved, deleteComment, listComments, agentOwners, getUserDisplayName } =
  await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { Ctx } from "../auth/context.js";
import { actorsAnswering, agentCtx, personCtx, type CtxOverrides } from "../testing/ctx.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockAddComment = addComment as unknown as ReturnType<typeof vi.fn>;
const mockMembers = getMembersByUsername as unknown as ReturnType<typeof vi.fn>;
const mockRole = getMemberRole as unknown as ReturnType<typeof vi.fn>;

/** The directory these tests resolve @usernames against: bob is a member, gus a guest, owner-1 owns DOC. */
const DIRECTORY: Record<string, { alias: string; role: string }> = {
  bob: { alias: "u_bob", role: "member" },
  gus: { alias: "u_gus", role: "guest" },
  owner: { alias: "owner-1", role: "owner" },
  ada: { alias: "human-7f3a", role: "member" },
};

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Roadmap",
  doc_type: "prose",
  acl_principals: ["org:ws1"],
  acl_writers: ["org:ws1"],
  acl_commenters: [],
};

let sent: IndexMessage[];
/** What the node asked the document's actor, by path. */
const actorFetch = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
const actorPaths = () => actorFetch.mock.calls.map(([url]) => new URL(url).pathname);

function ctx(over: CtxOverrides = {}): Ctx {
  return personCtx({
    alias: "human-7f3a",
    displayName: "Ada Lovelace",
    env: { jobs: { send: async (m: IndexMessage) => void sent.push(m) }, docs: actorsAnswering(actorFetch) },
    ...over,
  });
}

function comment(c: Ctx, body: Record<string, unknown>): Promise<Response> {
  return routeWorkspaceRequest(
    c,
    new Request("https://node.test/api/docs/d1/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const ownerNotice = () => sent.find((m) => m.kind === "notify" && m.eventType === "COMMENT_ON_OWNED_DOC");
const mentionNotices = () =>
  sent.filter((m): m is Extract<IndexMessage, { kind: "notify" }> => m.kind === "notify" && m.eventType === "MENTIONED_IN_COMMENT");

beforeEach(() => {
  sent = [];
  actorFetch.mockClear();
  mockGetDoc.mockReset().mockResolvedValue({ ...DOC });
  mockAddComment
    .mockReset()
    .mockImplementation(async (_sql, input: { parentNum: number | null; mentions: unknown }) => ({
      num: 1,
      parent_num: input.parentNum,
      mentions: input.mentions,
    }));
  mockMembers
    .mockReset()
    .mockImplementation(async (_sql, usernames: string[]) =>
      usernames.flatMap((u) => (DIRECTORY[u] ? [{ alias: DIRECTORY[u]!.alias, username: u }] : [])),
    );
  mockRole
    .mockReset()
    .mockImplementation(async (_sql, _ws, alias: string) => Object.values(DIRECTORY).find((d) => d.alias === alias)?.role ?? null);
});

describe("POST /api/docs/:id/comments", () => {
  it("names the commenter by display name in the owner's notification", async () => {
    const res = await comment(ctx(), { body: "Looks good" });
    expect(res.status).toBe(201);
    expect(ownerNotice()).toMatchObject({
      recipient: "owner-1",
      eventType: "COMMENT_ON_OWNED_DOC",
      params: { actor: "Ada Lovelace", doc: "Roadmap", kind: "comment", excerpt: "Looks good" },
      actor: "human-7f3a",
    });
  });

  it("falls back to the alias for a commenter with no display name", async () => {
    await comment(ctx({ displayName: "" }), { body: "Looks good" });
    expect(ownerNotice()).toMatchObject({ params: { actor: "human-7f3a" } });
  });

  it("does not notify an owner commenting on their own document", async () => {
    await comment(ctx({ alias: "owner-1", principals: ["user:owner-1", "org:ws1"] }), { body: "Note to self" });
    expect(ownerNotice()).toBeUndefined();
  });

  it("stores the @usernames that name members and notifies each reader once", async () => {
    const res = await comment(ctx(), { body: "@bob and @Bob, see (@nobody) and mail bob@example.com. Thanks @bob." });
    expect(res.status).toBe(201);
    expect(vi.mocked(mockAddComment).mock.calls[0]![1].mentions).toEqual([{ alias: "u_bob", username: "bob" }]);
    expect(mentionNotices()).toEqual([
      expect.objectContaining({
        recipient: "u_bob",
        params: expect.objectContaining({ actor: "Ada Lovelace", doc: "Roadmap" }),
        docId: "d1",
        actor: "human-7f3a",
      }),
    ]);
  });

  it("does not notify someone who cannot read the document, nor the commenter", async () => {
    // A guest holds no org principal, and DOC is shared with the org only.
    await comment(ctx(), { body: "@gus @ada" });
    expect(vi.mocked(mockAddComment).mock.calls[0]![1].mentions).toHaveLength(2);
    expect(mentionNotices()).toEqual([]);
  });

  it("gives a mentioned owner the mention instead of a second notification", async () => {
    await comment(ctx(), { body: "@owner please review" });
    expect(mentionNotices().map((m) => m.recipient)).toEqual(["owner-1"]);
    expect(ownerNotice()).toBeUndefined();
  });
});

describe("comments reach open pages", () => {
  function call(c: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
    return routeWorkspaceRequest(
      c,
      new Request(`https://node.test/api/docs/d1/comments${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  beforeEach(() => {
    vi.mocked(getComment).mockReset().mockResolvedValue({ num: 1, author: "human-7f3a", parent_num: null } as never);
    vi.mocked(setCommentResolved).mockReset().mockResolvedValue({ num: 1, resolved: true } as never);
    vi.mocked(deleteComment).mockReset().mockResolvedValue(true as never);
  });

  it("tells the document's open pages after a comment, a resolve and a delete", async () => {
    await comment(ctx(), { body: "Looks good" });
    expect(actorPaths()).toEqual(["/comments-changed"]);
    await call(ctx(), "PATCH", "/1", { resolved: true });
    await call(ctx(), "DELETE", "/1");
    expect(actorPaths()).toEqual(["/comments-changed", "/comments-changed", "/comments-changed"]);
  });

  it("opens no document actor for a database's comments", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, doc_type: "database" });
    expect((await comment(ctx(), { body: "Row 3 looks off" })).status).toBe(201);
    await call(ctx(), "DELETE", "/1");
    expect(actorPaths()).toEqual([]);
  });

  it("tells nobody when nothing changed", async () => {
    vi.mocked(deleteComment).mockResolvedValue(false as never);
    expect((await call(ctx(), "DELETE", "/1")).status).toBe(404);
    expect(actorPaths()).toEqual([]);
  });

  it("answers without waiting for the document's actor, which a co-author turn holds until it ends", async () => {
    const busy = ctx({
      env: { jobs: { send: async (m: IndexMessage) => void sent.push(m) }, docs: actorsAnswering(() => new Promise<Response>(() => {})) },
    });
    expect((await comment(busy, { body: "Freestanding." })).status).toBe(201);
    expect((await call(busy, "PATCH", "/1", { resolved: true })).status).toBe(200);
    expect((await call(busy, "DELETE", "/1")).status).toBe(200);
  });

  it("lets a person resolve and delete their own co-author's comments", async () => {
    vi.mocked(getComment).mockResolvedValue({ num: 1, author: "panel:human-7f3a", parent_num: null } as never);
    expect((await call(ctx(), "PATCH", "/1", { resolved: true })).status).toBe(200);
    expect((await call(ctx(), "DELETE", "/1")).status).toBe(200);
  });

  it("keeps another person's co-author's comments theirs", async () => {
    vi.mocked(getComment).mockResolvedValue({ num: 1, author: "panel:human-7f3a", parent_num: null } as never);
    const bob = ctx({ alias: "u_bob", principals: ["user:u_bob", "org:ws1"] });
    expect((await call(bob, "PATCH", "/1", { resolved: true })).status).toBe(403);
    expect((await call(bob, "DELETE", "/1")).status).toBe(403);
    expect(setCommentResolved).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
  });

  it("names the comment in each notification, so it opens there and two comments are two notifications", async () => {
    mockAddComment.mockImplementation(async () => ({ num: 7, parent_num: null, mentions: [{ alias: "u_bob", username: "bob" }] }));
    await comment(ctx(), { body: "@bob please check" });
    expect(mentionNotices()[0]).toMatchObject({ recipient: "u_bob", commentNum: 7 });
    expect(ownerNotice()).toMatchObject({ commentNum: 7 });
  });
});

describe("POST /api/docs/:id/comments as a reply", () => {
  const ROOT = { num: 1, parent_num: null, author: "u_bob", resolved: false, created_at: "2026-10-01T10:00:00Z" };

  beforeEach(() => {
    vi.mocked(getComment).mockReset().mockImplementation(async (_sql, _doc, num) => (num === 1 ? (ROOT as never) : null));
    vi.mocked(listComments).mockResolvedValue([ROOT, { num: 2, parent_num: 1, author: "u_gus" }] as never);
  });

  it("tells the thread's first commenter, and the owner of a reply", async () => {
    expect((await comment(ctx(), { body: "Freestanding.", parent_num: 1 })).status).toBe(201);
    expect(sent.filter((m) => m.kind === "notify")).toEqual([
      expect.objectContaining({
        recipient: "u_bob",
        eventType: "COMMENT_REPLY",
        commentNum: 1,
        thread: `1@${Date.parse(ROOT.created_at)}`,
        params: { actor: "Ada Lovelace", doc: "Roadmap", excerpt: "Freestanding.", relation: "comment" },
      }),
      expect.objectContaining({ recipient: "owner-1", eventType: "COMMENT_ON_OWNED_DOC", params: expect.objectContaining({ kind: "reply" }) }),
    ]);
  });

  it("refuses a reply to a comment that is not there", async () => {
    expect(await (await comment(ctx(), { body: "Freestanding.", parent_num: 5 })).json()).toEqual({ error: "parent comment not found" });
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("tells the person an agent works for of a reply to their agent's comment", async () => {
    const root = { ...ROOT, author: "agent-3" };
    vi.mocked(getComment).mockImplementation(async (_sql, _doc, num) => (num === 1 ? (root as never) : null));
    vi.mocked(listComments).mockResolvedValue([root] as never);
    vi.mocked(agentOwners).mockResolvedValue(new Map([["agent-3", "u_bob"]]));
    expect((await comment(ctx(), { body: "Freestanding.", parent_num: 1 })).status).toBe(201);
    expect(sent.filter((m) => m.kind === "notify")).toEqual([
      expect.objectContaining({ recipient: "u_bob", eventType: "COMMENT_REPLY", params: expect.objectContaining({ relation: "agent_comment" }) }),
      expect.objectContaining({ recipient: "owner-1", eventType: "COMMENT_ON_OWNED_DOC" }),
    ]);
  });
});

describe("an agent's comments over REST", () => {
  const agent = () =>
    agentCtx({ surface: "api-key", alias: "agent-3", onBehalfOf: "u_bob", env: { jobs: { send: async (m: IndexMessage) => void sent.push(m) }, docs: actorsAnswering(actorFetch) } });

  it("refuses more than five mentions, saving nothing", async () => {
    const res = await comment(agent(), { body: "@bob @gus @owner @ada @nobody, and @bob" });
    expect(res.status).toBe(201);
    vi.mocked(mockMembers).mockImplementation(async (_sql, usernames: string[]) => usernames.map((u) => ({ alias: `u_${u}`, username: u })));
    mockAddComment.mockClear();
    const many = await comment(agent(), { body: "@a1 @a2 @a3 @a4 @a5 @a6" });
    expect(many.status).toBe(400);
    expect(await many.json()).toEqual({ error: "an agent's comment may mention at most 5 people" });
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("names the agent by its person, from the directory", async () => {
    vi.mocked(getUserDisplayName).mockResolvedValueOnce("Bob Builder");
    await comment(agent(), { body: "Looks good" });
    expect(ownerNotice()).toMatchObject({ actor: "agent-3", params: { actor: { agent_of: "Bob Builder" } } });
  });
});

describe("POST /api/docs/:id/comments on a passage", () => {
  const agent = () =>
    agentCtx({ surface: "api-key", alias: "agent-3", onBehalfOf: "u_bob", env: { jobs: { send: async (m: IndexMessage) => void sent.push(m) }, docs: actorsAnswering(actorFetch) } });
  /** What the document's actor finds for each quote it is asked about. */
  const FOUND: Record<string, unknown> = { bathtub: { start: "s1", end: "e1", quote: "bathtub" }, tub: null };
  const stored = () => vi.mocked(addComment).mock.calls.map(([, c]) => [c.anchorStart, c.anchorEnd, c.anchorQuote]);

  beforeEach(() => {
    actorFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname !== "/quote-anchor") return new Response(null, { status: 204 });
      return Response.json({ anchor: FOUND[(JSON.parse(String(init!.body)) as { quote: string }).quote] ?? null });
    });
  });

  afterEach(() => {
    actorFetch.mockImplementation(async () => new Response(null, { status: 204 }));
  });

  it("places an agent's `quote`, or its `anchor_quote`, where the document's actor finds it, as over MCP", async () => {
    expect((await comment(agent(), { body: "Built-in?", quote: "bathtub" })).status).toBe(201);
    expect((await comment(agent(), { body: "Built-in?", anchor_quote: "bathtub" })).status).toBe(201);
    expect(actorPaths().filter((p) => p === "/quote-anchor")).toHaveLength(2);
    expect(stored()).toEqual([
      ["s1", "e1", "bathtub"],
      ["s1", "e1", "bathtub"],
    ]);
  });

  it("refuses an agent's quote that is not there once, its positions, and a quote on a reply, saving nothing", async () => {
    for (const [body, error] of [
      [{ body: "Here?", quote: "tub" }, "quote must appear exactly once in the document's text, as written"],
      [{ body: "Here?", anchor_quote: "tub" }, "quote must appear exactly once in the document's text, as written"],
      [{ body: "Here?", anchor_start: "s9", anchor_end: "e9", anchor_quote: "bathtub" }, "an agent attaches a comment to a passage with `quote`"],
      [{ body: "Here?", quote: "bathtub", parent_num: 1 }, "a reply shares its thread's passage: pass `quote` or `parent_num`, not both"],
    ] as const) {
      const res = await comment(agent(), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("keeps what a person's editor sends as it did, and finds a person's `quote` as strictly", async () => {
    await comment(ctx(), { body: "Here.", anchor_start: "s9", anchor_end: "e9", anchor_quote: "as selected" });
    await comment(ctx(), { body: "Here.", anchor_quote: "quote only" });
    expect(actorPaths()).not.toContain("/quote-anchor");
    expect((await comment(ctx(), { body: "Here.", quote: "tub" })).status).toBe(400);
    expect((await comment(ctx(), { body: "Here.", quote: "bathtub" })).status).toBe(201);
    expect(stored()).toEqual([
      ["s9", "e9", "as selected"],
      [null, null, "quote only"],
      ["s1", "e1", "bathtub"],
    ]);
  });
});

describe("GET /api/docs/:id/comments", () => {
  const ROWS = [
    { num: 1, parent_num: null, author: "human-7f3a", body: "Mine" },
    { num: 2, parent_num: 1, author: "agent-3", body: "An agent's" },
    { num: 3, parent_num: 1, author: "agent-gone", body: "A revoked agent's" },
    { num: 4, parent_num: null, author: "panel:human-7f3a", body: "My co-author's" },
    { num: 5, parent_num: null, author: "imported:Old Name", body: "From an archive" },
    { num: 6, parent_num: null, author: "agent-sample", body: "The sample's" },
    { num: 7, parent_num: 1, author: "agent-3", body: "Again" },
  ];
  const read = async (c: Ctx) => (await routeWorkspaceRequest(c, new Request("https://node.test/api/docs/d1/comments"))).json();

  beforeEach(() => {
    vi.mocked(listComments).mockResolvedValue(ROWS as never);
    vi.mocked(agentOwners).mockResolvedValue(new Map([["agent-3", "u_bob"]]));
  });

  it("gives a person the comments as stored, and whom each agent among their authors acts for", async () => {
    expect(await read(ctx())).toEqual({ comments: ROWS, agents: { "agent-3": "u_bob", "agent-gone": null }, can_manage: false });
    expect(vi.mocked(agentOwners).mock.calls[0]![1]).toEqual(["agent-3", "agent-gone"]);
  });

  it("marks an agent's own comments as its", async () => {
    const body = (await read(agentCtx({ alias: "agent-3", onBehalfOf: "u_bob", env: { docs: actorsAnswering(actorFetch) } }))) as {
      comments: Array<{ num: number; you?: boolean }>;
    };
    expect(body.comments.filter((c) => c.you).map((c) => c.num)).toEqual([2, 7]);
  });

  it("asks for no owners when no agent wrote any", async () => {
    vi.mocked(listComments).mockResolvedValue([ROWS[0]] as never);
    expect(await read(ctx())).toEqual({ comments: [ROWS[0]], agents: {}, can_manage: false });
    expect(agentOwners).not.toHaveBeenCalled();
  });

  it("says whether the caller may resolve and delete anyone's comment: the owner or an admin, never an agent", async () => {
    const canManage = async (c: Ctx) => ((await read(c)) as { can_manage: boolean }).can_manage;
    expect(await canManage(ctx({ alias: "owner-1", principals: ["user:owner-1", "org:ws1"] }))).toBe(true);
    expect(await canManage(ctx({ role: "admin" }))).toBe(true);
    expect(await canManage(ctx())).toBe(false);
    expect(await canManage(agentCtx({ alias: "agent-3", onBehalfOf: "owner-1", env: { docs: actorsAnswering(actorFetch) } }))).toBe(false);
  });
});
