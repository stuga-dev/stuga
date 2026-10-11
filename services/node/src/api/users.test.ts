/** GET /api/users caps the principals per call; the client chunks larger sets. GET /api/users/search with `doc` serves @mentions. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getUsers: vi.fn(),
  getDoc: vi.fn(),
  searchUsers: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(),
}));

const db = await import("@stuga/db");
const { getUsers } = db;
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import { personCtx } from "../testing/ctx.js";

const mockGetUsers = getUsers as unknown as ReturnType<typeof vi.fn>;

const ctx = personCtx({ alias: "ada" });

const ids = (n: number) => Array.from({ length: n }, (_, i) => `user:u${i}`).join(",");

async function get(qs: string): Promise<Response> {
  const url = new URL(`https://node.test/api/users?ids=${qs}`);
  return routeWorkspaceRequest(ctx, new Request(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUsers.mockResolvedValue([]);
});

describe("the id cap", () => {
  it("resolves a list at the ceiling", async () => {
    const res = await get(ids(200));
    expect(res.status).toBe(200);
    expect(mockGetUsers).toHaveBeenCalledWith({}, expect.arrayContaining(["u0", "u199"]), "ws1");
  });

  it("refuses one past it, before the directory is asked", async () => {
    const res = await get(ids(201));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too many ids" });
    expect(mockGetUsers).not.toHaveBeenCalled();
  });
});

describe("searching for someone to @mention in a document", () => {
  const person = (alias: string, name: string) => ({ alias, username: alias, display_name: name, email: null, updated_at: "" });
  const roles: Record<string, string> = { ada: "owner", ben: "member", gus: "guest", cy: "member" };
  /** Shared with Ben and Gus by name; Cy, a member, is left out. */
  const doc = {
    doc_id: "d1",
    workspace_id: "ws1",
    owner: "user:ada",
    parent_id: null,
    acl_principals: ["user:ada", "user:ben", "user:gus"],
  };

  beforeEach(() => {
    vi.mocked(db.getDoc).mockResolvedValue(doc as never);
    vi.mocked(db.getMemberRole).mockImplementation(async (_sql, _ws, alias) => (roles[alias] ?? null) as never);
    vi.mocked(db.getGroupsForMember).mockResolvedValue([]);
    vi.mocked(db.searchUsers).mockResolvedValue([person("ben", "Ben Baker"), person("cy", "Cy Bell"), person("ada", "Ada")] as never);
    vi.mocked(db.listWorkspaceMembers).mockResolvedValue(
      (["ada", "cy", "gus", "ben"] as const).map((alias) => ({
        workspace_id: "ws1",
        alias,
        role: roles[alias],
        joined_at: "",
        display_name: { ada: "Ada", cy: "Cy Bell", gus: "Gus Guest", ben: "Ben Baker" }[alias],
        username: alias,
        email: null,
      })) as never,
    );
  });

  async function search(as: ReturnType<typeof personCtx>, q: string, docId = "d1") {
    const url = new URL(`https://node.test/api/users/search?q=${encodeURIComponent(q)}&doc=${docId}`);
    return routeWorkspaceRequest(as, new Request(url));
  }

  const owner = personCtx({ alias: "ada", role: "owner", principals: ["user:ada", "org:ws1"] });
  const guest = personCtx({ alias: "gus", role: "guest", principals: ["user:gus"] });

  it("marks who can open it, those who can first, never the caller", async () => {
    const res = await search(owner, "b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { alias: string; can_open: boolean }[]; can_share: boolean; readers_only?: boolean };
    // One letter: the people who can open it whose name starts so, which the answer says.
    expect(body.users.map((u) => [u.alias, u.can_open])).toEqual([["ben", true]]);
    expect(body.can_share).toBe(true);
    expect(body.readers_only).toBe(true);

    const typed = (await (await search(owner, "be")).json()) as { users: { alias: string; can_open: boolean }[]; readers_only?: boolean };
    expect(typed.readers_only, "a member searches the whole directory").toBeUndefined();
    expect(typed.users.map((u) => [u.alias, u.can_open])).toEqual([
      ["ben", true],
      ["cy", false],
    ]);
  });

  it("lists the people who can open it on a bare @", async () => {
    const body = (await (await search(owner, "")).json()) as { users: { alias: string }[] };
    expect(body.users.map((u) => u.alias)).toEqual(["ben", "gus"]);
  });

  it("lets a guest find the people it is shared with, and no one else", async () => {
    const res = await search(guest, "be");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { alias: string }[]; can_share: boolean; readers_only?: boolean };
    expect(body.users.map((u) => u.alias)).toEqual(["ben", "ada"]);
    expect(body.can_share).toBe(false);
    expect(body.readers_only).toBe(true);
  });

  it("still keeps a guest out of the directory without a document", async () => {
    const res = await routeWorkspaceRequest(guest, new Request("https://node.test/api/users/search?q=be"));
    expect(res.status).toBe(403);
  });

  it("answers 404 for a document the caller cannot read", async () => {
    const res = await search(personCtx({ alias: "cy", principals: ["user:cy", "org:ws1"] }), "be");
    expect(res.status).toBe(404);
  });

  it("reads a member's groups only when the document is shared with a group", async () => {
    await search(owner, "be");
    expect(db.getGroupsForMember).not.toHaveBeenCalled();

    vi.mocked(db.getDoc).mockResolvedValue({ ...doc, acl_principals: [...doc.acl_principals, "group:bakers"] } as never);
    vi.mocked(db.getGroupsForMember).mockImplementation(async (_sql, principal) =>
      (principal === "user:cy" ? [{ group_id: "group:bakers" }] : []) as never,
    );
    const body = (await (await search(owner, "be")).json()) as { users: { alias: string; can_open: boolean }[] };
    expect(body.users.find((u) => u.alias === "cy")?.can_open).toBe(true);
  });
});
