/**
 * The node's sign-in surface (`/auth/*`) and its issuer documents. The node
 * mints every session itself: access tokens verified like any provider's, and
 * refresh tokens stored hashed and rotated on every use, where a replayed one
 * signs the person out everywhere unless it is a duplicate renewal inside the
 * grace window. Passwords always work; the identity provider, when one is set
 * up, is another way to reach the same sessions (see ./provider-routes.ts).
 */
import { randomUUID } from "node:crypto";
import {
  AuthError,
  extractToken,
  hashPassword,
  hashRefreshToken,
  looksLikeApiKey,
  mintRefreshToken,
  newAlias,
  publicJwks,
  randomHex,
  sha256Hex,
  signAccessToken,
  verifyPassword,
  type AuthConfig,
  type LocalKeys,
  type RelyingParty,
  type TokenVerifier,
} from "@stuga/auth";
import type { AccountRow, InviteJoin, RefreshSessionRow } from "@stuga/db";
import {
  USERNAME_RULE,
  isReservedUsername,
  isValidUsername,
  normalizeUsername,
  usernameBase,
  usernameCandidates,
} from "@stuga/protocol/domain/username";
import { hostLabel } from "@stuga/protocol/domain/node-name";
import { SEARCH_LANGUAGES, parseSearchLanguages } from "@stuga/protocol/domain/search-languages";
import type { IdentityProviderSettings } from "../config/settings/node.js";
import { clientAddress } from "../platform/http-server.js";
import type { RateLimiter } from "../platform/rate-limit.js";
import { matchRoute, type Route } from "../http/router.js";
import type { IdentityDb } from "./db.js";
import { fail, field, json, readJson } from "./http.js";
import { MAX_NAME, MAX_PASSWORD, decoy, passwordPolicy } from "./passwords.js";
import { createProviderRoutes } from "./provider-routes.js";
import { setupCodeMatches } from "./setup-code.js";
import { knownTimeZone } from "../config/time-zone.js";

/** A node-level audit row about how a person signs in; the boot wires it to the ledger. */
export interface IdentityEvent {
  alias: string;
  action: "node.identity.link" | "node.identity.unlink";
  detail: Record<string, unknown>;
}

export interface IdentityDeps {
  auth: AuthConfig;
  publicOrigin: string;
  /** Further origins the app is served from; a sign-in through the provider comes back to the one it started on. */
  extraOrigins?: readonly string[];
  db: IdentityDb;
  keys: LocalKeys;
  /** Verifies the session a signed-in person presents to link, unlink or set a password. */
  verifier: TokenVerifier;
  /** The identity provider in force, read per request so a settings save applies at once. */
  identityProvider?: () => IdentityProviderSettings | null;
  /** Discovery and key caches for the provider; one per node. */
  relyingParty?: RelyingParty;
  /** The node's name, label and branding, served before sign-in because the login and consent pages show them. */
  nodeName?: () => string | null;
  nodeLabel?: () => string;
  branding?: () => { accentColor: string | null };
  /**
   * The setup code while nobody has claimed the node (./setup-code.ts): the first account must
   * present it. Null, or absent, and no one can claim the node.
   */
  setupCode?: () => string | null;
  /** Called after the first account claims the node. */
  onFirstAccount?: (alias: string) => void;
  /** Called after a new account joins a workspace through the invite link it was made with. */
  onInviteRedeemed?: (joined: { alias: string; tokenHash: string; workspaceId: string; role: string }) => void;
  /** Called after a person links or unlinks the identity provider. */
  onIdentityChange?: (event: IdentityEvent) => void;
  /**
   * Throttle for the credential endpoints, which are dispatched ahead of the
   * app's rate limiter. Keyed by address and by the account under attack, since
   * there is no principal before sign-in.
   */
  limiter?: RateLimiter;
  /** Believe the proxy's `X-Forwarded-For` / `X-Real-IP` for the address bucket; otherwise they are caller-chosen. */
  trustProxyHeaders?: boolean;
}

