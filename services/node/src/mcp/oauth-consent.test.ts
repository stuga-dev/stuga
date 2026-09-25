import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@stuga/auth";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getOauthClient: vi.fn(),
  insertOauthCode: vi.fn(async () => {}),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  buildAccountContext: vi.fn(),
}));

const { getOauthClient, insertOauthCode, listWorkspacesForUser } = await import("@stuga/db");
const { buildAccountContext, Unauthorized } = await import("../auth/context.js");
const { handleConsent } = await import("./oauth.js");
import type { NodeEnv } from "../env.js";

const REGISTERED = "https://client.example.test/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const env = { sql: {}, publicOrigin: "https://stuga.test", extraOrigins: [] } as unknown as NodeEnv;

function consent(body: Record<string, unknown>): Promise<Response> {
  return handleConsent(
    env,
    new Request("https://stuga.test/oauth/consent", {
      method: "POST",
      headers: { authorization: "Bearer session", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const person = (alias = "liv") => ({ sql: {}, alias, isAgent: false, displayName: "Liv", surface: "http" }) as never;
const memberships = (...rows: Array<[string, string]>) =>
  vi.mocked(listWorkspacesForUser).mockResolvedValue(rows.map(([workspace_id, role]) => ({ workspace_id, role })) as never);

const allow = (over: Record<string, unknown> = {}) =>
  consent({ decision: "allow", client_id: "cid_1", redirect_uri: REGISTERED, state: "xyz", code_challenge: CHALLENGE, workspaces: ["ws1"], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildAccountContext).mockResolvedValue(person());
  vi.mocked(getOauthClient).mockResolvedValue({
    client_id: "cid_1",
    client_secret_hash: null,
    redirect_uris: [REGISTERED],
    client_name: "A Client",
    kind: "dcr",
    metadata_fetched_at: null,
  });
  memberships(["ws1", "member"], ["ws2", "admin"], ["ws3", "guest"]);
});

describe("POST /oauth/consent", () => {
  it("answers deny with the registered redirect carrying access_denied and the state", async () => {
    const res = await consent({ decision: "deny", client_id: "cid_1", redirect_uri: REGISTERED, state: "xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `${REGISTERED}?error=access_denied&state=xyz` });
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses to deny toward an address the client did not register", async () => {
    const res = await consent({ decision: "deny", client_id: "cid_1", redirect_uri: "https://evil.example.test/", state: "xyz" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid client/redirect" });
  });

  it("refuses to deny for an unknown client", async () => {
    vi.mocked(getOauthClient).mockResolvedValue(null);
    const res = await consent({ decision: "deny", client_id: "cid_nope", redirect_uri: REGISTERED });
    expect(res.status).toBe(400);
  });

  it("lets a person who is only ever a guest deny", async () => {
    memberships(["ws3", "guest"]);
    const res = await consent({ decision: "deny", client_id: "cid_1", redirect_uri: REGISTERED });
    expect(await res.json()).toEqual({ redirect: `${REGISTERED}?error=access_denied` });
  });

  it("answers allow with a single-use code bound to the person, the workspaces they ticked and propose access", async () => {
    const res = await allow({ workspaces: ["ws1", "ws2", "ws1"] });
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REGISTERED);
    const code = redirect.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(insertOauthCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        // Only the hash is kept.
        codeHash: sha256Hex(code),
        clientId: "cid_1",
        userAlias: "liv",
        workspaceScope: ["ws1", "ws2"],
        access: "propose",
        redirectUri: REGISTERED,
        codeChallenge: CHALLENGE,
      }),
    );
  });

  it("accepts a loopback redirect on another port than the one registered", async () => {
    vi.mocked(getOauthClient).mockResolvedValue({
      client_id: "cid_1",
      client_secret_hash: null,
      redirect_uris: ["http://127.0.0.1:27062/callback"],
      client_name: "A Client",
      kind: "dcr",
      metadata_fetched_at: null,
    });
    const res = await allow({ redirect_uri: "http://127.0.0.1:61000/callback" });
    expect(new URL(((await res.json()) as { redirect: string }).redirect).port).toBe("61000");
    expect(insertOauthCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirectUri: "http://127.0.0.1:61000/callback" }));
  });

  it("stores \"all\" as no scope, so workspaces the person joins later are reached too", async () => {
    await allow({ workspaces: "all" });
    expect(insertOauthCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceScope: null }));
  });

  it("stores read access when the person chose it", async () => {
    await allow({ access: "read" });
    expect(insertOauthCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ access: "read" }));
  });

  it("refuses an access that is neither read nor propose", async () => {
    const res = await allow({ access: "admin" });
    expect(res.status).toBe(400);
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("requires at least one workspace, or all", async () => {
    for (const workspaces of [undefined, [], "some", [42]]) {
      const res = await allow({ workspaces });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("choose at least one workspace");
    }
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses with 409 a person who is a guest everywhere, even for all", async () => {
    memberships(["ws3", "guest"]);
    expect((await allow({ workspaces: "all" })).status).toBe(409);
    expect((await allow({ workspaces: ["ws3"] })).status).toBe(409);
    memberships();
    expect((await allow({ workspaces: "all" })).status).toBe(409);
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses with 403 a workspace the person does not belong to, or only as a guest, with one wording", async () => {
    const foreign = await allow({ workspaces: ["ws1", "ws-elsewhere"] });
    const guest = await allow({ workspaces: ["ws1", "ws3"] });
    expect(foreign.status).toBe(403);
    expect(guest.status).toBe(403);
    expect(await foreign.json()).toEqual(await guest.json());
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("requires a decision and, to allow, a PKCE challenge", async () => {
    expect((await consent({ client_id: "cid_1", redirect_uri: REGISTERED, code_challenge: CHALLENGE, workspaces: "all" })).status).toBe(400);
    expect((await consent({ decision: "allow", client_id: "cid_1", redirect_uri: REGISTERED, workspaces: "all" })).status).toBe(400);
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses an agent's credential, which is not a login", async () => {
    vi.mocked(buildAccountContext).mockResolvedValue({ sql: {}, alias: "agent-1", isAgent: true, onBehalfOf: "liv" } as never);
    expect((await consent({ decision: "deny", client_id: "cid_1", redirect_uri: REGISTERED })).status).toBe(401);
    expect((await allow()).status).toBe(401);
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses a token that does not authenticate", async () => {
    vi.mocked(buildAccountContext).mockRejectedValue(new Unauthorized("expired"));
    const res = await allow();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid token" });
  });

  it("requires a signed-in person", async () => {
    const res = await handleConsent(env, new Request("https://stuga.test/oauth/consent", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(buildAccountContext).not.toHaveBeenCalled();
  });
});
