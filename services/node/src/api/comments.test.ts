import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

const { getDoc, addComment, getMembersByUsername, getMemberRole, getComment, setCommentResolved, deleteComment } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { Ctx } from "../auth/context.js";
import { actorsAnswering, personCtx, type CtxOverrides } from "../testing/ctx.js";

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

  it("names the comment in each notification, so it opens there and two comments are two notifications", async () => {
    mockAddComment.mockImplementation(async () => ({ num: 7, parent_num: null, mentions: [{ alias: "u_bob", username: "bob" }] }));
    await comment(ctx(), { body: "@bob please check" });
    expect(mentionNotices()[0]).toMatchObject({ recipient: "u_bob", commentNum: 7 });
    expect(ownerNotice()).toMatchObject({ commentNum: 7 });
  });
});
