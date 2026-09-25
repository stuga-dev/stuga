import { describe, expect, it } from "vitest";
import {
  CONSENT_PATH,
  handleAuthorize,
  handleRegister,
  isValidRedirectUri,
  redirectUriMatches,
  requestOrigin,
  unauthorizedChallenge,
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
} from "./oauth.js";
import { PEER_ADDRESS_HEADER, REQUEST_HOST_HEADER } from "../platform/http-server.js";
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

describe("redirectUriMatches", () => {
  it("matches a registered URI exactly", () => {
    expect(redirectUriMatches(["https://client.example.test/callback"], "https://client.example.test/callback")).toBe(true);
  });

  // RFC 8252 §7.3: a native client listens on whatever port it got that day.
  it.each([
    ["http://localhost:27062/oauth/callback", "http://localhost:51234/oauth/callback"],
    ["http://127.0.0.1:27062/oauth/callback", "http://127.0.0.1:61000/oauth/callback"],
    ["http://[::1]:27062/oauth/callback", "http://[::1]:61000/oauth/callback"],
    ["http://127.0.0.1/oauth/callback", "http://127.0.0.1:61000/oauth/callback"],
  ])("accepts loopback %s on another port (%s)", (registered, given) => {
    expect(redirectUriMatches([registered], given)).toBe(true);
  });

  it.each([
    // Any port only for loopback: a hosted client's port is part of its address.
    ["https://client.example.test/callback", "https://client.example.test:8443/callback"],
    ["https://localhost:27062/callback", "https://localhost:51234/callback"],
    // The port is the only thing loopback relaxes.
    ["http://localhost:27062/oauth/callback", "http://localhost:51234/other"],
    ["http://localhost:27062/oauth/callback?a=1", "http://localhost:51234/oauth/callback?a=2"],
    ["http://localhost:27062/oauth/callback", "http://127.0.0.1:27062/oauth/callback"],
    ["http://localhost:27062/oauth/callback", "not a URL"],
  ])("refuses %s given %s", (registered, given) => {
    expect(redirectUriMatches([registered], given)).toBe(false);
  });
});

