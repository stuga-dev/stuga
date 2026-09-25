/**
 * A person manages only the keys they minted (the `owner` predicate is the whole gate, since
 * key ids carry no tenant filter), and leaving a workspace revokes their keys there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  revokeWorkspaceApiKeysForOwner: vi.fn(),
  dropWorkspaceFromOwnerGrants: vi.fn(async () => 0),
  getMemberRole: vi.fn(),
  countWorkspaceOwners: vi.fn(),
  removeWorkspaceMember: vi.fn(),
}));

const {
  listApiKeys,
  revokeApiKey,
  revokeWorkspaceApiKeysForOwner,
  dropWorkspaceFromOwnerGrants,
  getMemberRole,
  countWorkspaceOwners,
  removeWorkspaceMember,
} = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockList = listApiKeys as unknown as ReturnType<typeof vi.fn>;
const mockRevoke = revokeApiKey as unknown as ReturnType<typeof vi.fn>;
const mockRevokeForOwner = revokeWorkspaceApiKeysForOwner as unknown as ReturnType<typeof vi.fn>;
const mockRole = getMemberRole as unknown as ReturnType<typeof vi.fn>;
const mockOwners = countWorkspaceOwners as unknown as ReturnType<typeof vi.fn>;
const mockRemove = removeWorkspaceMember as unknown as ReturnType<typeof vi.fn>;

/** A stored row as the queries return it — secret_hash included, as in the DB. */
function keyRow(over: Record<string, unknown> = {}) {
  return {
    key_id: "k1",
    secret_hash: "deadbeef",
    agent_id: "agent-conn-abc",
    owner: "human-1",
    workspace_id: "ws1",
    name: "Scout (Connector)",
    created_at: "2026-08-01T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
}

function humanCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "human-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:human-1"],
    workspaceId: "ws1",
    role: "member",
    env: { publicOrigin: "https://stuga.test" },
    ...over,
  } as unknown as Ctx;
}

async function route(ctx: Ctx, method: string, path: string): Promise<Response> {
  const url = new URL(`https://node.test${path}`);
  return routeWorkspaceRequest(ctx, new Request(url, { method }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockRevoke.mockResolvedValue(false);
  mockRevokeForOwner.mockResolvedValue([]);
  mockRole.mockResolvedValue("owner");
  mockOwners.mockResolvedValue(2);
  mockRemove.mockResolvedValue(true);
});

describe("GET /api/keys", () => {
  it("returns the caller's own keys, across every workspace they belong to", async () => {
    await route(humanCtx(), "GET", "/api/keys");
    expect(mockList).toHaveBeenCalledWith({}, "human-1");
  });

  it("reports who revoked a key, so an admin's action is attributable", async () => {
    mockList.mockResolvedValue([keyRow({ revoked_at: "2026-08-10T00:00:00Z", revoked_by: "human-9" })]);
    const res = await route(humanCtx(), "GET", "/api/keys");
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0]).toMatchObject({ revoked_by: "human-9" });
  });

  it("never returns the stored hash", async () => {
    mockList.mockResolvedValue([keyRow()]);
    const res = await route(humanCtx(), "GET", "/api/keys");
    expect(JSON.stringify(await res.json())).not.toContain("deadbeef");
  });

  it("refuses agents outright", async () => {
    const agent = humanCtx({ isAgent: true, role: "admin", alias: "agent-1", onBehalfOf: "human-1" });
    const res = await route(agent, "GET", "/api/keys");
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("refuses guests, who cannot provision or audit agents at all", async () => {
    const res = await route(humanCtx({ role: "guest" }), "GET", "/api/keys");
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/keys/:id", () => {
  it("revokes the caller's own key, in whichever workspace it was minted", async () => {
    mockRevoke.mockResolvedValue(true);
    const res = await route(humanCtx(), "DELETE", "/api/keys/k1");
    expect(res.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith({}, "k1", "human-1");
  });

  it("answers 404, not 403, for a key the caller does not own", async () => {
    const res = await route(humanCtx(), "DELETE", "/api/keys/k1");
    expect(res.status).toBe(404);
  });

  it("refuses an agent even when its owner is an admin", async () => {
    const res = await route(
      humanCtx({ isAgent: true, role: "admin", alias: "agent-1", onBehalfOf: "human-1" }),
      "DELETE",
      "/api/keys/k1",
    );
    expect(res.status).toBe(403);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/workspaces/:id/members/:alias", () => {
  it("revokes the departing member's keys in that workspace", async () => {
    mockRevokeForOwner.mockResolvedValue([keyRow({ owner: "human-2" })]);
    const res = await route(humanCtx({ role: "owner" }), "DELETE", "/api/workspaces/ws1/members/human-2");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: "human-2", keys_revoked: 1, connections_revoked: 0 });
    expect(mockRevokeForOwner).toHaveBeenCalledWith({}, "ws1", "human-2", "human-1");
    // Their apps' sign-ins stop naming the workspace too, so a re-invite hands it back to none of them.
    expect(dropWorkspaceFromOwnerGrants).toHaveBeenCalledWith({}, "ws1", "human-2", "human-1");
  });

  it("revokes your own keys when you leave voluntarily", async () => {
    mockRole.mockResolvedValue("member");
    await route(humanCtx(), "DELETE", "/api/workspaces/ws1/members/human-1");
    expect(mockRevokeForOwner).toHaveBeenCalledWith({}, "ws1", "human-1", "human-1");
  });

  it("removes the member before revoking, so a failed removal leaves a member's agents working", async () => {
    const calls: string[] = [];
    mockRemove.mockImplementation(async () => {
      calls.push("remove");
      return true;
    });
    mockRevokeForOwner.mockImplementation(async () => {
      calls.push("revoke");
      return [];
    });
    await route(humanCtx({ role: "owner" }), "DELETE", "/api/workspaces/ws1/members/human-2");
    expect(calls).toEqual(["remove", "revoke"]);
  });

  it("does not revoke anything when the removal is refused", async () => {
    mockRole.mockResolvedValue("owner");
    mockOwners.mockResolvedValue(1);
    const res = await route(humanCtx({ role: "owner" }), "DELETE", "/api/workspaces/ws1/members/human-1");
    expect(res.status).toBe(400);
    expect(mockRevokeForOwner).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
