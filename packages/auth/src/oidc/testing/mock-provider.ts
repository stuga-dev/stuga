/**
 * A tiny OpenID Connect provider for tests and for trying the sign-in flow by
 * hand: discovery, a JWKS with one RS256 key, an authorize endpoint and a token
 * endpoint that checks PKCE, redirect_uri and client authentication. Never
 * imported by production code.
 *
 * In tests, `startMockProvider()` listens on an ephemeral port and consents on
 * its own; knobs on the returned object change who signs in and what the next
 * id_token says.
 *
 * By hand, it asks who you are on a small form (sub, username, name, email) and
 * then remembers you in that browser, in a cookie of its own as a real
 * provider's session is: later sign-ins from that browser go straight through,
 * silent ones included, until it opens /logout, and another browser starts
 * signed out. A sign-in with prompt=select_account shows the form again, to
 * pick someone else:
 *
 *   pnpm --filter @stuga/auth exec tsx src/oidc/testing/mock-provider.ts --port 9876 [--client-id stuga] [--client-secret s3cret]
 *
 * It prints its issuer; enter that and the client ID in Settings → This node →
 * Access, and register nothing: the mock accepts any redirect URI.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

/** Who signs in at the provider. */
export interface MockUser {
  sub: string;
  preferred_username?: string;
  name?: string;
  email?: string;
}

export interface MockProviderOptions {
  /** 0, the default, picks a free port. */
  port?: number;
  clientId?: string;
  /** Null, the default, registers a public client. */
  clientSecret?: string | null;
  /** Show a sign-in form instead of consenting on its own. */
  interactive?: boolean;
  /** What the discovery document says the token endpoint accepts. */
  tokenAuthMethods?: string[];
}

export interface MockProvider {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  /** Who the next automatic sign-in is. */
  user: MockUser;
  /**
   * In tests: whether the person has a session here; false makes prompt=none
   * answer login_required. By hand each browser keeps its own session in a cookie
   * instead, and this is not consulted.
   */
  loggedIn: boolean;
  /** Whom the person picks when asked which account (prompt=select_account); null keeps `user`. */
  chooses: MockUser | null;
  /** The `prompt` of every authorization request, in order; null when there was none. */
  readonly prompts: Array<string | null>;
  /** Answer the next authorizations with `error=<code>` instead of a code. */
  deny: string | null;
  /** Claims written over the next id_tokens' (iss, aud, azp, nonce, exp, iat, sub…). */
  overrides: Record<string, unknown>;
  /** How id_tokens are signed; HS256 and none exist to be refused. */
  alg: "RS256" | "HS256" | "none";
  /** How the client authenticated at the token endpoint, per request. */
  readonly tokenRequests: Array<{ auth: "client_secret_basic" | "client_secret_post" | "none"; ok: boolean }>;
  /** Stop listening; later requests to the issuer fail to connect. */
  stop(): Promise<void>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | null;
  user: MockUser;
  used: boolean;
}

const KID = "mock-rs256";
const HS_SECRET = new TextEncoder().encode("a shared secret the relying party must never accept");

/** One RSA key per process: generating one is the slowest thing a test run of the mock does. */
let signingKey: Promise<{ privateKey: CryptoKey; jwk: JWK }> | null = null;
function rsaKey(): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  signingKey ??= (async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" } };
  })();
  return signingKey;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, to: URL, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location: to.toString(), ...headers });
  res.end();
}

/** The cookie a browser's session at the mock rides in, by hand. */
const SESSION_COOKIE = "mock_idp_session";

