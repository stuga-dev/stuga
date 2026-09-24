/** The relying party against the mock identity provider, over real HTTP. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError, fetchProviderMetadata } from "./discovery.js";
import { codeChallenge, createRelyingParty, type ProviderClient } from "./relying-party.js";
import { startMockProvider, type MockProvider } from "./testing/mock-provider.js";

const REDIRECT = "http://localhost:8787/auth/oidc/callback";

let idp: MockProvider;
const client = (over: Partial<ProviderClient> = {}): ProviderClient => ({
  issuer: idp.issuer,
  clientId: idp.clientId,
  clientSecret: idp.clientSecret,
  scopes: "openid profile email",
  ...over,
});

beforeEach(async () => {
  idp = await startMockProvider();
});
afterEach(async () => {
  await idp.stop();
});

/** Follow the authorization URL the way a browser would, and read where the provider sends it back. */
async function authorize(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

/** A whole sign-in: start, the provider's answer, finish. */
async function signIn(rp = createRelyingParty(), c = client()) {
  const start = await rp.start(c, { redirectUri: REDIRECT });
  const back = await authorize(start.url);
  expect(back.searchParams.get("state")).toBe(start.state);
  return rp.finish(c, {
    code: back.searchParams.get("code")!,
    redirectUri: REDIRECT,
    codeVerifier: start.codeVerifier,
    nonce: start.nonce,
  });
}

async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

/** A server answering discovery with `doc`, for the documents the mock would never serve. */
async function serveDiscovery(doc: (issuer: string) => unknown, status = 200): Promise<{ issuer: string; server: Server }> {
  let issuer = "";
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(doc(issuer)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, server };
}

describe("discovery", () => {
  it("reads the endpoints and keeps the provider's own spelling of its issuer", async () => {
    const meta = await fetchProviderMetadata(`${idp.issuer}/`);
    expect(meta).toMatchObject({
      issuer: idp.issuer,
      authorization_endpoint: `${idp.issuer}/authorize`,
      token_endpoint: `${idp.issuer}/token`,
      jwks_uri: `${idp.issuer}/jwks`,
    });
  });

  it.each([
    ["an issuer that is someone else", (i: string) => ({ ...complete(i), issuer: "https://elsewhere.test" }), "discovery_issuer"],
    ["no token endpoint", (i: string) => ({ ...complete(i), token_endpoint: undefined }), "discovery_incomplete"],
    ["no authorization-code flow", (i: string) => ({ ...complete(i), response_types_supported: ["id_token"] }), "discovery_flow"],
    ["no PKCE S256", (i: string) => ({ ...complete(i), code_challenge_methods_supported: ["plain"] }), "discovery_pkce"],
    ["not a document", () => ["nope"], "discovery_invalid"],
  ])("refuses %s", async (_what, doc, reason) => {
    const { issuer, server } = await serveDiscovery(doc);
    try {
      expect((await refusal(fetchProviderMetadata(issuer))).reason).toBe(reason);
    } finally {
      server.close();
    }
  });

  it("says so when the provider answers an error or cannot be reached", async () => {
    const { issuer, server } = await serveDiscovery(() => ({}), 500);
    expect((await refusal(fetchProviderMetadata(issuer))).reason).toBe("discovery_status");
    server.close();
    await idp.stop();
    expect((await refusal(fetchProviderMetadata(idp.issuer))).reason).toBe("discovery_unreachable");
  });

  it("keeps the last good document when the provider goes away", async () => {
    const rp = createRelyingParty({ discoveryTtlMs: 0 });
    await rp.start(client(), { redirectUri: REDIRECT });
    await idp.stop();
    const start = await rp.start(client(), { redirectUri: REDIRECT });
    expect(start.url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
    await expect(createRelyingParty().start(client(), { redirectUri: REDIRECT })).rejects.toBeInstanceOf(ProviderError);
  });
});

function complete(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}

describe("the authorization request", () => {
  it("carries PKCE S256, state and nonce, all fresh each time", async () => {
    const rp = createRelyingParty();
    const a = await rp.start(client(), { redirectUri: REDIRECT });
    const b = await rp.start(client(), { redirectUri: REDIRECT });
    const url = new URL(a.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "stuga",
      redirect_uri: REDIRECT,
      scope: "openid profile email",
      state: a.state,
      nonce: a.nonce,
      code_challenge: codeChallenge(a.codeVerifier),
      code_challenge_method: "S256",
    });
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(new Set([a.state, a.nonce, a.codeVerifier, b.state, b.nonce, b.codeVerifier]).size).toBe(6);
  });

  it("asks which account with prompt=select_account, and the provider signs in whoever is picked", async () => {
    const rp = createRelyingParty();
    const start = await rp.start(client(), { redirectUri: REDIRECT, prompt: "select_account" });
    expect(new URL(start.url).searchParams.get("prompt")).toBe("select_account");
    idp.chooses = { sub: "mock-subject-2", preferred_username: "bea" };
    const back = await authorize(start.url);
    const who = await rp.finish(client(), {
      code: back.searchParams.get("code")!,
      redirectUri: REDIRECT,
      codeVerifier: start.codeVerifier,
      nonce: start.nonce,
    });
    expect(who).toMatchObject({ sub: "mock-subject-2", preferredUsername: "bea" });
    expect(idp.prompts).toEqual(["select_account"]);
  });

  it("asks for a silent answer with prompt=none, which a provider without a session refuses", async () => {
    const start = await createRelyingParty().start(client(), { redirectUri: REDIRECT, prompt: "none" });
    expect(new URL(start.url).searchParams.get("prompt")).toBe("none");
    idp.loggedIn = false;
    const back = await authorize(start.url);
    expect(back.searchParams.get("error")).toBe("login_required");
    expect(back.searchParams.get("state")).toBe(start.state);
  });
});

describe("finishing a sign-in", () => {
  it("returns who the provider vouches for", async () => {
    expect(await signIn()).toEqual({
      sub: "mock-subject-1",
      preferredUsername: "ada",
      name: "Ada Lovelace",
      email: "ada@example.test",
    });
    expect(idp.tokenRequests).toEqual([{ auth: "none", ok: true }]);
  });

  it("proves the code with the verifier: another verifier is refused, and a code is spent once", async () => {
    const rp = createRelyingParty();
    const start = await rp.start(client(), { redirectUri: REDIRECT });
    const code = (await authorize(start.url)).searchParams.get("code")!;
    const finish = (codeVerifier: string) => rp.finish(client(), { code, redirectUri: REDIRECT, codeVerifier, nonce: start.nonce });
    expect((await refusal(finish("not-the-verifier-not-the-verifier-not-the-verifier"))).reason).toBe("token_invalid_grant");
    // The mock burns a code on a failed redemption, as providers should.
    expect((await refusal(finish(start.codeVerifier))).reason).toBe("token_invalid_grant");
  });

  it("repeats the redirect URI exactly", async () => {
    const rp = createRelyingParty();
    const start = await rp.start(client(), { redirectUri: REDIRECT });
    const code = (await authorize(start.url)).searchParams.get("code")!;
    const err = await refusal(
      rp.finish(client(), { code, redirectUri: "http://elsewhere.test/auth/oidc/callback", codeVerifier: start.codeVerifier, nonce: start.nonce }),
    );
    expect(err.reason).toBe("token_invalid_grant");
  });

  it("authenticates a confidential client with client_secret_basic", async () => {
    await idp.stop();
    idp = await startMockProvider({ clientSecret: "s3cret: with spaces" });
    await signIn();
    expect(idp.tokenRequests).toEqual([{ auth: "client_secret_basic", ok: true }]);
    const wrong = await refusal(signIn(createRelyingParty(), client({ clientSecret: "wrong" })));
    expect(wrong.reason).toBe("token_invalid_client");
  });

  it("uses client_secret_post when that is all the provider offers", async () => {
    await idp.stop();
    idp = await startMockProvider({ clientSecret: "s3cret", tokenAuthMethods: ["client_secret_post"] });
    await signIn();
    expect(idp.tokenRequests).toEqual([{ auth: "client_secret_post", ok: true }]);
  });

  it("keeps an unusable email out, and control characters out of the names", async () => {
    idp.user = { sub: "s-2", preferred_username: "a\u0000da\u200b", name: "  Ada\nLovelace ", email: "ada@example.test\r\nBcc: x@y.z" };
    expect(await signIn()).toEqual({ sub: "s-2", preferredUsername: "a da", name: "Ada Lovelace", email: null });
  });
});

describe("the id_token", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it.each<[string, Record<string, unknown>, RegExp | string]>([
    ["from another issuer", { iss: "http://127.0.0.1:1" }, "id_token_invalid"],
    ["for another client", { aud: "someone-else" }, "id_token_invalid"],
    ["answering another sign-in", { nonce: "a-different-nonce" }, "id_token_nonce"],
    ["expired", { iat: now() - 3600, exp: now() - 1800 }, "id_token_invalid"],
    ["minted long ago", { iat: now() - 3600 }, "id_token_invalid"],
    ["with several audiences and no authorized party", { aud: ["stuga", "another-app"] }, "id_token_azp"],
    ["whose authorized party is another client", { azp: "another-app" }, "id_token_azp"],
    ["with no subject", { sub: "" }, "id_token_sub"],
  ])("is refused when %s", async (_what, overrides, reason) => {
    idp.overrides = overrides;
    expect((await refusal(signIn())).reason).toBe(reason);
  });

  it("is accepted with several audiences when this client is the authorized party", async () => {
    idp.overrides = { aud: ["stuga", "another-app"], azp: "stuga" };
    expect((await signIn()).sub).toBe("mock-subject-1");
  });

  it("is refused unsigned or signed with a shared secret", async () => {
    for (const alg of ["none", "HS256"] as const) {
      idp.alg = alg;
      const err = await refusal(signIn());
      expect(err.reason).toBe("id_token_invalid");
    }
  });
});

