import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  getComment: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
  getMembersByUsername: vi.fn(async () => []),
  getUserDisplayName: vi.fn(async (_sql: unknown, alias: string) => (alias === "u_liv" ? "Liv" : null)),
}));
vi.mock("../agents/edits.js", () => ({ proposeDocEdit: vi.fn() }));
vi.mock("../retrieval/retrieve.js", () => ({ retrieveAndRerank: vi.fn() }));

const { getDoc, getComment, listComments, addComment, getMemberRole, getMembersByUsername } = await import("@stuga/db");
const { handleInternalRequest } = await import("./routes.js");
const { createInternalApi } = await import("../platform/internal-api.js");
import type { CommentRow } from "@stuga/db";
import type { NodeEnv } from "../env.js";
import { recordingJobs } from "../testing/ctx.js";

const actorFetch = vi.fn(async () => new Response(null, { status: 204 }));
const jobs = recordingJobs();
const env = {
  sql: {},
  publicOrigin: "https://stuga.test",
  docs: { get: () => ({ fetch: actorFetch }) },
  jobs,
} as unknown as NodeEnv;
const internal = createInternalApi((req) => handleInternalRequest(req, env));

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await internal.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Liv writes in DOC; Bob is another member. */
const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  doc_type: "prose",
  title: "Renovation",
  owner: "user:u_owner",
  parent_id: null,
  trashed: false,
  locked: false,
  acl_principals: ["org:ws1"],
  acl_writers: ["user:u_liv"],
  acl_commenters: [],
};
const session = { workspaceId: "ws1", principals: ["user:u_liv", "org:ws1"], alias: "u_liv", doc_id: "d1" };

function row(num: number, parent_num: number | null, author: string, body: string, over: Partial<CommentRow> = {}): CommentRow {
  return {
    doc_id: "d1",
    num,
    parent_num,
    author,
    body,
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

/** Each document's comments, as the database holds them. */
let comments: Record<string, CommentRow[]>;

const notices = () => jobs.sent().filter((m) => m.kind === "notify");
const events = () => jobs.sent().filter((m) => m.kind === "event");

beforeEach(() => {
  vi.clearAllMocks();
  comments = {
    d1: [
      row(1, null, "panel:u_liv", "Built-in or freestanding?", { anchor_start: "s1", anchor_end: "e1", anchor_quote: "bathtub" }),
      row(2, null, "u_bob", "Tiles first."),
      row(3, 1, "u_liv", "Freestanding."),
      row(4, 1, "panel:u_bob", "Then the plinth goes."),
      row(5, 2, "u_liv", "Agreed."),
    ],
    d2: [row(7, null, "u_bob", "Elsewhere.", { doc_id: "d2" })],
  };
  vi.mocked(getDoc).mockResolvedValue({ ...DOC } as never);
  vi.mocked(listComments).mockImplementation(async (_sql, docId) => comments[docId] ?? []);
  vi.mocked(getComment).mockImplementation(async (_sql, docId, num) => comments[docId]?.find((c) => c.num === num) ?? null);
  vi.mocked(addComment).mockImplementation(async (_sql, input) =>
    row(9, input.parentNum ?? null, input.author, input.body, { anchor_quote: input.anchorQuote ?? null, mentions: input.mentions ?? [] }),
  );
  vi.mocked(getMemberRole).mockResolvedValue("member");
});

/** The ways a call reaches no document its person may read, each answered before anything is written or sent. */
const UNREADABLE: Array<[string, Record<string, unknown>, Record<string, unknown>, number]> = [
  ["names no person", { alias: undefined }, {}, 400],
  ["names no workspace", { workspaceId: "" }, {}, 400],
  ["forwards no principals", { principals: [] }, {}, 400],
  ["names no document", { doc_id: undefined }, {}, 400],
  ["comes from a person who cannot read it", { principals: ["user:u_eve"] }, {}, 404],
  ["is about a trashed document", {}, { trashed: true }, 404],
  ["is about a database", {}, { doc_type: "database" }, 404],
  ["is about another workspace's document", {}, { workspace_id: "ws2" }, 404],
];

describe("/internal/comment-thread", () => {
  const call = (body: Record<string, unknown> = {}) => post("/internal/comment-thread", { ...session, num: 1, ...body });

  it("reads the root, then its replies by number, with raw author ids", async () => {
    expect(await call()).toEqual({
      status: 200,
      body: {
        can_write: true,
        resolved: false,
        anchor_quote: "bathtub",
        messages: [
          { num: 1, parent_num: null, author: "panel:u_liv", body: "Built-in or freestanding?", created_at: "2026-10-01T10:00:00.000Z" },
          { num: 3, parent_num: 1, author: "u_liv", body: "Freestanding.", created_at: "2026-10-03T10:00:00.000Z" },
          { num: 4, parent_num: 1, author: "panel:u_bob", body: "Then the plinth goes.", created_at: "2026-10-04T10:00:00.000Z" },
        ],
      },
    });
  });

  it("says whether the person may still write, and whether the thread was resolved", async () => {
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, acl_writers: ["user:u_bob"] } as never);
    comments.d1![0] = { ...comments.d1![0]!, resolved: true };
    expect((await call()).body).toMatchObject({ can_write: false, resolved: true });
  });

  it("finds only a thread's first comment", async () => {
    expect(await call({ num: 3 })).toEqual({ status: 404, body: { error: "comment not found" } });
    expect((await call({ num: 99 })).status).toBe(404);
    expect((await call({ num: "1" })).status).toBe(400);
  });

  it.each(UNREADABLE)("refuses a call that %s", async (_label, change, docChange, status) => {
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, ...docChange } as never);
    expect((await call(change)).status).toBe(status);
    expect(listComments).not.toHaveBeenCalled();
  });
});