export interface IdentityRouter {
  /** True when this router owns `pathname`. */
  matches(pathname: string): boolean;
  /** Answer a request the router owns. Throws on one it does not. */
  handle(request: Request): Promise<Response>;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
}

const IDENTITY_PATHS = new Set(["/.well-known/jwks.json", "/.well-known/openid-configuration"]);

/** Pages under /auth that the app bundle renders: a provider sign-in lands on them with its code in the fragment. */
const APP_PAGES = new Set(["/auth/complete", "/auth/first-visit"]);

/** What the provider endpoints borrow from the router. */
export interface IdentityCore {
  deps: IdentityDeps;
  issueTokens(account: Pick<AccountRow, "alias" | "username">, displayName?: string): Promise<TokenPair>;
  /** An available username close to `raw`, for a 409 or a first visit's form. */
  suggestUsername(raw: string): Promise<string>;
  /** Refuse a username the rule or the reserved list does not allow, with a suggestion; null when it may be tried. */
  usernameRefusal(username: string): Promise<Response | null>;
  /** The 409 for a taken username, with a suggestion. */
  usernameTaken(username: string): Promise<Response>;
  /** Report the workspace a new account joined through the invite it was made with. */
  reportJoin(alias: string, inviteHash: string | null, joined: InviteJoin | null): void;
  /** The 403 for a new account on a claimed node that came without an invite. */
  inviteRequired(): Response;
  /** The 403 for an invite that is used up, revoked or expired. */
  inviteInvalid(): Response;
  /**
   * The account behind the request's bearer, for the endpoints that act on one's
   * own sign-in. Null when there is none; a Response for an agent's key or a bad token.
   */
  bearerAccount(req: Request): Promise<AccountRow | Response | null>;
}

