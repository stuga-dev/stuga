/** GET /api/users caps the principals per call; the client chunks larger sets. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getUsers: vi.fn(),
}));

const { getUsers } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetUsers = getUsers as unknown as ReturnType<typeof vi.fn>;

const ctx = {
  sql: {},
  alias: "ada",
  displayName: "Ada",
  isAgent: false,
  principals: ["user:ada", "org:ws1"],
  workspaceId: "ws1",
  role: "member",
  env: {},
} as unknown as Ctx;

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