describe("/internal/comment", () => {
  const call = (body: Record<string, unknown>) => post("/internal/comment", { ...session, ...body });

  it("posts as the person's co-author, resolving no mentions and telling no one", async () => {
    const out = await call({ body: " @bob: built-in or freestanding? ", anchor_start: "s1", anchor_end: "e1", anchor_quote: "bathtub" });
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ num: 9, author: "panel:u_liv", mentions: [] });
    expect(addComment).toHaveBeenCalledWith(expect.anything(), {
      docId: "d1",
      author: "panel:u_liv",
      body: "@bob: built-in or freestanding?",
      parentNum: null,
      anchorStart: "s1",
      anchorEnd: "e1",
      anchorQuote: "bathtub",
      mentions: [],
    });
    expect(getMembersByUsername).not.toHaveBeenCalled();
    // The actor calling holds its own lock and tells its pages itself.
    expect(actorFetch).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });

  it("records the comment as its co-author's, as run events name it", async () => {
    await call({ body: "Built-in or freestanding?" });
    expect(events()).toEqual([
      expect.objectContaining({
        type: "comment.added",
        docId: "d1",
        actor: "panel:u_liv",
        actorKind: "agent",
        payload: { num: 9, parent_num: null, excerpt: "Built-in or freestanding?" },
      }),
    ]);
  });

  /** The root a thread turn read: its number and `created_at`, as `/internal/comment-thread` gives them. */
  const ROOT_1 = { parent_num: 1, parent_created_at: "2026-10-01T10:00:00.000Z" };

  it("replies in an open thread", async () => {
    const out = await call({ body: "Done: the plinth line is gone.", ...ROOT_1 });
    expect(out).toMatchObject({ status: 201, body: { parent_num: 1 } });
    expect(vi.mocked(addComment).mock.calls[0]![1]).toMatchObject({ parentNum: 1, author: "panel:u_liv", mentions: [] });
  });

  it("tells the thread's other people of its answer, as Liv's AI co-author, but not Liv or the owner", async () => {
    await call({ body: "Done: the plinth line is gone.", ...ROOT_1 });
    expect(notices()).toEqual([
      expect.objectContaining({
        recipient: "u_bob",
        eventType: "COMMENT_REPLY",
        actor: "panel:u_liv",
        commentNum: 9,
        thread: `1@${Date.parse("2026-10-01T10:00:00Z")}`,
        params: { actor: { coauthor_of: "Liv" }, doc: "Renovation", excerpt: "Done: the plinth line is gone.", relation: "thread" },
      }),
    ]);
    // The actor calling holds its own lock and tells its pages itself.
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("refuses a reply to a resolved thread", async () => {
    comments.d1![0] = { ...comments.d1![0]!, resolved: true };
    expect(await call({ body: "Done.", ...ROOT_1 })).toEqual({ status: 409, body: { error: "thread closed" } });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses a parent from another document, a deleted one and a reply as no open thread", async () => {
    for (const parent_num of [7, 99, 3]) {
      expect(await call({ body: "Done.", parent_num, parent_created_at: `2026-10-0${parent_num % 10}T10:00:00.000Z` })).toEqual({
        status: 409,
        body: { error: "thread closed" },
      });
    }
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses a reply to a new thread that took a deleted root's number", async () => {
    // Root 1 and its replies are deleted; the next comment, another person's, gets number 1 again.
    comments.d1 = comments.d1!.filter((c) => c.num !== 1 && c.parent_num !== 1);
    comments.d1.push(row(1, null, "u_bob", "Unrelated.", { created_at: "2026-10-09T10:00:00Z" }));
    expect(await call({ body: "Done.", ...ROOT_1 })).toEqual({ status: 409, body: { error: "thread closed" } });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses a reply that does not name its root's created_at, before reading the document", async () => {
    for (const parent_created_at of [undefined, null, 1]) {
      expect(await call({ body: "Done.", parent_num: 1, parent_created_at })).toEqual({
        status: 400,
        body: { error: "parent_created_at required" },
      });
    }
    expect(getDoc).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses a person who may only read", async () => {
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, acl_writers: ["user:u_bob"] } as never);
    expect(await call({ body: "Built-in or freestanding?" })).toEqual({ status: 403, body: { error: "no comment access" } });
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, acl_writers: ["user:u_bob"], acl_commenters: ["user:u_liv"] } as never);
    expect((await call({ body: "Built-in or freestanding?" })).status).toBe(201);
  });

  it("holds the body and anchor to the limits a person's comment has, before reading the document", async () => {
    expect(await call({ body: "  " })).toEqual({ status: 400, body: { error: "comment body required" } });
    expect((await call({ body: "x".repeat(20_001) })).body).toEqual({ error: "comment too long" });
    expect((await call({ body: "x", anchor_quote: "q".repeat(2_001) })).body).toEqual({ error: "anchor quote too long" });
    expect((await call({ body: "x", anchor_start: "a".repeat(1_001) })).body).toEqual({ error: "anchor too long" });
    expect((await call({ body: "x", parent_num: -1 })).body).toEqual({ error: "invalid parent_num" });
    expect(getDoc).not.toHaveBeenCalled();
  });

  it.each(UNREADABLE)("refuses a call that %s", async (_label, change, docChange, status) => {
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, ...docChange } as never);
    expect((await call({ body: "Built-in or freestanding?", ...change })).status).toBe(status);
    expect(addComment).not.toHaveBeenCalled();
    expect(jobs.sent()).toEqual([]);
  });
});

