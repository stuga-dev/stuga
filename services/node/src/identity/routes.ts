/**
 * The node's sign-in surface (`/auth/*`) and its issuer documents. The node
 * mints every session itself: access tokens verified like any provider's, and
 * refresh tokens stored hashed and rotated on every use, where a replayed one
 * signs the person out everywhere unless it is a duplicate renewal inside the
 * grace window. Passwords always work; the identity provider, when one is set
 * up, is another way to reach the same sessions (see ./provider-routes.ts).
 *
 * A session belongs to the listener it was signed in at: its access tokens carry
 * that listener's audience and its `sid`, and its refresh token renews only
 * there. At the remote address it lapses sooner unused, and ends at a fixed time
 * after the sign-in, however often it renews.
 */
import { randomUUID } from "node:crypto";
import {
  AuthError,
  REMOTE_SESSION_DEFAULTS,
  audienceFor,
  createHashQueue,
  extractToken,
  hashRefreshToken,
  looksLikeApiKey,
  mintRefreshToken,
  newAlias,
  publicJwks,
  randomHex,
  sha256Hex,
  signAccessToken,
  type AuthConfig,
  type HashQueue,
  type LocalKeys,
  type RelyingParty,
  type TokenVerifier,
} from "@stuga/auth";
import type { AccountRow, CredentialArrival, InviteJoin, RefreshSessionRow, SignedInWith, StillHolds } from "@stuga/db";
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
import { negotiateUiLanguage, parseAcceptLanguage } from "@stuga/protocol/domain/ui-languages";
import type { IdentityProviderSettings } from "../config/settings/node.js";
import type { RateLimiter } from "../platform/rate-limit.js";
import { arrivalOf, clientBucket, servedOrigin, tokenArrival } from "../http/arrival.js";
import { clientAddress } from "../platform/http-server.js";
import { verifyPersonToken, type PersonToken } from "../auth/person-token.js";
import { matchRoute, type Route } from "../http/router.js";
import type { IdentityDb } from "./db.js";
import { fail, field, json, readJson } from "./http.js";
import type { SecurityAlerts } from "./alerts.js";
import { deviceCookie, deviceHash, deviceLabel, newDeviceValue, readDeviceCookie } from "./devices.js";
import { createPasswordChecks, type PasswordChecks } from "./check-password.js";
import { createPasskeyChallenges, type PasskeyChallenges } from "./passkey-challenges.js";
import { createPasskeyRoutes, passkeySite } from "./passkey-routes.js";
import { createPasswordNetworkCheck, type PasswordNetworkCheck } from "./off-network.js";
import { MAX_NAME, passwordPolicy } from "./passwords.js";
import { confirmationMethods, confirmedRecently, reauthRequired } from "./recency.js";
import { createSignInLimits, type SignInLimits } from "./sign-in-limits.js";
import { createProviderRoutes } from "./provider-routes.js";
import { setupCodeMatches } from "./setup-code.js";
import { knownTimeZone } from "../config/time-zone.js";

/** A node-level audit row about how a person signs in; the boot wires it to the ledger. */
export interface IdentityEvent {
  alias: string;
  action:
    | "node.identity.link"
    | "node.identity.unlink"
    | "node.session.wrong_address"
    | "node.sign_in.new_device"
    | "node.account.revoke_everything"
    | "node.passkey.add";
  detail: Record<string, unknown>;
}

/** How often one session's refresh token tried at the other address is recorded. */
const WRONG_ADDRESS_EVERY_MS = 60 * 60 * 1000;
/** Sessions remembered for that; past it the memory starts over, at worst recording one again. */
const WRONG_ADDRESS_SESSIONS = 10_000;

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
  onInviteRedeemed?: (joined: { alias: string; tokenHash: string } & InviteJoin) => void;
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
  /** The node's name at its remote address, once bound: what an unnamed node goes by there, in place of its LAN host. */
  remoteId?: () => string | null;
  /** Called after sessions of an account end, so the sockets they opened close: those of `sessionIds`, or all of its. */
  onSessionsEnded?: (alias: string, sessionIds?: string[]) => void;
  /** The remote address while it is on, for /auth/config; null while off or never bound. */
  remoteOrigin?: () => string | null;
  /**
   * Whether a password may come from where this request did (./off-network.ts). The boot's knows
   * TLS_CERT_DIR and LOCAL_PASSWORD_NETWORKS; absent, plain http and none.
   */
  passwordNetwork?: PasswordNetworkCheck;
  /** Wrong-password counts; one per node, made here when absent. */
  signInLimits?: SignInLimits;
  /** The node's password hashes at once; one per node, made here when absent. */
  hashQueue?: HashQueue;
  /** What people are told about their own sign-ins (./alerts.ts); none when absent. */
  alerts?: SecurityAlerts;
  /** Passkey challenges, signed with a key that lives only as long as this process; made here when absent. */
  passkeyChallenges?: PasskeyChallenges;
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

/** A new session, and the device cookie that goes with it (./devices.ts). */
export interface SignedIn {
  tokens: TokenPair;
  cookie: string;
  /** "Sign in faster next time" is due: a password sign-in at the remote address by someone with no passkey there. */
  passkeyOffer: boolean;
}

