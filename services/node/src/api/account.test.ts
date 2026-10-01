/** Changing the name collaborators see and the optional email: refused when blank or malformed, and for an agent. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  setDisplayName: vi.fn(),
  setUserEmail: vi.fn(),
  getUsers: vi.fn(async () => [{ alias: "human-1", username: "ali", display_name: "Ali", email: "alice@example.test" }]),
  getSignInMethods: vi.fn(async () => ({ hasPassword: false, providerLinked: true })),
  isNodeAdminAlias: vi.fn(async () => false),
  sessionConfirmedAt: vi.fn(async () => new Date()),
  findAccountByAlias: vi.fn(async () => ({ alias: "human-1", username: "ali", password_hash: "scrypt$x", oidc_sub: null })),
}));

const { setDisplayName, setUserEmail, sessionConfirmedAt } = await import("@stuga/db");
const confirmedAt = sessionConfirmedAt as unknown as ReturnType<typeof vi.fn>;
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";
import { personCtx, type CtxOverrides } from "../testing/ctx.js";

const mockSet = setDisplayName as unknown as ReturnType<typeof vi.fn>;
const mockSetEmail = setUserEmail as unknown as ReturnType<typeof vi.fn>;

const settings = { current: () => ({ identityProvider: null, notify: { sink: "none" } }) };
const ctx = (over: CtxOverrides = {}): Ctx =>
  personCtx({ displayName: "Ali", principals: ["user:human-1"], env: { settings } as CtxOverrides["env"], ...over });

async function route(c: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`https://node.test${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(c, req);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  confirmedAt.mockResolvedValue(new Date());
});

describe("PATCH /api/whoami", () => {
  it("saves the trimmed name and echoes it back", async () => {
    const res = await route(ctx(), "PATCH", "/api/whoami", { display_name: "  Ada  " });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({}, "human-1", "Ada");
    expect(await res.json()).toMatchObject({ alias: "human-1", display_name: "Ada" });
  });

  it("refuses a blank, missing or non-string name instead of storing one", async () => {
    for (const body of [{}, { display_name: "   " }, { display_name: 42 }, { display_name: null }]) {
      const res = await route(ctx(), "PATCH", "/api/whoami", body);
      expect(res.status).toBe(400);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("sets, clears and refuses the optional email", async () => {
    const set = await route(ctx(), "PATCH", "/api/whoami", { email: " ada@example.test " });
    expect(set.status).toBe(200);
    expect(mockSetEmail).toHaveBeenCalledWith({}, "human-1", "ada@example.test");
    expect(mockSet).not.toHaveBeenCalled();

    for (const cleared of ["", null]) {
      mockSetEmail.mockClear();
      expect((await route(ctx(), "PATCH", "/api/whoami", { email: cleared })).status).toBe(200);
      expect(mockSetEmail).toHaveBeenCalledWith({}, "human-1", null);
    }

    mockSetEmail.mockClear();
    for (const bad of ["ada", "ada@example.test\r\nRCPT TO:<x@y.z>", 7]) {
      expect((await route(ctx(), "PATCH", "/api/whoami", { email: bad })).status).toBe(400);
    }
    expect(mockSetEmail).not.toHaveBeenCalled();
  });

  it("changes the email, where alerts go, only from a sign-in confirmed in the last five minutes; the name any time", async () => {
    confirmedAt.mockResolvedValue(new Date(Date.now() - 6 * 60_000));
    const res = await route(ctx(), "PATCH", "/api/whoami", { email: "ada@example.test" });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-stuga-reauth")).toBe("1");
    expect((await res.json()).methods).toEqual(["password"]);
    expect(mockSetEmail).not.toHaveBeenCalled();
    const both = await route(ctx(), "PATCH", "/api/whoami", { display_name: "Ada", email: null });
    expect(both.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
    expect((await route(ctx(), "PATCH", "/api/whoami", { display_name: "Ada" })).status).toBe(200);
  });

  it("refuses an agent renaming the human who minted it", async () => {
    const res = await route(ctx({ isAgent: true, onBehalfOf: "human-1" }), "PATCH", "/api/whoami", {
      display_name: "Not Alice",
    });
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("GET /api/whoami", () => {
  it("reports the username and email the account page shows, from the directory, and how the person signs in", async () => {
    const res = await route(ctx(), "GET", "/api/whoami");
    expect(await res.json()).toMatchObject({
      alias: "human-1",
      display_name: "Ali",
      username: "ali",
      email: "alice@example.test",
      has_password: false,
      provider_linked: true,
    });
  });

  it("gives an agent no sign-in fields", async () => {
    const res = await route(ctx({ isAgent: true, onBehalfOf: "human-1", alias: "agent-1" }), "GET", "/api/whoami");
    const body = await res.json();
    expect(body).not.toHaveProperty("has_password");
    expect(body).not.toHaveProperty("provider_linked");
    expect(body).toMatchObject({ username: null, email: null });
  });
});
