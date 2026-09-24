import { describe, expect, it } from "vitest";
import {
  CONSENT_PATH,
  handleAuthorize,
  handleRegister,
  isValidRedirectUri,
  unauthorizedChallenge,
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
} from "./oauth.js";
import { PEER_ADDRESS_HEADER } from "../platform/http-server.js";
import type { NodeEnv } from "../env.js";

describe("isValidRedirectUri", () => {
  it.each([
    "https://client.example.test/callback",
    "http://localhost:43110/callback",
    "http://127.0.0.1:43110/callback",
    "http://[::1]:43110/callback",
  ])("accepts %s", (uri) => {
    expect(isValidRedirectUri(uri)).toBe(true);
  });

  it.each([
    "http://client.example.test/callback",
    "javascript://localhost/callback",
    "data://localhost/callback",
    "https://user:secret@client.example.test/callback",
    "https://client.example.test/callback#fragment",
    "not a URL",
  ])("rejects %s", (uri) => {
    expect(isValidRedirectUri(uri)).toBe(false);
  });
});

describe("discovery", () => {
  const env = { publicOrigin: "https://stuga.example.test" } as NodeEnv;

  it("names the public origin as issuer, resource and challenge target", async () => {
    expect(await wellKnownAuthorizationServer(env).json()).toMatchObject({
      issuer: "https://stuga.example.test",
      authorization_endpoint: "https://stuga.example.test/oauth/authorize",
      token_endpoint: "https://stuga.example.test/oauth/token",
      registration_endpoint: "https://stuga.example.test/oauth/register",
    });
    expect(await wellKnownProtectedResource(env).json()).toMatchObject({
      resource: "https://stuga.example.test/mcp",
      authorization_servers: ["https://stuga.example.test"],
    });
    const challenge = unauthorizedChallenge(env);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://stuga.example.test/.well-known/oauth-protected-resource"',
    );
  });
});

describe("handleAuthorize parameter defaults", () => {
  const CHALLENGE = "qqLprUxSAsxwPaXb_Fp1VciYctx4dpL9O2-GV2Y5CWQ";
  const REDIRECT = "http://localhost:27062/oauth/callback";

  function envWithClient(): NodeEnv {
    const sql = (async () => [
      { client_id: "cid_test", client_secret_hash: null, redirect_uris: [REDIRECT], client_name: "A Client" },
    ]) as unknown as NodeEnv["sql"];
    return { sql, publicOrigin: "http://localhost:8787" } as NodeEnv;
  }

  function authorize(query: string): Promise<Response> {
    return handleAuthorize(envWithClient(), new Request(`http://localhost:8787/oauth/authorize?${query}`));
  }

  const base = `client_id=cid_test&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}`;

  it("accepts a request that omits response_type and code_challenge_method", async () => {
    const res = await authorize(base);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe(CONSENT_PATH);
    expect(to.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(to.searchParams.get("state")).toBe("xyz");
  });

  it("hands off to a different path than its own, so it cannot redirect to itself", async () => {
    const res = await authorize(`${base}&response_type=code&code_challenge_method=S256`);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).not.toBe("/oauth/authorize");
    expect(to.pathname).toBe(CONSENT_PATH);
  });

  it("forwards the flow parameters to the consent screen", async () => {
    const res = await authorize(`${base}&response_type=code&code_challenge_method=S256&scope=mcp&resource=http%3A%2F%2Flocalhost%3A8787%2Fmcp`);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("scope")).toBe("mcp");
    expect(to.searchParams.get("resource")).toBe("http://localhost:8787/mcp");
    expect(to.searchParams.get("client_name")).toBe("A Client");
  });

  it("still refuses a response_type that is stated and is not code", async () => {
    const res = await authorize(`${base}&response_type=token`);
    expect(res.status).toBe(400);
  });

  it("never downgrades to plain PKCE, even when asked", async () => {
    const res = await authorize(`${base}&code_challenge_method=plain`);
    expect(res.status).toBe(400);
  });

  it("still requires a code_challenge", async () => {
    const res = await authorize(`client_id=cid_test&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz`);
    expect(res.status).toBe(400);
  });
});

describe("handleRegister bounds an endpoint that cannot ask who is calling", () => {
  const REDIRECT = "https://client.example.test/callback";

  function envWith(
    limit: (input: { key: string }) => Promise<{ success: boolean }>,
    trustProxyHeaders = false,
  ): {
    env: NodeEnv;
    inserted: Record<string, unknown>[];
  } {
    const inserted: Record<string, unknown>[] = [];
    // A tagged-template call is a query; sql(row) carries the values being inserted.
    const sql = ((first: unknown) => {
      if (first && typeof first === "object" && "raw" in first) return Promise.resolve([]);
      inserted.push(first as Record<string, unknown>);
      return { row: true };
    }) as unknown as NodeEnv["sql"];
    return {
      env: { sql, publicOrigin: "http://localhost:8787", rateLimit: { limit }, trustProxyHeaders } as unknown as NodeEnv,
      inserted,
    };
  }

  const register = (env: NodeEnv, body: unknown, headers: Record<string, string> = {}) =>
    handleRegister(
      env,
      new Request("http://localhost:8787/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );

  it("keys its budget on the peer the listener stamped, not on anything the caller wrote", async () => {
    const seen: string[] = [];
    const { env } = envWith(async ({ key }) => {
      seen.push(key);
      return { success: true };
    });
    await register(env, { redirect_uris: [REDIRECT] }, {
      [PEER_ADDRESS_HEADER]: "10.0.0.7",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(seen).toEqual(["oauth:register:10.0.0.7"]);
  });

  it("behind a trusted proxy, keys on the address that proxy appended", async () => {
    const seen: string[] = [];
    const { env } = envWith(async ({ key }) => {
      seen.push(key);
      return { success: true };
    }, true);
    await register(env, { redirect_uris: [REDIRECT] }, {
      [PEER_ADDRESS_HEADER]: "10.0.0.7",
      "x-forwarded-for": "198.51.100.77, 203.0.113.9",
    });
    expect(seen).toEqual(["oauth:register:203.0.113.9"]);
  });

  it("refuses with 429 once that budget is spent, and writes nothing", async () => {
    const { env, inserted } = envWith(async () => ({ success: false }));
    const res = await register(env, { redirect_uris: [REDIRECT] });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(inserted).toEqual([]);
  });

  it("refuses a redirect_uri long enough to be a payload", async () => {
    const { env, inserted } = envWith(async () => ({ success: true }));
    const res = await register(env, { redirect_uris: [`https://client.example.test/${"a".repeat(4000)}`] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too long/);
    expect(inserted).toEqual([]);
  });

  it("still registers an ordinary client", async () => {
    const { env, inserted } = envWith(async () => ({ success: true }));
    const res = await register(env, { redirect_uris: [REDIRECT], client_name: "A Client" });
    expect(res.status).toBe(201);
    expect((await res.json()).client_id).toMatch(/^cid_/);
    expect(inserted).toHaveLength(1);
  });
});