export function createIdentityRouter(deps: IdentityDeps): IdentityRouter {
  const { auth, db, keys } = deps;

  async function issueTokens(account: Pick<AccountRow, "alias" | "username">, displayName?: string): Promise<TokenPair> {
    const name = displayName ?? (await db.displayNameOf(account.alias)) ?? account.username;
    const access = await signAccessToken(keys, {
      alias: account.alias,
      username: account.username,
      displayName: name,
      issuer: auth.issuer,
      audience: auth.audience,
      ttlSeconds: auth.accessTokenTtlSeconds,
    });
    const refresh = mintRefreshToken();
    await db.createRefreshSession({
      id: randomUUID(),
      alias: account.alias,
      tokenHash: refresh.hash,
      expiresAt: new Date(Date.now() + auth.refreshTokenTtlSeconds * 1000),
    });
    return {
      access_token: access,
      refresh_token: refresh.token,
      expires_in: auth.accessTokenTtlSeconds,
      token_type: "Bearer",
    };
  }

  async function suggestUsername(raw: string): Promise<string> {
    const base = usernameBase(raw);
    const nearby = usernameCandidates(base);
    const takenNearby = await db.takenUsernames(nearby);
    const free = nearby.find((name) => !takenNearby.has(name));
    if (free) return free;
    // Every numbered neighbour is taken: a random suffix, checked once more.
    const random = Array.from({ length: 5 }, () => `${base.slice(0, 27)}-${randomHex(2)}`).filter(isValidUsername);
    const takenRandom = await db.takenUsernames(random);
    return random.find((name) => !takenRandom.has(name)) ?? random[0]!;
  }

  async function usernameTaken(username: string): Promise<Response> {
    return json({ error: "username_taken", message: "that username is taken", suggestion: await suggestUsername(username) }, 409);
  }

  async function usernameRefusal(username: string): Promise<Response | null> {
    if (!isValidUsername(username)) return fail(400, "invalid_username", USERNAME_RULE);
    if (isReservedUsername(username)) {
      return json({ error: "username_reserved", message: "that username is reserved", suggestion: await suggestUsername(username) }, 409);
    }
    return null;
  }

  function reportJoin(alias: string, inviteHash: string | null, joined: InviteJoin | null): void {
    if (inviteHash && joined) deps.onInviteRedeemed?.({ alias, tokenHash: inviteHash, ...joined });
  }

  const inviteRequired = () => fail(403, "invite_required", "an invite is required to create an account here");
  const inviteInvalid = () => fail(403, "invite_invalid", "that invite is not valid");
  const setupCodeRequired = () =>
    fail(403, "setup_code_required", "setting up this node needs its setup code, which the node prints in its log");

  async function bearerAccount(req: Request): Promise<AccountRow | Response | null> {
    const token = extractToken(req);
    if (!token) return null;
    // How a person signs in is theirs to change; a key acting for them never may.
    if (looksLikeApiKey(token)) return fail(403, "agent_forbidden", "agents cannot change how a person signs in");
    try {
      const { alias } = await deps.verifier.verify(token);
      return (await db.findAccountByAlias(alias)) ?? fail(401, "invalid_token", "sign in again");
    } catch (err) {
      if (err instanceof AuthError) return fail(401, "invalid_token", "sign in again");
      throw err;
    }
  }

  const core: IdentityCore = {
    deps,
    issueTokens,
    suggestUsername,
    usernameRefusal,
    usernameTaken,
    reportJoin,
    inviteRequired,
    inviteInvalid,
    bearerAccount,
  };
  const provider = createProviderRoutes(core);

  async function config(): Promise<Response> {
    // No account yet: the SPA opens on first-run setup, whose account administers the node.
    // Once claimed, an account is created only with an invite link.
    const unclaimed = (await db.countAccounts()) === 0;
    const idp = deps.identityProvider?.() ?? null;
    const b = deps.branding?.() ?? { accentColor: null };
    return json({
      provider: idp ? { label: idp.label } : null,
      unclaimed,
      // The name an administrator gave the node, shown in place of the product's; null until there is one.
      node_name: deps.nodeName?.() ?? null,
      // Which node this is, as /mcp names it: the stdio server reads it and the origin, whatever address it reached the node at.
      node_label: deps.nodeLabel?.() ?? hostLabel(deps.publicOrigin),
      origin: deps.publicOrigin,
      branding: { accent_color: b.accentColor },
    });
  }

  async function register(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const username = normalizeUsername(field(body, "username"));
    const password = field(body, "password");
    const name = field(body, "name").trim().slice(0, MAX_NAME);
    const invite = field(body, "invite").trim();
    // Setup asks whether the node may look for newer versions. Only the account that claims the node gets a say.
    if (body.update_check !== undefined && typeof body.update_check !== "boolean") {
      return fail(400, "bad_request", "update_check must be true or false");
    }
    const updateCheck = body.update_check as boolean | undefined;
    // And the time zone the node's schedule runs in, which is the browser's: an unknown name is dropped, not refused.
    const timeZone = knownTimeZone(body.time_zone);
    // And the languages search gets a tokenizer for: only the choices this build offers.
    const searchLanguages = body.search_languages === undefined ? undefined : parseSearchLanguages(body.search_languages);
    if (searchLanguages === null) {
      return fail(400, "bad_request", `search_languages must be a list of: ${SEARCH_LANGUAGES.join(", ")}`);
    }
    const refused = await usernameRefusal(username);
    if (refused) return refused;
    const weak = passwordPolicy(password);
    if (weak) return weak;

    // The first account claims the node and administers it, and only whoever holds
    // the node's setup code may make it; everyone after needs an invite link. There
    // is no open signup: on a LAN that is anyone on the Wi-Fi, and on a public
    // hostname anyone who finds the certificate's name. Checked here only to refuse
    // early, before scrypt: the account's own transaction decides whether it is the
    // first, and spends the invite.
    const inviteHash = invite ? sha256Hex(invite) : null;
    let mayClaim = false;
    if ((await db.countAccounts()) > 0) {
      if (!inviteHash) return inviteRequired();
      if (!(await db.inviteIsRedeemable(inviteHash))) return inviteInvalid();
    } else {
      const code = field(body, "setup_code");
      if (!code.trim()) return setupCodeRequired();
      if (!setupCodeMatches(deps.setupCode?.() ?? null, code)) {
        return fail(403, "setup_code_invalid", "that is not this node's setup code");
      }
      mayClaim = true;
    }

    const passwordHash = await hashPassword(password);
    const alias = newAlias();
    const displayName = name || username;
    const made = await db.createLocalAccount({
      alias,
      username,
      passwordHash,
      displayName,
      inviteHash,
      mayClaim,
      updateCheck,
      ...(timeZone ? { timeZone } : {}),
      ...(searchLanguages ? { searchLanguages } : {}),
    });
    if (!made.ok) {
      if (made.reason === "username_taken") return usernameTaken(username);
      if (made.reason === "setup_code_required") return setupCodeRequired();
      return made.reason === "invite_required" ? inviteRequired() : inviteInvalid();
    }
    if (made.admin) deps.onFirstAccount?.(alias);
    reportJoin(alias, inviteHash, made.joined);

    return json(await issueTokens(made.account, displayName), 201);
  }

  /**
   * `/auth/password` does two things. Changing a password is authenticated by
   * the current one rather than a session, so a stolen session cannot lock the
   * owner out, and revokes every other session. Setting a first password, for
   * an account made through the identity provider, has no current one to
   * present, so it takes the session instead.
   */
  async function password(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    if (!field(body, "current_password") && extractToken(req)) return setPassword(req, body);
    return changePassword(body);
  }

  async function changePassword(body: Record<string, unknown>): Promise<Response> {
    const username = normalizeUsername(field(body, "username"));
    const current = field(body, "current_password");
    const next = field(body, "new_password");
    if (!username || !current) return fail(400, "bad_request", "username and current_password are required");
    const weak = passwordPolicy(next);
    if (weak) return weak;

    const account = await db.findAccountByUsername(username);
    // An account with no password answers exactly as a wrong one does.
    const ok = await verifyPassword(current, account?.password_hash ?? (await decoy()));
    if (!account?.password_hash || !ok) return fail(401, "invalid_credentials", "username or password is incorrect");

    await db.updateLocalPassword(account.alias, await hashPassword(next));
    await db.revokeRefreshSessions(account.alias);
    return json(await issueTokens(account));
  }

  async function setPassword(req: Request, body: Record<string, unknown>): Promise<Response> {
    const account = await bearerAccount(req);
    if (account instanceof Response) return account;
    if (!account) return fail(401, "invalid_token", "sign in again");
    const next = field(body, "new_password");
    const weak = passwordPolicy(next);
    if (weak) return weak;
    const setAlready = () => fail(409, "password_set", "this account already has a password; change it with the current one");
    if (account.password_hash) return setAlready();
    if (!(await db.addLocalPassword(account.alias, await hashPassword(next)))) return setAlready();
    return new Response(null, { status: 204 });
  }

  /** Redeem a one-time reset link: unauthenticated, because the token names the account. */
  async function resetPassword(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const token = field(body, "token").trim();
    const next = field(body, "new_password");
    if (!token) return fail(400, "bad_request", "token is required");
    const weak = passwordPolicy(next);
    if (weak) return weak;

    // Also how an account made through the identity provider gets its first password once the provider is gone.
    const alias = await db.redeemPasswordReset(sha256Hex(token), await hashPassword(next));
    if (!alias) return fail(403, "reset_invalid", "this reset link is invalid, expired, or already used");

    // Every refresh session dies; issued access tokens still verify until ACCESS_TOKEN_TTL_SECONDS runs out.
    await db.revokeRefreshSessions(alias);
    const account = await db.findAccountByAlias(alias);
    if (!account) return fail(403, "reset_invalid", "this reset link is invalid, expired, or already used");
    return json(await issueTokens(account));
  }

  async function login(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const username = normalizeUsername(field(body, "username"));
    const password = field(body, "password");
    if (!username || !password) return fail(400, "bad_request", "username and password are required");
    // Refused before hashing: scrypt cost grows with the input.
    if (password.length > MAX_PASSWORD) return fail(401, "invalid_credentials", "username or password is incorrect");

    const account = await db.findAccountByUsername(username);
    const ok = await verifyPassword(password, account?.password_hash ?? (await decoy()));
    if (!account?.password_hash || !ok) return fail(401, "invalid_credentials", "username or password is incorrect");

    return json(await issueTokens(account));
  }

  /** Epoch ms for a timestamp column, whichever shape the driver hands back. */
  function epochMs(v: string | Date | null): number | null {
    if (v === null) return null;
    const ms = v instanceof Date ? v.getTime() : Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Whether `stale` was rotated (only rotation sets `replaced_by`; a sign-out
   * does not) inside the grace window, and its successor is still live: a
   * duplicate renewal rather than a replay.
   */
  async function rotatedRecently(stale: RefreshSessionRow | null): Promise<boolean> {
    const grace = auth.refreshRotationGraceSeconds;
    if (grace <= 0 || !stale?.replaced_by) return false;
    const revokedAt = epochMs(stale.revoked_at);
    if (revokedAt === null || Date.now() - revokedAt > grace * 1000) return false;
    const successor = await db.findRefreshSession(stale.replaced_by);
    if (!successor || successor.revoked_at !== null) return false;
    const expiresAt = epochMs(successor.expires_at);
    return expiresAt !== null && expiresAt > Date.now();
  }

  /** Renewal never asks the identity provider anything: a session outlives the provider being down or removed. */
  async function refresh(req: Request): Promise<Response> {
    const body = await readJson(req);
    const presented = body ? field(body, "refresh_token").trim() : "";
    if (!presented) return fail(400, "bad_request", "refresh_token is required");

    const tokenHash = hashRefreshToken(presented);
    const next = mintRefreshToken();
    const rotated = await db.rotateRefreshSession({
      tokenHash,
      id: randomUUID(),
      nextTokenHash: next.hash,
      expiresAt: new Date(Date.now() + auth.refreshTokenTtlSeconds * 1000),
    });
    if (!rotated) {
      const stale = await db.findRefreshSession(tokenHash);
      // A duplicate renewal (two tabs, or a lost response): issue a sibling session and leave the successor alone.
      if (stale && (await rotatedRecently(stale))) {
        const account = await db.findAccountByAlias(stale.alias);
        if (account) return json(await issueTokens(account));
      }
      // A replay: whoever holds the live successor loses it too.
      if (stale?.revoked_at) await db.revokeRefreshSessions(stale.alias);
      return fail(401, "invalid_refresh_token", "refresh token is unknown, expired or revoked");
    }

    const account = await db.findAccountByAlias(rotated.alias);
    if (!account) {
      await db.revokeRefreshSession(next.hash);
      return fail(401, "invalid_refresh_token", "account no longer exists");
    }
    const displayName = (await db.displayNameOf(account.alias)) ?? account.username;
    const access = await signAccessToken(keys, {
      alias: account.alias,
      username: account.username,
      displayName,
      issuer: auth.issuer,
      audience: auth.audience,
      ttlSeconds: auth.accessTokenTtlSeconds,
    });
    const pair: TokenPair = {
      access_token: access,
      refresh_token: next.token,
      expires_in: auth.accessTokenTtlSeconds,
      token_type: "Bearer",
    };
    return json(pair);
  }

  /** Also drops any link to the identity provider the account started here and never finished. */
  async function logout(req: Request): Promise<Response> {
    const body = await readJson(req);
    const presented = body ? field(body, "refresh_token").trim() : "";
    if (presented) await db.endSession(hashRefreshToken(presented));
    return new Response(null, { status: 204 });
  }

  function jwks(): Response {
    return new Response(JSON.stringify(publicJwks(keys)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }

  function discovery(): Response {
    return json({
      issuer: auth.issuer,
      jwks_uri: `${deps.publicOrigin}/.well-known/jwks.json`,
      token_endpoint: null,
    });
  }

  const methodNotAllowed = (allow: string): Response =>
    new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { allow, "content-type": "application/json; charset=utf-8" },
    });

  /** The endpoints worth guessing against; refresh and logout present a token they already hold. */
  const THROTTLED = new Set([
    "/auth/login",
    "/auth/register",
    "/auth/password",
    "/auth/reset",
    "/auth/oidc/start",
    "/auth/oidc/complete",
    "/auth/oidc/link",
  ]);

  /** Two buckets per attempt, both of which must have budget: the source address and the targeted identifier. */
  async function throttled(req: Request, path: string): Promise<Response | null> {
    if (!deps.limiter || !THROTTLED.has(path)) return null;
    const keys = [`auth:ip:${clientAddress(req, deps.trustProxyHeaders ?? false)}`];
    const target = await req
      .clone()
      .json()
      .then((b: unknown) => {
        const o = (b ?? {}) as Record<string, unknown>;
        const username = typeof o.username === "string" ? normalizeUsername(o.username) : "";
        const token = typeof o.token === "string" ? o.token : "";
        return username || (token ? `token:${sha256Hex(token)}` : "");
      })
      .catch(() => "");
    if (target) keys.push(`auth:id:${target}`);
    for (const key of keys) {
      const { success } = await deps.limiter.limit({ key });
      if (!success) {
        return new Response(JSON.stringify({ error: "rate_limited", message: "too many attempts; try again shortly" }), {
          status: 429,
          headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
        });
      }
    }
    return null;
  }

  const get = (path: string, answer: (req: Request) => Response | Promise<Response>): IdentityRoute[] => [
    { method: ["GET", "HEAD"], path, handler: async (req) => answer(req) },
    { method: "*", path, handler: async () => methodNotAllowed("GET") },
  ];
  const post = (path: string, answer: (req: Request) => Promise<Response>): IdentityRoute[] => [
    { method: "POST", path, handler: answer },
    { method: "*", path, handler: async () => methodNotAllowed("POST") },
  ];
  const routes: readonly IdentityRoute[] = [
    ...get("/.well-known/jwks.json", jwks),
    ...get("/.well-known/openid-configuration", discovery),
    ...get("/auth/config", config),
    ...post("/auth/register", register),
    ...post("/auth/login", login),
    ...post("/auth/password", password),
    ...post("/auth/reset", resetPassword),
    ...post("/auth/refresh", refresh),
    ...post("/auth/logout", logout),
    ...post("/auth/oidc/start", provider.start),
    ...get("/auth/oidc/callback", provider.callback),
    ...post("/auth/oidc/handoff", provider.handoff),
    ...post("/auth/oidc/ticket", provider.ticket),
    ...post("/auth/oidc/complete", provider.complete),
    ...post("/auth/oidc/link", provider.link),
    ...post("/auth/oidc/unlink", provider.unlink),
  ];

  return {
    matches(pathname) {
      if (APP_PAGES.has(pathname)) return false;
      return pathname === "/auth" || pathname.startsWith("/auth/") || IDENTITY_PATHS.has(pathname);
    },
    async handle(req) {
      const path = new URL(req.url).pathname;
      const method = req.method.toUpperCase();
      if (method === "POST") {
        const limited = await throttled(req, path);
        if (limited) return limited;
      }
      const found = matchRoute(routes, method, path);
      if (found) return found.route.handler(req);
      if (this.matches(path)) return fail(404, "not_found", `no route for ${method} ${path}`);
      throw new Error(`identity router does not own ${path}`);
    },
  };
}

interface IdentityRoute extends Route {
  handler: (req: Request) => Promise<Response>;
}
