/**
 * Signing in through the identity provider, `/auth/oidc/*`. The node runs the
 * authorization-code flow itself and verifies the provider's id_token once;
 * what the person gets is the node's own session, from the same issueTokens as
 * a password sign-in, so nothing after the callback depends on the provider.
 *
 * The browser that starts a sign-in holds a cookie whose hash is stored with
 * the flow and copied onto whatever the callback hands out, and the callback
 * renews the cookie for as long as that lasts; every later step checks it, so
 * a code or ticket carried to another browser is worthless.
 *
 * A subject no account is linked to becomes a first-visit ticket: the person
 * either makes a new account, which needs an invite like registration does, or
 * proves an existing one with its password. Nothing is ever linked by username
 * or email. Every endpoint refuses an agent's key.
 */
import { ProviderError, createRelyingParty, newAlias, randomBase64url, sha256Hex, verifyPassword } from "@stuga/auth";
import type { OidcTicketRow } from "@stuga/db";
import { normalizeUsername, usernameSource } from "@stuga/protocol/domain/username";
import { MAX_NAME, MAX_PASSWORD, decoy } from "./passwords.js";
import type { IdentityCore } from "./routes.js";
import {
  bindingCookie,
  bindingHash,
  boundToBrowser,
  fail,
  field,
  json,
  readBinding,
  readJson,
  redirect,
  safeReturnTo,
  withQuery,
} from "./http.js";

export const CALLBACK_PATH = "/auth/oidc/callback";

/** How long a browser has between start and callback. */
const FLOW_TTL_S = 10 * 60;
/** How long the app has to redeem a session handoff after the callback. */
const HANDOFF_TTL_S = 60;
/** How long a first visit may take to choose between a new account and an existing one. */
const FIRST_VISIT_TTL_S = 10 * 60;

const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

/** A log-safe rendering of something the provider or the browser sent. */
const tag = (s: string) => s.replace(/[^\w.-]/g, "").slice(0, 64);

type Handler = (req: Request) => Promise<Response>;

