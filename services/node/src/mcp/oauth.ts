/**
 * The OAuth 2.1 authorization server MCP connectors sign in through: discovery
 * (RFC 8414, RFC 9728), open client registration (RFC 7591), and authorization
 * code with PKCE S256. The token it issues is an ordinary `vk_` API key, so the
 * /mcp request path never sees OAuth.
 */
import { createHash } from "node:crypto";
import { consumeOauthCode, getOauthClient, insertOauthClient, insertOauthCode, type Sql } from "@stuga/db";
import { extractToken, randomBase64url, sha256Hex } from "@stuga/auth";
import { createConnectorKey } from "../agents/keys.js";
import { clientAddress } from "../platform/http-server.js";
import type { NodeEnv } from "../env.js";
import { buildContext, Unauthorized, WorkspaceRequired, type Ctx } from "../auth/context.js";
import { error, json } from "../http/respond.js";
import { guestForbidden } from "../authz/authz.js";

/** What a connector key is named when its client registered without a name. */
const CONNECTOR_AGENT_NAME = "MCP Connector";
const CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_SCOPE = "mcp";
/**
 * What the token response advertises. A connector key does not expire — it is
 * revoked, not aged out — but a client that reads no `expires_in` may store a
 * zero expiry, read it as already expired, and then refuse to send the token
 * it just received. Google Antigravity does exactly that: it authenticates
 * once and never again. So the response claims a year, which understates the
 * key's real life and costs at worst one re-authorisation.
 */
const ACCESS_TOKEN_EXPIRES_IN = 365 * 24 * 60 * 60;
const MAX_CONSENT_BODY_BYTES = 16 * 1024;
/** Long enough for any real client; short enough that 20 of them cannot be a payload on an open endpoint. */
const MAX_REDIRECT_URI_CHARS = 2048;

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Token responses carry credentials, so no cache may keep them. */
const sensitiveJson = (data: unknown, status: number): Response =>
  json(data, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

/** Absolute HTTPS, or plain HTTP to loopback for a native client. */
export function isValidRedirectUri(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_CHARS) return false;
  try {
    const parsed = new URL(value);
    if (parsed.hash || parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    return parsed.protocol === "http:" && loopback;
  } catch {
    return false;
  }
}

export function wellKnownAuthorizationServer(env: NodeEnv): Response {
  const base = env.publicOrigin;
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
  });
}

export function wellKnownProtectedResource(env: NodeEnv): Response {
  const base = env.publicOrigin;
  return json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
  });
}

/** The 401 that starts a client's discovery. */
export function unauthorizedChallenge(env: NodeEnv): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${env.publicOrigin}/.well-known/oauth-protected-resource"`,
    },
  });
}

/**
 * Registration takes no credential by design, so its budget is keyed on the
 * client address. The standard budget, not the auth one, so a burst of
 * registrations cannot lock people out of signing in.
 */
async function registrationRefusal(env: NodeEnv, req: Request): Promise<Response | null> {
  const { success } = await env.rateLimit.limit({ key: `oauth:register:${clientAddress(req, env.trustProxyHeaders)}` });
  if (success) return null;
  const res = error(429, "too many client registrations; slow down and retry shortly");
  res.headers.set("retry-after", "60");
  return res;
}

export async function handleRegister(env: NodeEnv, req: Request): Promise<Response> {
  const limited = await registrationRefusal(env, req);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as {
    redirect_uris?: string[];
    client_name?: string;
    token_endpoint_auth_method?: string;
  } | null;
  if (!Array.isArray(body?.redirect_uris) || body.redirect_uris.length === 0) {
    return error(400, "redirect_uris required");
  }
  if (body.redirect_uris.length > 20 || !body.redirect_uris.every((u) => typeof u === "string")) {
    return error(400, "invalid redirect_uris");
  }
  if (body.redirect_uris.some((u) => u.length > MAX_REDIRECT_URI_CHARS)) {
    return error(400, `redirect_uri is too long (max ${MAX_REDIRECT_URI_CHARS} characters)`);
  }
  const redirectUris = [...new Set(body.redirect_uris)];
  if (!redirectUris.every(isValidRedirectUri)) return error(400, "invalid redirect_uri");
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return error(400, "only public PKCE clients are supported");
  }
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "";
  const clientId = `cid_${randomBase64url(12)}`;
  await insertOauthClient(env.sql, { clientId, clientSecretHash: null, redirectUris, clientName });
  return json(
    {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: clientName,
    },
    { status: 201 },
  );
}

/**
 * The app's consent screen. It must not be /oauth/authorize: the API wins every
 * GET it claims on the shared origin, so the hand-off would redirect to itself
 * forever. The API answers this path for POST only.
 */
export const CONSENT_PATH = "/oauth/consent";