function sessionCookie(id: string, maxAgeSeconds?: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${maxAgeSeconds === undefined ? "" : `; Max-Age=${maxAgeSeconds}`}`;
}

function sessionId(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function formDecode(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, " "));
}

export async function startMockProvider(opts: MockProviderOptions = {}): Promise<MockProvider> {
  const { privateKey, jwk } = await rsaKey();
  const codes = new Map<string, PendingCode>();
  /** By hand: who each browser is signed in as, by its session cookie. */
  const sessions = new Map<string, MockUser>();
  let issuer = "";

  const provider: MockProvider = {
    issuer: "",
    clientId: opts.clientId ?? "stuga",
    clientSecret: opts.clientSecret ?? null,
    user: { sub: "mock-subject-1", preferred_username: "ada", name: "Ada Lovelace", email: "ada@example.test" },
    loggedIn: true,
    chooses: null,
    prompts: [],
    deny: null,
    overrides: {},
    alg: "RS256",
    tokenRequests: [],
    stop: async () => {},
  };

  function mintCode(params: URLSearchParams, user: MockUser): string {
    const code = randomBytes(16).toString("base64url");
    codes.set(code, {
      clientId: params.get("client_id") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      challenge: params.get("code_challenge") ?? "",
      nonce: params.get("nonce"),
      user: { ...user },
      used: false,
    });
    return code;
  }

  function back(params: URLSearchParams, answer: Record<string, string>): URL {
    const to = new URL(params.get("redirect_uri")!);
    for (const [k, v] of Object.entries(answer)) to.searchParams.set(k, v);
    const state = params.get("state");
    if (state !== null) to.searchParams.set("state", state);
    return to;
  }

  function authorize(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void {
    const redirectUri = params.get("redirect_uri");
    if (params.get("client_id") !== provider.clientId || !redirectUri) {
      sendJson(res, 400, { error: "invalid_request", error_description: "unknown client_id or no redirect_uri" });
      return;
    }
    if (params.get("response_type") !== "code") return redirect(res, back(params, { error: "unsupported_response_type" }));
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
      return redirect(res, back(params, { error: "invalid_request" }));
    }
    const prompt = params.get("prompt");
    provider.prompts.push(prompt);
    if (provider.deny) return redirect(res, back(params, { error: provider.deny }));
    // By hand the session is this browser's own; in tests it is the knobs'.
    const id = sessionId(req);
    const session = opts.interactive ? ((id ? sessions.get(id) : undefined) ?? null) : provider.loggedIn ? provider.user : null;
    if (prompt === "none") {
      if (!session) return redirect(res, back(params, { error: "login_required" }));
      return redirect(res, back(params, { code: mintCode(params, session) }));
    }
    const asks = prompt === "select_account" || prompt === "login";
    if (!opts.interactive) {
      if (asks && provider.chooses) provider.user = { ...provider.chooses };
      return redirect(res, back(params, { code: mintCode(params, provider.user) }));
    }
    // A session answers on its own unless the relying party asked the person to choose.
    if (session && !asks) return redirect(res, back(params, { code: mintCode(params, session) }));
    const shown = session ?? provider.user;

    const hidden = [...params.entries()]
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join("");
    const field = (name: keyof MockUser, label: string) =>
      `<label>${label}<br><input name="${name}" value="${escapeHtml(shown[name] ?? "")}"></label><br><br>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Mock identity provider</title>` +
        `<body style="font: 15px system-ui; max-width: 28em; margin: 3em auto">` +
        `<h1 style="font-size: 20px">Mock identity provider</h1>` +
        `<p>Signing in to <code>${escapeHtml(provider.clientId)}</code>. The subject is who you are to the node.</p>` +
        `<form method="post" action="/authorize">${hidden}` +
        field("sub", "Subject (sub)") +
        field("preferred_username", "Preferred username") +
        field("name", "Name") +
        field("email", "Email") +
        `<button name="decision" value="allow">Sign in</button> <button name="decision" value="deny">Deny</button>` +
        `</form></body>`,
    );
  }

  async function decide(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readBody(req);
    if (form.get("client_id") !== provider.clientId || !form.get("redirect_uri")) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    if (form.get("decision") !== "allow") return redirect(res, back(form, { error: "access_denied" }));
    const typed = (k: string) => form.get(k)?.trim() || undefined;
    const user: MockUser = { sub: typed("sub") ?? provider.user.sub };
    for (const k of ["preferred_username", "name", "email"] as const) {
      const v = typed(k);
      if (v) user[k] = v;
    }
    // This browser's session, replacing any it had; the form's next default.
    const previous = sessionId(req);
    if (previous) sessions.delete(previous);
    const id = randomBytes(16).toString("base64url");
    sessions.set(id, user);
    provider.user = user;
    redirect(res, back(form, { code: mintCode(form, user) }), { "set-cookie": sessionCookie(id) });
  }

  async function idToken(pending: PendingCode): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      aud: provider.clientId,
      iat: now,
      exp: now + 300,
      ...pending.user,
      ...(pending.nonce ? { nonce: pending.nonce } : {}),
      ...provider.overrides,
    };
    if (provider.alg === "none") return new UnsecuredJWT(claims).encode();
    if (provider.alg === "HS256") return new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: KID }).sign(HS_SECRET);
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" }).sign(privateKey);
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readBody(req);
    const basic = req.headers.authorization?.match(/^Basic (.+)$/i);
    let auth: "client_secret_basic" | "client_secret_post" | "none" = "none";
    let clientId = form.get("client_id");
    let secret: string | null = null;
    if (basic) {
      const [id, pw] = Buffer.from(basic[1]!, "base64").toString("utf8").split(":");
      auth = "client_secret_basic";
      clientId = formDecode(id ?? "");
      secret = formDecode(pw ?? "");
    } else if (form.has("client_secret")) {
      auth = "client_secret_post";
      secret = form.get("client_secret");
    }
    const record = (ok: boolean) => provider.tokenRequests.push({ auth, ok });

    const clientOk =
      clientId === provider.clientId && (provider.clientSecret === null ? auth === "none" : secret === provider.clientSecret);
    if (!clientOk) {
      record(false);
      return sendJson(res, 401, { error: "invalid_client" });
    }
    const code = form.get("code") ?? "";
    const pending = codes.get(code);
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      form.get("grant_type") !== "authorization_code" ||
      !pending ||
      pending.used ||
      pending.clientId !== clientId ||
      pending.redirectUri !== form.get("redirect_uri") ||
      pending.challenge !== challenge
    ) {
      if (pending) pending.used = true;
      record(false);
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    pending.used = true;
    record(true);
    sendJson(res, 200, {
      access_token: randomBytes(16).toString("base64url"),
      token_type: "Bearer",
      expires_in: 300,
      id_token: await idToken(pending),
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
    void (async () => {
      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return sendJson(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: opts.tokenAuthMethods ?? ["client_secret_basic", "client_secret_post", "none"],
          scopes_supported: ["openid", "profile", "email"],
        });
      }
      if (req.method === "GET" && url.pathname === "/jwks") return sendJson(res, 200, { keys: [jwk] });
      if (req.method === "GET" && url.pathname === "/authorize") return authorize(req, res, url.searchParams);
      if (req.method === "POST" && url.pathname === "/authorize") return decide(req, res);
      if (req.method === "POST" && url.pathname === "/token") return token(req, res);
      if (req.method === "GET" && url.pathname === "/logout") {
        // Only the browser that asks is signed out, as at a real provider.
        const id = sessionId(req);
        if (id) sessions.delete(id);
        if (!opts.interactive) provider.loggedIn = false;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "set-cookie": sessionCookie("", 0) });
        return res.end("Signed out of the mock identity provider.\n");
      }
      sendJson(res, 404, { error: "not_found" });
    })().catch((err: unknown) => sendJson(res, 500, { error: "server_error", error_description: String(err) }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;
  provider.issuer = issuer;
  provider.stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return provider;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const provider = await startMockProvider({
    port: Number(arg("port") ?? 9876),
    clientId: arg("client-id") ?? "stuga",
    clientSecret: arg("client-secret") ?? null,
    interactive: true,
  });
  console.info(
    `mock identity provider\n  issuer     ${provider.issuer}\n  client ID  ${provider.clientId}\n` +
      `  secret     ${provider.clientSecret ?? "(none: a public client)"}\nCtrl-C to stop.`,
  );
}