export function createProviderRoutes(core: IdentityCore): Record<"start" | "callback" | "handoff" | "ticket" | "complete" | "link" | "unlink", Handler> {
  const { deps } = core;
  const { db } = deps;
  const rp = deps.relyingParty ?? createRelyingParty();
  const provider = () => deps.identityProvider?.() ?? null;

  /** The origin the sign-in runs on: the caller's, when the node serves the app there, else the public one. */
  function signInOrigin(req: Request): string {
    const origin = req.headers.get("origin");
    if (origin && (origin === deps.publicOrigin || deps.extraOrigins?.includes(origin))) return origin;
    return deps.publicOrigin;
  }

  /**
   * Whether the page calling in runs on https, which decides the binding
   * cookie's name. Not for the callback: a top-level navigation sends no
   * Origin, so it takes the scheme from the redirect URI the flow stored.
   */
  function secureCaller(req: Request): boolean {
    return signInOrigin(req).startsWith("https:");
  }

  /** Clear the binding cookie once the sign-in it guarded is finished. */
  function cleared(req: Request): Record<string, string> {
    return { "set-cookie": bindingCookie("", 0, secureCaller(req)) };
  }

  function linked(alias: string, via: "profile" | "first_visit"): void {
    deps.onIdentityChange?.({ alias, action: "node.identity.link", detail: { via } });
  }

  const ticketInvalid = () => fail(403, "ticket_invalid", "this sign-in has expired; start again");

  /** The first-visit ticket a request names, when this browser holds its cookie. */
  async function firstVisit(req: Request, body: Record<string, unknown>): Promise<{ hash: string; row: OidcTicketRow } | Response> {
    const ticket = field(body, "ticket").trim();
    const hash = ticket ? sha256Hex(ticket) : "";
    const row = hash ? await db.peekOidcTicket(hash, "first_visit") : null;
    if (!row || !boundToBrowser(req, row.binding_hash, secureCaller(req))) return ticketInvalid();
    return { hash, row };
  }

  /** A first visit whose provider was changed or removed since: the subject means nothing now, so the ticket goes. */
  async function providerChanged(hash: string): Promise<Response> {
    await db.takeOidcTicket(hash, "first_visit");
    return ticketInvalid();
  }

  async function start(req: Request): Promise<Response> {
    const idp = provider();
    if (!idp) return fail(404, "no_provider", "no identity provider is set up on this node");
    const body = (await readJson(req)) ?? {};
    // "none": a silent attempt, which a provider without a session refuses. "select_account": ask which
    // account, so a person who signed out does not land straight back in the one they left.
    const prompt = body.prompt;
    if (prompt !== undefined && prompt !== "none" && prompt !== "select_account") {
      return fail(400, "bad_request", 'prompt can only be "none" or "select_account"');
    }

    // A signed-in person starting here links the provider to their own account.
    const account = await core.bearerAccount(req);
    if (account instanceof Response) return account;
    if (account && prompt === "none") return fail(400, "bad_request", "linking cannot be silent");
    if (account?.oidc_sub) return fail(409, "already_linked", "this account is already linked to the identity provider");

    const origin = signInOrigin(req);
    const redirectUri = `${origin}${CALLBACK_PATH}`;
    let request;
    try {
      request = await rp.start(idp, { redirectUri, ...(prompt ? { prompt } : {}) });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      console.warn("[auth] identity provider unreachable", { reason: err.reason });
      return fail(502, "provider_unreachable", "the identity provider could not be reached; try again shortly");
    }

    const secure = origin.startsWith("https:");
    const binding = randomBase64url(32);
    await db.createOidcFlow({
      state: request.state,
      bindingHash: bindingHash(binding, secure),
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      redirectUri,
      prompt: prompt ?? null,
      linkAlias: account?.alias ?? null,
      returnTo: safeReturnTo(body.return_to),
      expiresAt: inSeconds(FLOW_TTL_S),
    });
    return json({ url: request.url }, 200, { "set-cookie": bindingCookie(binding, FLOW_TTL_S, secure) });
  }

  /** Where the provider sends the browser back. Always a redirect: a person is looking at it. */
  async function callback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") ?? "";
    // Spent here whatever happens next: a state is good for one callback.
    const flow = state ? await db.takeOidcFlow(state) : null;
    const failed = (reason: string): Response => {
      console.warn("[auth] identity provider sign-in failed", { reason });
      return redirect(flow?.link_alias ? withQuery(flow.return_to, "provider=failed") : "/login?provider=failed");
    };
    if (!flow) return failed("unknown_or_expired_state");
    const secure = flow.redirect_uri.startsWith("https:");
    const binding = readBinding(req, secure);
    if (!binding || !boundToBrowser(req, flow.binding_hash, secure)) return failed("browser_binding");
    // The cookie again, to last as long as what the browser is handed next: the flow's may run out first.
    const keep = (seconds: number) => ({ "set-cookie": bindingCookie(binding, seconds, secure) });
    const idpError = url.searchParams.get("error");
    if (idpError) return failed(`provider_${tag(idpError)}`);
    const code = url.searchParams.get("code");
    if (!code) return failed("no_code");
    const idp = provider();
    if (!idp) return failed("no_provider");

    let identity;
    try {
      identity = await rp.finish(idp, { code, redirectUri: flow.redirect_uri, codeVerifier: flow.code_verifier, nonce: flow.nonce });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return failed(err.reason);
    }

    // Everything below links the subject only while the issuer that just vouched for it is still the node's.
    if (flow.link_alias) {
      const outcome = await db.linkIdentity(flow.link_alias, identity.sub, idp.issuer);
      if (outcome === "linked") linked(flow.link_alias, "profile");
      if (outcome === "linked" || outcome === "already_linked") return redirect(withQuery(flow.return_to, "provider=linked"));
      if (outcome === "taken") return redirect(withQuery(flow.return_to, "provider=taken"));
      return failed(`link_${outcome}`);
    }

    const known = await db.findAccountBySub(identity.sub);
    if (known) {
      const handoff = randomBase64url(32);
      await db.createOidcTicket({
        ticketHash: sha256Hex(handoff),
        kind: "session",
        bindingHash: flow.binding_hash,
        alias: known.alias,
        returnTo: flow.return_to,
        expiresAt: inSeconds(HANDOFF_TTL_S),
      });
      // In the fragment, which no server and no Referer ever sees.
      return redirect(`/auth/complete#code=${handoff}`, keep(HANDOFF_TTL_S));
    }
    const ticket = randomBase64url(32);
    await db.createOidcTicket({
      ticketHash: sha256Hex(ticket),
      kind: "first_visit",
      bindingHash: flow.binding_hash,
      sub: identity.sub,
      issuer: idp.issuer,
      preferredUsername: identity.preferredUsername,
      name: identity.name,
      email: identity.email,
      returnTo: flow.return_to,
      expiresAt: inSeconds(FIRST_VISIT_TTL_S),
    });
    return redirect(`/auth/first-visit#ticket=${ticket}`, keep(FIRST_VISIT_TTL_S));
  }

  /** Trade the callback's one-time code for the session it stands for. */
  async function handoff(req: Request): Promise<Response> {
    const body = await readJson(req);
    const code = body ? field(body, "code").trim() : "";
    const invalid = () => fail(403, "handoff_invalid", "this sign-in has expired or was already used; start again");
    if (!code) return invalid();
    const hash = sha256Hex(code);
    const row = await db.peekOidcTicket(hash, "session");
    // Checked before it is spent, so a code carried to another browser cannot burn the real one.
    if (!row?.alias || !boundToBrowser(req, row.binding_hash, secureCaller(req))) return invalid();
    if (!(await db.takeOidcTicket(hash, "session"))) return invalid();
    const account = await db.findAccountByAlias(row.alias);
    if (!account) return invalid();
    return json({ ...(await core.issueTokens(account)), return_to: row.return_to }, 200, cleared(req));
  }

  /** What a first visit's page shows: who the provider said this is, and a username to offer. Leaves the ticket in place. */
  async function ticket(req: Request): Promise<Response> {
    const found = await firstVisit(req, (await readJson(req)) ?? {});
    if (found instanceof Response) return found;
    const { row } = found;
    const source = usernameSource({ preferredUsername: row.preferred_username, email: row.email, name: row.name });
    return json({
      label: provider()?.label ?? null,
      preferred_username: row.preferred_username,
      name: row.name,
      email: row.email,
      suggestion: await core.suggestUsername(source),
      return_to: row.return_to,
    });
  }

  /** A new account for a subject seen for the first time. Needs an invite, exactly as registration does. */
  async function complete(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const found = await firstVisit(req, body);
    if (found instanceof Response) return found;
    const { hash, row } = found;

    // The owner always sets a node up with a password, so it never depends on the provider.
    // Refused early here; the account's own transaction decides, under the lock every account is made under.
    const setupRequired = () => fail(403, "setup_required", "this node is not set up yet; its owner creates the first account");
    if ((await db.countAccounts()) === 0) return setupRequired();
    const username = normalizeUsername(field(body, "username"));
    const refused = await core.usernameRefusal(username);
    if (refused) return refused;
    const invite = field(body, "invite").trim();
    if (!invite) return core.inviteRequired();
    const inviteHash = sha256Hex(invite);
    if (!(await db.inviteIsRedeemable(inviteHash))) return core.inviteInvalid();

    const displayName = field(body, "name").trim().slice(0, MAX_NAME) || row.name?.slice(0, MAX_NAME) || username;
    const made = await db.createProviderAccount({
      alias: newAlias(),
      username,
      displayName,
      email: row.email,
      oidcSub: row.sub!,
      issuer: row.issuer!,
      inviteHash,
    });
    if (!made.ok) {
      switch (made.reason) {
        case "provider_changed":
          return providerChanged(hash);
        case "username_taken":
          return core.usernameTaken(username);
        case "invite_required":
          return core.inviteRequired();
        case "invite_invalid":
          return core.inviteInvalid();
        case "setup_required":
          return setupRequired();
        case "already_linked":
          return fail(409, "already_linked", "this identity is already linked to an account here; sign in again");
      }
    }
    // Spent only now: a refused username leaves the ticket for the next try.
    await db.takeOidcTicket(hash, "first_visit");
    core.reportJoin(made.account.alias, inviteHash, made.joined);
    return json({ ...(await core.issueTokens(made.account, displayName)), return_to: row.return_to }, 201, cleared(req));
  }

  /** Link a first-visit subject to an existing account, proven with that account's password. */
  async function link(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return fail(400, "bad_request", "expected a JSON object");
    const found = await firstVisit(req, body);
    if (found instanceof Response) return found;
    const { hash, row } = found;

    const username = normalizeUsername(field(body, "username"));
    const password = field(body, "password");
    if (!username || !password) return fail(400, "bad_request", "username and password are required");
    const wrong = () => fail(401, "invalid_credentials", "username or password is incorrect");
    // Refused before hashing: scrypt cost grows with the input.
    if (password.length > MAX_PASSWORD) return wrong();
    const account = await db.findAccountByUsername(username);
    const ok = await verifyPassword(password, account?.password_hash ?? (await decoy()));
    if (!account?.password_hash || !ok) return wrong();

    const outcome = await db.linkIdentity(account.alias, row.sub!, row.issuer!);
    if (outcome === "provider_changed") return providerChanged(hash);
    if (outcome === "no_account") return wrong();
    if (outcome === "taken" || outcome === "other_sub") {
      return fail(409, "already_linked", "that account, or this identity, is already linked to another one");
    }
    await db.takeOidcTicket(hash, "first_visit");
    if (outcome === "linked") linked(account.alias, "first_visit");
    return json({ ...(await core.issueTokens(account)), return_to: row.return_to }, 200, cleared(req));
  }

  /** Unlink the provider from your own account; refused while it is the only way in. */
  async function unlink(req: Request): Promise<Response> {
    const account = await core.bearerAccount(req);
    if (account instanceof Response) return account;
    if (!account) return fail(401, "invalid_token", "sign in again");
    const outcome = await db.unlinkIdentity(account.alias);
    if (outcome === "no_password") return fail(409, "password_required", "set a password first");
    if (outcome === "unlinked") deps.onIdentityChange?.({ alias: account.alias, action: "node.identity.unlink", detail: {} });
    return new Response(null, { status: 204 });
  }

  return { start, callback, handoff, ticket, complete, link, unlink };
}