describe("discovery", () => {
  const env = {
    publicOrigin: "https://stuga.example.test",
    extraOrigins: ["http://stuga.local:8787", "http://192.168.1.20:8787"],
  } as unknown as NodeEnv;

  const asked = (host?: string): Request =>
    new Request("http://127.0.0.1:8787/.well-known/oauth-authorization-server", {
      headers: host ? { [REQUEST_HOST_HEADER]: host } : {},
    });

  it("names the public origin as issuer, resource and challenge target", async () => {
    expect(await wellKnownAuthorizationServer(env, asked()).json()).toMatchObject({
      issuer: "https://stuga.example.test",
      authorization_endpoint: "https://stuga.example.test/oauth/authorize",
      token_endpoint: "https://stuga.example.test/oauth/token",
      registration_endpoint: "https://stuga.example.test/oauth/register",
      revocation_endpoint: "https://stuga.example.test/oauth/revoke",
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    });
    expect(await wellKnownProtectedResource(env, asked()).json()).toMatchObject({
      resource: "https://stuga.example.test/mcp",
      authorization_servers: ["https://stuga.example.test"],
    });
    const challenge = unauthorizedChallenge(env, asked());
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://stuga.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("answers on the origin the client reached, so a LAN client is sent back to its LAN name", async () => {
    const lan = asked("stuga.local:8787");
    expect(await wellKnownAuthorizationServer(env, lan).json()).toMatchObject({
      issuer: "http://stuga.local:8787",
      token_endpoint: "http://stuga.local:8787/oauth/token",
    });
    expect(await wellKnownProtectedResource(env, lan).json()).toMatchObject({
      resource: "http://stuga.local:8787/mcp",
      authorization_servers: ["http://stuga.local:8787"],
    });
    expect(unauthorizedChallenge(env, asked("192.168.1.20:8787")).headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://192.168.1.20:8787/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("falls back to the public origin for a host the node was not configured with", () => {
    expect(requestOrigin(env, asked("evil.example.test"))).toBe("https://stuga.example.test");
    expect(requestOrigin(env, asked("stuga.local:9999"))).toBe("https://stuga.example.test");
    expect(requestOrigin(env, asked("STUGA.LOCAL:8787"))).toBe("http://stuga.local:8787");
  });

  // Metadata documents live on the internet, so only an origin the internet can reach may offer to fetch them.
  it.each([
    ["https://stuga.example.test", true],
    ["http://stuga.example.test", false],
    ["https://stuga.local", false],
    ["https://192.168.1.20", false],
    ["https://203.0.113.10", true],
  ])("offers client metadata documents on %s: %s", async (origin, supported) => {
    const res = wellKnownAuthorizationServer({ publicOrigin: origin, extraOrigins: [] } as unknown as NodeEnv, asked());
    expect((await res.json()).client_id_metadata_document_supported).toBe(supported);
  });
});

describe("handleAuthorize parameter defaults", () => {
  const CHALLENGE = "qqLprUxSAsxwPaXb_Fp1VciYctx4dpL9O2-GV2Y5CWQ";
  const REDIRECT = "http://localhost:27062/oauth/callback";

  function envWithClient(): NodeEnv {
    const sql = (async () => [
      {
        client_id: "cid_test",
        client_secret_hash: null,
        redirect_uris: [REDIRECT],
        client_name: "A Client",
        kind: "dcr",
        metadata_fetched_at: null,
      },
    ]) as unknown as NodeEnv["sql"];
    return { sql, publicOrigin: "http://localhost:8787", extraOrigins: ["http://stuga.local:8787"] } as unknown as NodeEnv;
  }

  function authorize(query: string, host?: string): Promise<Response> {
    return handleAuthorize(
      envWithClient(),
      new Request(`http://localhost:8787/oauth/authorize?${query}`, { headers: host ? { [REQUEST_HOST_HEADER]: host } : {} }),
    );
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

  it("forwards the flow parameters to the consent screen, but not the client's name", async () => {
    const res = await authorize(`${base}&response_type=code&code_challenge_method=S256&scope=mcp&resource=http%3A%2F%2Flocalhost%3A8787%2Fmcp`);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("client_id")).toBe("cid_test");
    expect(to.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    // The screen asks the node for the name, so a crafted link cannot dress one client up as another.
    expect(to.searchParams.has("client_name")).toBe(false);
  });

  it("hands off on the origin the browser came in on", async () => {
    const res = await authorize(base, "stuga.local:8787");
    expect(new URL(res.headers.get("location")!).origin).toBe("http://stuga.local:8787");
  });

  it("accepts a loopback redirect on another port than the one registered", async () => {
    const res = await authorize(base.replace(encodeURIComponent(REDIRECT), encodeURIComponent("http://localhost:61000/oauth/callback")));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("redirect_uri")).toBe("http://localhost:61000/oauth/callback");
  });

  it("refuses a redirect the client did not register", async () => {
    const res = await authorize(base.replace(encodeURIComponent(REDIRECT), encodeURIComponent("https://evil.example.test/oauth/callback")));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("redirect_uri mismatch");
  });

  it.each(["http://localhost:8787/mcp", "http://localhost:8787/mcp/", "http://stuga.local:8787/mcp"])(
    "accepts resource %s, one of this node's /mcp",
    async (resource) => {
      expect((await authorize(`${base}&resource=${encodeURIComponent(resource)}`)).status).toBe(302);
    },
  );

  it.each(["https://other.example.test/mcp", "http://localhost:8787/api", "http://localhost:9999/mcp"])(
    "refuses resource %s, which is not this node's /mcp",
    async (resource) => {
      const res = await authorize(`${base}&resource=${encodeURIComponent(resource)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/resource/);
    },
  );

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
      env: { sql, publicOrigin: "http://localhost:8787", extraOrigins: [], rateLimit: { limit }, trustProxyHeaders } as unknown as NodeEnv,
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

  it("still registers an ordinary client, which may refresh", async () => {
    const { env, inserted } = envWith(async () => ({ success: true }));
    const res = await register(env, { redirect_uris: [REDIRECT], client_name: "A Client" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^cid_/);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(inserted).toHaveLength(1);
  });
});