describe("the mock provider by hand", () => {
  let manual: MockProvider;
  beforeEach(async () => {
    manual = await startMockProvider({ interactive: true });
  });
  afterEach(async () => {
    await manual.stop();
  });

  const url = async (prompt?: "none" | "select_account") =>
    (await createRelyingParty().start(client({ issuer: manual.issuer, clientId: manual.clientId }), { redirectUri: REDIRECT, prompt })).url;

  /** One browser: the mock's session cookie, sent back as a browser would. */
  function browser() {
    let cookie = "";
    const go = async (target: string, init: RequestInit = {}) => {
      const res = await fetch(target, { ...init, redirect: "manual", headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
      return res;
    };
    const signIn = async (sub: string) => {
      const form = new URL(await url());
      return go(`${manual.issuer}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(form.searchParams), sub, decision: "allow" }),
      });
    };
    return { go, signIn };
  }

  it("keeps a session like a real provider: asks once, then answers on its own until asked to choose", async () => {
    const ada = browser();
    expect((await ada.go(await url())).status).toBe(200);
    expect((await ada.go(await url("none"))).headers.get("location")).toContain("error=login_required");
    expect((await ada.signIn("someone")).status).toBe(302);
    expect((await ada.go(await url())).status).toBe(302);
    expect((await ada.go(await url("none"))).headers.get("location")).toContain("code=");
    const chooser = await ada.go(await url("select_account"));
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain("<form");
    expect(manual.prompts).toEqual([null, "none", null, "none", "select_account"]);
  });

  it("keeps each browser's session apart, and signs out only the browser that asks", async () => {
    const ada = browser();
    const bob = browser();
    await ada.signIn("ada-subject");
    await bob.signIn("bob-subject");
    // A third browser has no session: the form, and a silent sign-in is refused.
    const fresh = browser();
    expect((await fresh.go(await url())).status).toBe(200);
    expect((await fresh.go(await url("none"))).headers.get("location")).toContain("error=login_required");

    expect((await ada.go(`${manual.issuer}/logout`)).status).toBe(200);
    expect((await ada.go(await url("none"))).headers.get("location")).toContain("error=login_required");
    const rp = createRelyingParty();
    const provider = client({ issuer: manual.issuer, clientId: manual.clientId });
    const silent = await rp.start(provider, { redirectUri: REDIRECT, prompt: "none" });
    const stillBob = await bob.go(silent.url);
    const code = new URL(stillBob.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    const who = await rp.finish(provider, { code: code!, redirectUri: REDIRECT, codeVerifier: silent.codeVerifier, nonce: silent.nonce });
    expect(who.sub).toBe("bob-subject");
  });
});