/** `res` with each cookie set on it. */
export function withCookies(res: Response, cookies: ReadonlyArray<string | null | undefined>): Response {
  for (const cookie of cookies) if (cookie) res.headers.append("set-cookie", cookie);
  return res;
}

const IDENTITY_PATHS = new Set(["/.well-known/jwks.json", "/.well-known/openid-configuration"]);

/** Pages under /auth that the app bundle renders: a provider sign-in lands on them with its code in the fragment. */
const APP_PAGES = new Set(["/auth/complete", "/auth/first-visit"]);

/** What the provider endpoints borrow from the router. */
export interface IdentityCore {
  deps: IdentityDeps;
  /**
   * Every sign-in's one exit: a new session at the listener `req` came in on, begun by
   * `signedInWith`, and this browser remembered for the account there. A browser new to the
   * account at the remote address is reported, except for an account just made.
   */
  signIn(req: Request, account: Pick<AccountRow, "alias" | "username">, signedInWith: SignedInWith, opts?: SignInOptions): Promise<SignedIn>;
  /**
   * `signIn`, only while `requires` still holds when the session is written: null, with nothing
   * written, when the password checked is no longer the account's or the sign-in that asked ended.
   */
  signInIf(
    req: Request,
    account: Pick<AccountRow, "alias" | "username">,
    signedInWith: SignedInWith,
    requires: StillHolds,
    opts?: SignInOptions,
  ): Promise<SignedIn | null>;
  /** The hashed device cookie of a browser `account` signed in from before at this listener, or null. */
  knownDevice(req: Request, account: AccountRow | null): Promise<string | null>;
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
  /** The 403 for an invite with no use limit or no expiry, presented at the remote address. */
  inviteLocalOnly(): Response;
  /** The refusal for an invite that cannot make an account where `req` came in, or null. */
  inviteRefusal(req: Request, inviteHash: string): Promise<Response | null>;
  /** Every password check and new password's hash (./check-password.ts). */
  passwords: PasswordChecks;
  /**
   * The account behind the request's bearer, and the sign-in it names, for the endpoints that act on
   * one's own sign-in. Null when there is none; a Response for an agent's key or a bad token.
   */
  bearerSession(req: Request): Promise<{ account: AccountRow; token: PersonToken } | Response | null>;
  /** Null when the bearer's sign-in was confirmed in the last five minutes, else the 401 that asks for it. */
  recentlyConfirmed(req: Request, account: AccountRow, token: PersonToken): Promise<Response | null>;
  /** A sign-in's answer: the token pair, the device cookie, and `passkey_offer` when it is due. */
  signedIn(done: SignedIn, status?: number): Response;
  /** Wrong-password and failed-passkey counts. */
  limits: SignInLimits;
  /**
   * The throttle for a signed-in person's request that hashes a password, per account: the address
   * bucket alone lets one account spread the priority line's work over many addresses.
   */
  accountThrottled(req: Request, alias: string): Promise<Response | null>;
}

/** What was typed as a username, as the account lookup reads it: a leading @ and case do not matter. */
export function typedUsername(raw: string): string {
  return normalizeUsername(raw).replace(/^@/, "");
}

export interface SignInOptions {
  /** The name the access token carries, when the caller has it at hand. */
  displayName?: string;
  /** An account made by this request, or a sign-in the person just confirmed: its browser is remembered, never reported. */
  quiet?: boolean;
  /** The passkey a sign-in with one used. */
  passkeyId?: string;
  /** Never "Sign in faster next time": the person is where they add passkeys already. */
  noOffer?: boolean;
}

/** How a session begun at the remote address with these leads on to the passkey offer. */
const OFFERED_AFTER: ReadonlySet<SignedInWith> = new Set(["password", "invite", "reset"]);

