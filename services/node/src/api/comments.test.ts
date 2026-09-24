import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  addComment: vi.fn(),
  getMembersByUsername: vi.fn(),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
}));

const { getDoc, addComment, getMembersByUsername, getMemberRole } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { Ctx } from "../auth/context.js";

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

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "human-7f3a",
    displayName: "Ada Lovelace",
    isAgent: false,
    principals: ["user:human-7f3a", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: { jobs: { send: async (m: IndexMessage) => void sent.push(m) } },
    ...over,
  } as unknown as Ctx;
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
    expect(ownerNotice()).toMatchObject({ recipient: "owner-1", title: 'Ada Lovelace commented on "Roadmap"', actor: "human-7f3a" });
  });

  it("falls back to the alias for a commenter with no display name", async () => {
    await comment(ctx({ displayName: "" }), { body: "Looks good" });
    expect(ownerNotice()).toMatchObject({ title: 'human-7f3a commented on "Roadmap"' });
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
        title: 'Ada Lovelace mentioned you in a comment on "Roadmap"',
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