describe("/internal/coauthor-asked", () => {
  const call = (body: Record<string, unknown>) => post("/internal/coauthor-asked", { ...session, ...body });

  it("notifies the person of each of their co-author's questions still open", async () => {
    comments.d1!.push(
      row(6, null, "panel:u_liv", "Which tap?", { resolved: true }),
      row(8, null, "panel:u_liv", "Grout colour? ".repeat(20)),
    );
    // 2 is Bob's, 3 a reply, 4 another co-author's, 6 resolved, 99 deleted.
    expect(await call({ nums: [1, 2, 3, 4, 6, 8, 99, 1] })).toEqual({ status: 204, body: null });
    expect(notices()).toEqual([
      {
        kind: "notify",
        recipient: "u_liv",
        workspaceId: "ws1",
        docId: "d1",
        commentNum: 1,
        actor: "panel:u_liv",
        eventType: "MENTIONED_IN_COMMENT",
        params: { actor: { coauthor_of: "Liv" }, doc: "Renovation", excerpt: "Built-in or freestanding?" },
      },
      expect.objectContaining({ commentNum: 8, params: expect.objectContaining({ excerpt: "Grout colour? ".repeat(20).slice(0, 140) }) }),
    ]);
  });

  it("notifies nobody who has left the workspace since", async () => {
    vi.mocked(getMemberRole).mockResolvedValue(null);
    expect((await call({ nums: [1] })).status).toBe(204);
    expect(notices()).toEqual([]);
  });

  it("notifies nobody who lost access to the document since", async () => {
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, acl_principals: ["user:u_bob"] } as never);
    expect((await call({ nums: [1] })).status).toBe(404);
    expect(notices()).toEqual([]);
  });

  it("refuses a call naming no question", async () => {
    expect((await call({ nums: [] })).status).toBe(400);
    expect((await call({ nums: ["1", -1, 1.5] })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect(getDoc).not.toHaveBeenCalled();
  });

  it.each(UNREADABLE)("refuses a call that %s", async (_label, change, docChange, status) => {
    vi.mocked(getDoc).mockResolvedValue({ ...DOC, ...docChange } as never);
    expect((await call({ nums: [1], ...change })).status).toBe(status);
    expect(notices()).toEqual([]);
  });
});