export function createIdentityRouter(deps: IdentityDeps): IdentityRouter {
  const { auth, db, keys } = deps;
  const signInLimits = deps.signInLimits ?? createSignInLimits();
  const passwords = createPasswordChecks({
    limits: signInLimits,
    queue: deps.hashQueue ?? createHashQueue(),
    network:
      deps.passwordNetwork ??
      createPasswordNetworkCheck({ tls: false, networks: [], remoteOrigin: () => deps.remoteOrigin?.() ?? null }),
    rehash: (alias, oldHash, newHash) => db.rehashLocalPassword(alias, oldHash, newHash),
    nodeName: () => deps.nodeName?.() ?? null,
    onLongPause: (account, req) =>
      void deps.alerts?.signInsPaused({ alias: account.alias, username: account.username, arrival: arrivalOf(req), remoteHost: remoteHost(req) }),
  });
  const limits = { ...REMOTE_SESSION_DEFAULTS, ...definedOnly(auth) };
  /** When each session's token was last recorded as tried at the other address. */
  const wrongAddressNoted = new Map<string, number>();

  /** A session's refresh token presented at the listener that did not issue it: recorded, at most hourly per session. */
  function noteWrongAddress(stale: RefreshSessionRow, presentedAt: CredentialArrival): void {
    const last = wrongAddressNoted.get(stale.session_id);
    if (last !== undefined && Date.now() - last < WRONG_ADDRESS_EVERY_MS) return;
    if (wrongAddressNoted.size >= WRONG_ADDRESS_SESSIONS) wrongAddressNoted.clear();
    wrongAddressNoted.set(stale.session_id, Date.now());
    deps.onIdentityChange?.({
      alias: stale.alias,
      action: "node.session.wrong_address",
      detail: { issued_at: stale.arrival, presented_at: presentedAt },
    });
  }

  /** When a token issued at `arrival` now lapses unused. */
  const idleExpiry = (arrival: CredentialArrival): Date =>
    new Date(Date.now() + (arrival === "remote" ? limits.remoteRefreshTokenTtlSeconds : auth.refreshTokenTtlSeconds) * 1000);

  /** When a session begun now ends however often it renews: only at the remote address. */
  function absoluteExpiry(arrival: CredentialArrival, signedInWith: SignedInWith): Date | null {
    if (arrival === "local") return null;
    const seconds = signedInWith === "provider" ? limits.remoteProviderSessionMaxSeconds : limits.remoteSessionMaxSeconds;
    return new Date(Date.now() + seconds * 1000);
  }

  /** An access token for the session `sid`, good only at the listener `req` came in on. */
  async function accessToken(req: Request, account: Pick<AccountRow, "alias" | "username">, sid: string, displayName?: string): Promise<string> {
    return signAccessToken(keys, {
      alias: account.alias,
      sid,
      username: account.username,
      displayName: displayName ?? (await db.displayNameOf(account.alias)) ?? account.username,
      issuer: auth.issuer,
      audience: audienceFor(auth, tokenArrival(req)),
      ttlSeconds: auth.accessTokenTtlSeconds,
    });
  }

  /** End every session of the account, and close the sockets they opened. */
  async function endSessions(alias: string): Promise<void> {
    await db.revokeRefreshSessions(alias);
    deps.onSessionsEnded?.(alias);
  }

  /** The 401 for a write whose password or sign-in changed while it waited: as if it had been wrong. */
  const sessionEnded = () => fail(401, "invalid_token", "sign in again");

  const tokenPair = (access: string, refresh: string): TokenPair => ({
    access_token: access,
    refresh_token: refresh,
    expires_in: auth.accessTokenTtlSeconds,
    token_type: "Bearer",
  });

  async function issueTokens(
    req: Request,
    account: Pick<AccountRow, "alias" | "username">,
    signedInWith: SignedInWith,
    displayName: string | undefined,
    requires: StillHolds | null,
    passkeyId?: string,
  ): Promise<TokenPair | null> {
    const arrival = arrivalOf(req);
    const refresh = mintRefreshToken();
    const session = await db.createRefreshSession(
      {
      id: randomUUID(),
      sessionId: randomUUID(),
      alias: account.alias,
      tokenHash: refresh.hash,
      expiresAt: idleExpiry(arrival),
      arrival,
        signedInWith,
        passkeyId: passkeyId ?? null,
        absoluteExpiresAt: absoluteExpiry(arrival, signedInWith),
      },
      requires,
    );
    if (!session) return null;
    return tokenPair(await accessToken(req, account, session.session_id, displayName), refresh.token);
  }

  /** The remote address's host when `req` came in there, which an alert names; null on the node's own network. */
  function remoteHost(req: Request): string | null {
    return arrivalOf(req) === "remote" ? new URL(servedOrigin(req)).host : null;
  }

  /** Looked up whether or not the account exists, so the time it takes says nothing about the name typed. */
  async function knownDevice(req: Request, account: AccountRow | null): Promise<string | null> {
    const arrival = arrivalOf(req);
    const value = readDeviceCookie(req, arrival);
    if (!value) return null;
    const hash = deviceHash(value);
    const known = await db.isKnownDevice({ alias: account?.alias ?? "", arrival, tokenHash: hash });
    return known && account ? hash : null;
  }

  /**
   * Remember the browser `req` came from for `account` at its listener, and report it when it is new
   * there at the remote address. Its cookie, set again so it lasts another 400 days; a browser with
   * none gets one. One cookie per browser, whichever accounts sign in from it.
   */
  async function rememberBrowser(req: Request, account: Pick<AccountRow, "alias" | "username">, opts: SignInOptions): Promise<string> {
    const arrival = arrivalOf(req);
    const value = readDeviceCookie(req, arrival) ?? newDeviceValue();
    const hash = deviceHash(value);
    const label = deviceLabel(req.headers.get("user-agent"));
    const from = clientAddress(req, deps.trustProxyHeaders ?? false);
    const firstFrom = from === "unknown" ? null : from;
    const host = remoteHost(req);
    // The session is issued already: a device that cannot be written is logged, never a failed sign-in.
    const isNew = await db.rememberDevice({ alias: account.alias, arrival, tokenHash: hash, label, firstFrom }).catch((err: unknown) => {
      console.warn("[auth] could not remember a browser", err);
      return false;
    });
    if (isNew && host && !opts.quiet) {
      deps.onIdentityChange?.({ alias: account.alias, action: "node.sign_in.new_device", detail: { device: label, from: firstFrom } });
      const name = opts.displayName ?? (await db.displayNameOf(account.alias)) ?? account.username;
      await deps.alerts?.newDevice({
        alias: account.alias,
        username: account.username,
        name,
        device: label,
        at: new Date(),
        remoteHost: host,
        from: firstFrom ?? "an unknown address",
        deviceHash: hash,
      });
    }
    return deviceCookie(arrival, value);
  }

  async function signInIf(
    req: Request,
    account: Pick<AccountRow, "alias" | "username">,
    signedInWith: SignedInWith,
    requires: StillHolds | null,
    opts: SignInOptions = {},
  ): Promise<SignedIn | null> {
    const tokens = await issueTokens(req, account, signedInWith, opts.displayName, requires, opts.passkeyId);
    if (!tokens) return null;
    const asked = parseAcceptLanguage(req.headers.get("accept-language"));
    // Only a hint for what the node sends outside the app; a sign-in never waits on or fails over it.
    if (asked.length > 0) void db.noteDetectedUiLanguage(account.alias, negotiateUiLanguage(asked)).catch(() => {});
    const cookie = await rememberBrowser(req, account, opts);
    // Asked of a person who signed in with a password at the remote address, never after the provider.
    const offerable = arrivalOf(req) === "remote" && OFFERED_AFTER.has(signedInWith) && !opts.noOffer;
    const passkeyOffer = offerable && (await db.passkeyOfferDue(account.alias, passkeySite(req, null).rpId).catch(() => false));
    return { tokens, cookie, passkeyOffer };
  }

  async function signIn(
    req: Request,
    account: Pick<AccountRow, "alias" | "username">,
    signedInWith: SignedInWith,
    opts: SignInOptions = {},
  ): Promise<SignedIn> {
    return (await signInIf(req, account, signedInWith, null, opts))!;
  }

  async function accountThrottled(req: Request, alias: string): Promise<Response | null> {
    if (!deps.limiter) return null;
    const { success } = await deps.limiter.limit({ key: `auth:account:${arrivalOf(req)}:${alias}` });
    return success ? null : tooMany();
  }

  /** A sign-in's answer: the token pair, and the device cookie. Only a remote one may carry `passkey_offer`. */
  function signedIn(done: SignedIn, status = 200): Response {
    return withCookies(json(done.passkeyOffer ? { ...done.tokens, passkey_offer: true } : done.tokens, status), [done.cookie]);
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
  const inviteLocalOnly = () =>
    fail(403, "invite_local_only", "This invite link works only on this node's network.");
  async function inviteRefusal(req: Request, inviteHash: string): Promise<Response | null> {
    const status = await db.inviteStatus(inviteHash, arrivalOf(req));
    return status === "ok" ? null : status === "local_only" ? inviteLocalOnly() : inviteInvalid();
  }
  const setupCodeRequired = () =>
    fail(403, "setup_code_required", "setting up this node needs its setup code, which the node prints in its log");

  /** The signed-in person behind the request's bearer, and the sign-in it names. */
  async function bearerSession(req: Request): Promise<{ account: AccountRow; token: PersonToken } | Response | null> {
    const presented = extractToken(req);
    if (!presented) return null;
    // How a person signs in is theirs to change; a key acting for them never may.
    if (looksLikeApiKey(presented)) return fail(403, "agent_forbidden", "agents cannot change how a person signs in");
    try {
      const token = await verifyPersonToken({ verifier: deps.verifier, sessionIsLive: db.sessionIsLive }, req, presented);
      const account = await db.findAccountByAlias(token.alias);
      return account ? { account, token } : fail(401, "invalid_token", "sign in again");
    } catch (err) {
      if (err instanceof AuthError) return fail(401, "invalid_token", "sign in again");
      throw err;
    }
  }

  async function recentlyConfirmed(req: Request, account: AccountRow, token: PersonToken): Promise<Response | null> {
    if (await confirmedRecently(db, token)) return null;
    const passkey = arrivalOf(req) === "remote" && (await db.passkeyDescriptors(account.alias, passkeySite(req, null).rpId)).length > 0;
    return reauthRequired(confirmationMethods(account, (deps.identityProvider?.() ?? null) !== null, passkey));
  }

  const core: IdentityCore = {
    deps,
    signIn,
    signInIf,
    accountThrottled,
    knownDevice,
    suggestUsername,
    usernameRefusal,
    usernameTaken,
    reportJoin,
    inviteRequired,
    inviteInvalid,
    inviteLocalOnly,
    inviteRefusal,
    passwords,
    bearerSession,
    recentlyConfirmed,
    signedIn,
    limits: signInLimits,
  };
  const provider = createProviderRoutes(core);
  const passkeys = createPasskeyRoutes(core, deps.passkeyChallenges ?? createPasskeyChallenges());

  async function config(req: Request): Promise<Response> {
    // No account yet: the SPA opens on first-run setup, whose account administers the node.
    // Once claimed, an account is created only with an invite link.
    const unclaimed = (await db.countAccounts()) === 0;
    const idp = deps.identityProvider?.() ?? null;
    const b = deps.branding?.() ?? { accentColor: null };
    const nodeName = deps.nodeName?.() ?? null;
    // At the remote address, nothing that names the LAN: an unnamed node goes by its remote id, not its host.
    const remote = arrivalOf(req) === "remote";
    const origin = remote ? servedOrigin(req) : deps.publicOrigin;
    const nodeLabel = remote
      ? (nodeName ?? deps.remoteId?.() ?? hostLabel(origin))
      : (deps.nodeLabel?.() ?? hostLabel(deps.publicOrigin));
    // While the remote address is on: where a password of 15 characters or more also signs in, which
    // the forms that set one say. Absent otherwise, so the answer is what it always was.
    const remoteOrigin = deps.remoteOrigin?.() ?? null;
    return json({
      provider: idp ? { label: idp.label } : null,
      unclaimed,
      // The name an administrator gave the node, shown in place of the product's; null until there is one.
      node_name: nodeName,
      // Which node this is, as /mcp names it: the stdio server reads it and the origin, whatever address it reached the node at.
      node_label: nodeLabel,
      origin,
      branding: { accent_color: b.accentColor },
      ...(remoteOrigin ? { remote_origin: remoteOrigin } : {}),
      // Passkeys are made and used only at the remote address; the node's own network never sees this.
      ...(remote ? { passkey: true } : {}),
    });
  }

  async function register(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const username = normalizeUsername(field(body, "username"));
    const password = field(body, "password");
    const name = field(body, "name").trim().slice(0, MAX_NAME);
    const invite = field(body, "invite").trim();
    // Setup gives the node the time zone its schedule runs in, which is the browser's: an unknown name is dropped, not refused.
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
      const refusedInvite = await inviteRefusal(req, inviteHash);
      if (refusedInvite) return refusedInvite;
    } else {
      // The setup code is printed on the node's own machine; its remote address never takes one.
      if (arrivalOf(req) === "remote") {
        return fail(403, "setup_not_remote", "set up this node from its own network, not its remote address");
      }
      const code = field(body, "setup_code");
      if (!code.trim()) return setupCodeRequired();
      if (!setupCodeMatches(deps.setupCode?.() ?? null, code)) {
        return fail(403, "setup_code_invalid", "that is not this node's setup code");
      }
      mayClaim = true;
    }

    const passwordHash = await passwords.hash(req, password, false);
    if (passwordHash instanceof Response) return passwordHash;
    const alias = newAlias();
    const displayName = name || username;
    const made = await db.createLocalAccount({
      alias,
      username,
      passwordHash,
      displayName,
      inviteHash,
      mayClaim,
      arrival: arrivalOf(req),
      ...(timeZone ? { timeZone } : {}),
      ...(searchLanguages ? { searchLanguages } : {}),
    });
    if (!made.ok) {
      if (made.reason === "username_taken") return usernameTaken(username);
      if (made.reason === "setup_code_required") return setupCodeRequired();
      if (made.reason === "invite_local_only") return inviteLocalOnly();
      return made.reason === "invite_required" ? inviteRequired() : inviteInvalid();
    }
    if (made.admin) deps.onFirstAccount?.(alias);
    reportJoin(alias, inviteHash, made.joined);

    return signedIn(await signIn(req, made.account, made.admin ? "setup" : "invite", { displayName, quiet: true }), 201);
  }

  /**
   * `/auth/password` does two things on the node's own network. Changing a password is authenticated
   * by the current one rather than a session, so a stolen session cannot lock the owner out, and
   * revokes every other session. Setting a first password, for an account made through the identity
   * provider, has no current one to present, so it takes the session instead. At the remote address
   * it always takes the session (remotePassword).
   */
  async function password(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    if (arrivalOf(req) === "remote") return remotePassword(req, body);
    if (!field(body, "current_password") && extractToken(req)) return setPassword(req, body);
    return changePassword(req, body);
  }

  async function changePassword(req: Request, body: Record<string, unknown>): Promise<Response> {
    const username = typedUsername(field(body, "username"));
    const current = field(body, "current_password");
    const next = field(body, "new_password");
    if (!username || !current) return fail(400, "bad_request", "username and current_password are required");
    const weak = passwordPolicy(next);
    if (weak) return weak;

    // An account with no password answers exactly as a wrong one does.
    const account = await db.findAccountByUsername(username);
    const checked = await passwords.check(req, {
      username: account?.username ?? username,
      account,
      password: current,
      signedIn: false,
      device: await knownDevice(req, account),
    });
    if (!checked.ok) return checked.response;
    return replacePassword(req, checked.account, next, false, { password: checked.hash });
  }

  /**
   * A new password for `account`: every session ends, this browser gets a new one, and the person is
   * told. Only while `requires` still holds once the new one is hashed: the current password that was
   * checked is still the account's, or the confirmed sign-in that asked is still on.
   */
  async function replacePassword(req: Request, account: AccountRow, next: string, inSession: boolean, requires: StillHolds): Promise<Response> {
    const hash = await passwords.hash(req, next, inSession);
    if (hash instanceof Response) return hash;
    const replaced = await db.replaceLocalPassword({ alias: account.alias, passwordHash: hash, requires });
    if (!replaced) return "password" in requires ? wrongPassword() : sessionEnded();
    deps.onSessionsEnded?.(account.alias);
    // Changed from Profile, where passkeys are added: no offer here.
    const done = await signInIf(req, account, "password", { password: hash }, { noOffer: true });
    if (!done) return wrongPassword();
    await passwordAlert(req, account, "changed");
    return signedIn(done);
  }

  async function passwordAlert(req: Request, account: Pick<AccountRow, "alias" | "username">, how: "changed" | "reset"): Promise<void> {
    await deps.alerts?.passwordChanged({
      alias: account.alias,
      username: account.username,
      name: (await db.displayNameOf(account.alias)) ?? account.username,
      device: deviceLabel(req.headers.get("user-agent")),
      at: new Date(),
      how,
      remoteHost: remoteHost(req),
    });
  }

  /** A first password is a lasting way in: only from a sign-in confirmed in the last five minutes. */
  async function setPassword(req: Request, body: Record<string, unknown>): Promise<Response> {
    const found = await bearerSession(req);
    if (found instanceof Response) return found;
    if (!found) return fail(401, "invalid_token", "sign in again");
    const { account, token } = found;
    const next = field(body, "new_password");
    const weak = passwordPolicy(next);
    if (weak) return weak;
    if (account.password_hash) return addFirstPassword(req, account, token, next);
    const stale = await recentlyConfirmed(req, account, token);
    if (stale) return stale;
    const limited = await accountThrottled(req, account.alias);
    if (limited) return limited;
    return addFirstPassword(req, account, token, next);
  }

  async function addFirstPassword(req: Request, account: AccountRow, token: PersonToken, next: string): Promise<Response> {
    const setAlready = () => fail(409, "password_set", "this account already has a password; change it with the current one");
    if (account.password_hash) return setAlready();
    const hash = await passwords.hash(req, next, true);
    if (hash instanceof Response) return hash;
    if (!(await db.addLocalPassword(account.alias, hash, { session: presentedSession(token) }))) {
      // Ended while the password was hashed, or given one meanwhile.
      return (await db.sessionIsLive(presentedSession(token))) ? setAlready() : sessionEnded();
    }
    return new Response(null, { status: 204 });
  }

  /**
   * At the remote address a password is changed only from a session there, for its own account
   * (`wrong_account` otherwise): with the current password, which then must meet the remote rule
   * like any sign-in there; or, without it, from a sign-in confirmed in the last five minutes, which
   * is how someone whose password is too short for this address replaces it. An account with no
   * password sets its first one the same way.
   */
  async function remotePassword(req: Request, body: Record<string, unknown>): Promise<Response> {
    const found = await bearerSession(req);
    if (found instanceof Response) return found;
    if (!found) return fail(401, "invalid_token", "sign in again");
    const { account, token } = found;
    const typed = field(body, "username");
    if (typed && typedUsername(typed) !== account.username) {
      return fail(403, "wrong_account", "that is not the account signed in here");
    }
    const next = field(body, "new_password");
    const weak = passwordPolicy(next);
    if (weak) return weak;
    const limited = await accountThrottled(req, account.alias);
    if (limited) return limited;

    const current = field(body, "current_password");
    if (current) {
      const checked = await passwords.check(req, {
        username: account.username,
        account,
        password: current,
        signedIn: true,
        device: await knownDevice(req, account),
      });
      if (!checked.ok) return checked.response;
      return replacePassword(req, checked.account, next, true, { password: checked.hash });
    }
    const stale = await recentlyConfirmed(req, account, token);
    if (stale) return stale;
    if (!account.password_hash) return addFirstPassword(req, account, token, next);
    return replacePassword(req, account, next, true, { session: presentedSession(token) });
  }

  /**
   * Whose account a reset link is for, so its page can say so before a password is chosen. The
   * token is the credential: its holder may know the account it opens, and a dead one says nothing.
   */
  async function resetPreview(req: Request): Promise<Response> {
    const body = await readJson(req);
    const token = body ? field(body, "token").trim() : "";
    if (!token) return fail(400, "bad_request", "token is required");
    const alias = await db.passwordResetAlias(sha256Hex(token));
    const account = alias ? await db.findAccountByAlias(alias) : null;
    if (!account) return fail(403, "reset_invalid", "this reset link is invalid, expired, or already used");
    return json({ username: account.username, display_name: (await db.displayNameOf(account.alias)) || null });
  }

  /**
   * What an invite link admits to, for the page it opens: the workspace, the role and who made it,
   * or that it can no longer be used. Its holder may know this; anyone else would need the token.
   */
  async function invitePreview(req: Request): Promise<Response> {
    const body = await readJson(req);
    const token = body ? field(body, "token").trim() : "";
    if (!token) return fail(400, "bad_request", "token is required");
    return json(await db.invitePreview(sha256Hex(token), arrivalOf(req)));
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
    const resetInvalid = () => fail(403, "reset_invalid", "this reset link is invalid, expired, or already used");
    const refused = passwords.admits(req, false);
    if (refused) return refused;
    // Looked up before the hash, so a made-up token costs no scrypt; the redemption decides.
    const tokenHash = sha256Hex(token);
    if (!(await db.passwordResetIsLive(tokenHash))) return resetInvalid();

    // Also how an account made through the identity provider gets its first password once the provider is gone.
    const hash = await passwords.hash(req, next, false);
    if (hash instanceof Response) return hash;
    const alias = await db.redeemPasswordReset(tokenHash, hash);
    if (!alias) return resetInvalid();

    // Every session ends, and with it every access token it issued: each request looks its session up.
    await endSessions(alias);
    const account = await db.findAccountByAlias(alias);
    if (!account) return resetInvalid();
    const done = await signInIf(req, account, "reset", { password: hash });
    if (!done) return resetInvalid();
    await passwordAlert(req, account, "reset");
    return signedIn(done);
  }

  /**
   * Confirm who you are again with your password (`{ password }` and a session): the session's
   * `confirmed_at` moves, so a change that asks for a recent confirmation can go ahead. Checked like
   * any password, its limits and the remote rule included.
   */
  async function confirm(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const found = await bearerSession(req);
    if (found instanceof Response) return found;
    if (!found) return fail(401, "invalid_token", "sign in again");
    const { account, token } = found;
    const password = field(body, "password");
    if (!password) return fail(400, "bad_request", "password is required");
    const limited = await accountThrottled(req, account.alias);
    if (limited) return limited;
    const checked = await passwords.check(req, {
      username: account.username,
      account,
      password,
      signedIn: true,
      device: await knownDevice(req, account),
    });
    if (!checked.ok) return checked.response;
    if (!(await db.confirmSession(presentedSession(token)))) return sessionEnded();
    return new Response(null, { status: 204 });
  }

  /**
   * Revoke everything (docs/api.md): from a sign-in confirmed in the last five minutes, with the new
   * password the account keeps. Every sign-in at both addresses ends and every other way in goes
   * (packages/db account-security.ts); this browser gets a new session, the only one. Only while the
   * sign-in that asked is still on once the password is hashed: an administrator's Revoke everything
   * that lands meanwhile is never undone by it.
   */
  async function revokeEverything(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const found = await bearerSession(req);
    if (found instanceof Response) return found;
    if (!found) return fail(401, "invalid_token", "sign in again");
    const { account, token } = found;
    const next = field(body, "new_password");
    const weak = passwordPolicy(next);
    if (weak) return weak;
    const stale = await recentlyConfirmed(req, account, token);
    if (stale) return stale;
    const limited = await accountThrottled(req, account.alias);
    if (limited) return limited;

    // Hashed first, in the priority line, so the transaction holds no lock while it waits.
    const hash = await passwords.hash(req, next, true);
    if (hash instanceof Response) return hash;
    const revoked = await db.revokeEverything({
      alias: account.alias,
      by: account.alias,
      passwordHash: hash,
      requires: { session: presentedSession(token) },
    });
    if (!revoked) return sessionEnded();
    deps.onSessionsEnded?.(account.alias);
    const { sessionIds: _ended, ...counts } = revoked;
    deps.onIdentityChange?.({ alias: account.alias, action: "node.account.revoke_everything", detail: { ...counts, by_admin: false } });
    const name = (await db.displayNameOf(account.alias)) ?? account.username;
    await deps.alerts?.revokedEverything({
      alias: account.alias,
      username: account.username,
      name,
      device: deviceLabel(req.headers.get("user-agent")),
      at: new Date(),
    });
    // The person just confirmed it is them: this browser is remembered again, and not reported.
    const done = await signInIf(req, account, "password", { password: hash }, { displayName: name, quiet: true, noOffer: true });
    return done ? signedIn(done) : sessionEnded();
  }

  async function login(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const username = typedUsername(field(body, "username"));
    const password = field(body, "password");
    if (!username || !password) return fail(400, "bad_request", "username and password are required");

    const account = await db.findAccountByUsername(username);
    const checked = await passwords.check(req, {
      // The account's own name when there is one, so every way of typing it counts as one.
      username: account?.username ?? username,
      account,
      password,
      signedIn: false,
      device: await knownDevice(req, account),
    });
    if (!checked.ok) return checked.response;
    // Only while the password checked is still the account's: a recovery that lands meanwhile wins.
    const done = await signInIf(req, checked.account, "password", { password: checked.hash });
    return done ? signedIn(done) : wrongPassword();
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

  /**
   * Renewal never asks the identity provider anything: a session outlives the provider being down or removed.
   * It continues the same sign-in at the same listener, and never past the end that sign-in was given.
   */
  async function refresh(req: Request): Promise<Response> {
    const body = await readJson(req);
    const presented = body ? field(body, "refresh_token").trim() : "";
    if (!presented) return fail(400, "bad_request", "refresh_token is required");

    const arrival = arrivalOf(req);
    const unknown = () => fail(401, "invalid_refresh_token", "refresh token is unknown, expired or revoked");
    const tokenHash = hashRefreshToken(presented);
    const next = mintRefreshToken();
    const rotated = await db.rotateRefreshSession({
      tokenHash,
      id: randomUUID(),
      nextTokenHash: next.hash,
      expiresAt: idleExpiry(arrival),
      arrival,
    });
    if (!rotated) {
      const stale = await db.findRefreshSession(tokenHash);
      // Issued at the other listener: unknown here. Someone tried it where it does not belong, which says
      // nothing about whether the session itself leaked, so nobody is signed out.
      if (stale && stale.arrival !== arrival) {
        noteWrongAddress(stale, arrival);
        return unknown();
      }
      // A duplicate renewal (two tabs, or a lost response): a sibling of the successor, the same sign-in, ending when it does.
      if (stale?.replaced_by && (await rotatedRecently(stale))) {
        const account = await db.findAccountByAlias(stale.alias);
        const sibling = account ? await db.siblingRefreshSession({ of: stale.replaced_by, id: randomUUID(), tokenHash: next.hash }) : null;
        if (account && sibling) return json(tokenPair(await accessToken(req, account, sibling.session_id), next.token));
      }
      // A rotated token presented again after its grace: a replay. Whoever holds that sign-in's live
      // successor loses it too; the account's other sign-ins stay. A token ended some other way (sign-out,
      // a password change, a reset, Revoke everything, an upgrade) is only refused: ending more would sign
      // the person out of the browser where they just signed in again.
      if (stale?.replaced_by) {
        const ended = await db.endSession(tokenHash, arrival);
        if (ended) deps.onSessionsEnded?.(ended.alias, [ended.sessionId]);
      }
      return unknown();
    }

    const account = await db.findAccountByAlias(rotated.alias);
    if (!account) {
      await db.revokeRefreshSession(next.hash);
      return fail(401, "invalid_refresh_token", "account no longer exists");
    }
    return json(tokenPair(await accessToken(req, account, rotated.session_id), next.token));
  }

  /**
   * Also drops any link to the identity provider the account started here and never finished, and
   * closes the sockets the sign-in opened. A token issued at the other listener signs nothing out.
   */
  async function logout(req: Request): Promise<Response> {
    const body = await readJson(req);
    const presented = body ? field(body, "refresh_token").trim() : "";
    if (presented) {
      const ended = await db.endSession(hashRefreshToken(presented), arrivalOf(req));
      if (ended) deps.onSessionsEnded?.(ended.alias, [ended.sessionId]);
    }
    return new Response(null, { status: 204 });
  }

  /** Not at the remote address, where no issuer document is served. */
  function jwks(req: Request): Response {
    if (arrivalOf(req) === "remote") return json({ error: "not_found" }, 404);
    return new Response(JSON.stringify(publicJwks(keys)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }

  /** Not at the remote address: the issuer is PUBLIC_ORIGIN, which that address never names. */
  function discovery(req: Request): Response {
    if (arrivalOf(req) === "remote") return json({ error: "not_found" }, 404);
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
    "/auth/confirm",
    "/auth/revoke-everything",
    "/auth/passkey/options",
    "/auth/passkey/sign-in",
    "/auth/passkey/add",
  ]);

  /**
   * Two buckets per attempt, both of which must have budget: the source address and the targeted
   * identifier. Each per listener, so a stranger guessing at the remote address cannot lock the
   * LAN out of an account.
   */
  async function throttled(req: Request, path: string): Promise<Response | null> {
    if (!deps.limiter || !THROTTLED.has(path)) return null;
    const keys = [`auth:ip:${clientBucket(req, deps.trustProxyHeaders ?? false)}`];
    const target = await req
      .clone()
      .json()
      .then((b: unknown) => {
        const o = (b ?? {}) as Record<string, unknown>;
        const username = typeof o.username === "string" ? typedUsername(o.username) : "";
        const token = typeof o.token === "string" ? o.token : "";
        const credential = (o.credential ?? null) as { id?: unknown } | null;
        const passkey = typeof credential?.id === "string" ? credential.id.slice(0, 1400) : "";
        return username || (token ? `token:${sha256Hex(token)}` : passkey ? `passkey:${sha256Hex(passkey)}` : "");
      })
      .catch(() => "");
    if (target) keys.push(`auth:id:${arrivalOf(req)}:${target}`);
    for (const key of keys) {
      const { success } = await deps.limiter.limit({ key });
      if (!success) return tooMany();
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
    ...post("/auth/reset/preview", resetPreview),
    ...post("/auth/invite/preview", invitePreview),
    ...post("/auth/confirm", confirm),
    ...post("/auth/revoke-everything", revokeEverything),
    ...post("/auth/refresh", refresh),
    ...post("/auth/logout", logout),
    ...post("/auth/oidc/start", provider.start),
    ...get("/auth/oidc/callback", provider.callback),
    ...post("/auth/oidc/handoff", provider.handoff),
    ...post("/auth/oidc/ticket", provider.ticket),
    ...post("/auth/oidc/complete", provider.complete),
    ...post("/auth/oidc/link", provider.link),
    ...post("/auth/oidc/unlink", provider.unlink),
    ...post("/auth/passkey/options", passkeys.options),
    ...post("/auth/passkey/sign-in", passkeys.signIn),
    ...post("/auth/passkey/add", passkeys.add),
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

/** The throttle's 429. */
function tooMany(): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message: "too many attempts; try again shortly" }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
  });
}

/** The sign-in an access token names, as the database's guards take it. */
function presentedSession(token: PersonToken): { sessionId: string; alias: string; arrival: CredentialArrival } {
  return { sessionId: token.sid, alias: token.alias, arrival: token.arrival };
}

const wrongPassword = (): Response => fail(401, "invalid_credentials", "username or password is incorrect");

interface IdentityRoute extends Route {
  handler: (req: Request) => Promise<Response>;
}

/** The fields of `auth` that are set: an absent limit takes its default. */
function definedOnly(auth: AuthConfig): Partial<typeof REMOTE_SESSION_DEFAULTS> {
  const out: Partial<Record<keyof typeof REMOTE_SESSION_DEFAULTS, number>> = {};
  for (const key of Object.keys(REMOTE_SESSION_DEFAULTS) as (keyof typeof REMOTE_SESSION_DEFAULTS)[]) {
    const value = auth[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