/** Validate the authorize request and hand the browser to the consent screen with the checked parameters. */
export async function handleAuthorize(env: NodeEnv, req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  // Code with PKCE S256 is the only flow offered, and several clients omit these two; a stated value must still match.
  const responseType = q.get("response_type") ?? "code";
  const codeChallengeMethod = q.get("code_challenge_method") ?? "S256";
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state") ?? "";
  const codeChallenge = q.get("code_challenge") ?? "";

  if (responseType !== "code") return error(400, "response_type must be code");
  if (state.length > 1024 || clientId.length > 200 || redirectUri.length > MAX_REDIRECT_URI_CHARS) {
    return error(400, "authorization parameters too long");
  }
  if (codeChallengeMethod !== "S256" || !PKCE_CHALLENGE.test(codeChallenge)) {
    return error(400, "PKCE S256 code_challenge required");
  }
  const client = await getOauthClient(env.sql, clientId);
  if (!client) return error(400, "unknown client_id");
  if (!client.redirect_uris.includes(redirectUri)) return error(400, "redirect_uri mismatch");

  const consent = new URL(`${env.publicOrigin}${CONSENT_PATH}`);
  consent.searchParams.set("client_id", clientId);
  consent.searchParams.set("redirect_uri", redirectUri);
  consent.searchParams.set("state", state);
  consent.searchParams.set("code_challenge", codeChallenge);
  consent.searchParams.set("code_challenge_method", codeChallengeMethod);
  consent.searchParams.set("response_type", responseType);
  consent.searchParams.set("client_name", client.client_name);
  const scope = q.get("scope");
  if (scope) consent.searchParams.set("scope", scope.slice(0, 500));
  const resource = q.get("resource");
  if (resource) consent.searchParams.set("resource", resource.slice(0, MAX_REDIRECT_URI_CHARS));
  return new Response(null, { status: 302, headers: { location: consent.toString() } });
}

/**
 * The person's answer on the consent screen. Both answers return the redirect
 * back to the client, and only after `redirect_uri` matched one the client
 * registered: the screen's own query string is attacker-reachable, so the page
 * never navigates to it itself.
 */
export async function handleConsent(env: NodeEnv, req: Request): Promise<Response> {
  if (!extractToken(req)) return error(401, "login required");
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONSENT_BODY_BYTES) {
    return error(413, "request body too large");
  }

  // The same workspace resolution as every route; consent never creates a workspace.
  let ctx: Ctx;
  try {
    ctx = await buildContext(req, env);
  } catch (e) {
    if (e instanceof WorkspaceRequired) return error(409, "create or join a workspace before connecting an agent");
    if (e instanceof Unauthorized) return error(401, "invalid token");
    throw e;
  }
  // An API key is a credential, not a login: an agent must not mint further agents.
  if (ctx.isAgent) return error(401, "login required");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const decision = body?.decision;
  const clientId = body?.client_id;
  const redirectUri = body?.redirect_uri;
  const state = body?.state ?? "";
  if (
    (decision !== "allow" && decision !== "deny") ||
    typeof clientId !== "string" ||
    typeof redirectUri !== "string" ||
    typeof state !== "string" ||
    !clientId ||
    !redirectUri ||
    state.length > 1024
  ) {
    return error(400, "invalid consent params");
  }

  const client = await getOauthClient(ctx.sql, clientId);
  if (!client || !client.redirect_uris.includes(redirectUri)) return error(400, "invalid client/redirect");
  const back = (params: Record<string, string>): Response => {
    const redirect = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...params, ...(state ? { state } : {}) })) redirect.searchParams.set(key, value);
    return sensitiveJson({ redirect: redirect.toString() }, 200);
  };

  if (decision === "deny") return back({ error: "access_denied" });

  const codeChallenge = body?.code_challenge;
  if (typeof codeChallenge !== "string" || !PKCE_CHALLENGE.test(codeChallenge)) return error(400, "invalid consent params");
  // After the workspace resolves: someone may be a guest in one workspace and own the one they are connecting.
  const guest = guestForbidden(ctx, "connect an agent to this workspace");
  if (guest) return guest;

  const code = randomBase64url(32);
  await insertOauthCode(ctx.sql, {
    codeHash: sha256Hex(code),
    clientId,
    userAlias: ctx.alias,
    workspaceId: ctx.workspaceId,
    redirectUri,
    codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return back({ code });
}

/** Exchange a code for the connector's API key; form-encoded per RFC 6749, or JSON. */
export async function handleToken(env: NodeEnv, req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONSENT_BODY_BYTES) return tokenError("invalid_request");
  const ct = req.headers.get("content-type") ?? "";
  let params: Record<string, unknown> = {};
  if (ct.includes("application/json")) {
    params = ((await req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  } else {
    for (const [k, v] of new URLSearchParams(await req.text())) params[k] = v;
  }
  if (params.grant_type !== "authorization_code") return tokenError("unsupported_grant_type");
  const stringParam = (name: string): string => (typeof params[name] === "string" ? params[name] : "");
  const code = stringParam("code");
  const codeVerifier = stringParam("code_verifier");
  const clientId = stringParam("client_id");
  const redirectUri = stringParam("redirect_uri");
  if (
    !code ||
    code.length > 512 ||
    !clientId ||
    clientId.length > 200 ||
    !redirectUri ||
    redirectUri.length > MAX_REDIRECT_URI_CHARS ||
    !PKCE_VALUE.test(codeVerifier)
  ) {
    return tokenError("invalid_request");
  }

  // Every binding is checked inside the one atomic delete, so a wrong client, redirect or verifier cannot burn a valid code.
  const consumed = await consumeOauthCode(env.sql, {
    codeHash: sha256Hex(code),
    clientId,
    redirectUri,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  });
  if (!consumed) return tokenError("invalid_grant");

  const { token } = await createConnectorKey(env.sql, {
    owner: consumed.user_alias,
    workspaceId: consumed.workspace_id,
    name: await connectorName(env.sql, clientId),
  });
  // The key is the access token: it never expires and is revoked like any other key.
  return sensitiveJson(
    { access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_EXPIRES_IN, scope: OAUTH_SCOPE },
    200,
  );
}

/** Edits are attributed to the name the client registered under. */
async function connectorName(sql: Sql, clientId: string): Promise<string> {
  const client = await getOauthClient(sql, clientId).catch(() => null);
  return client?.client_name.trim() || CONNECTOR_AGENT_NAME;
}

function tokenError(code: string): Response {
  return sensitiveJson({ error: code }, 400);
}
