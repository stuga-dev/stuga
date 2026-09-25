/**
 * The OAuth 2.1 authorization server MCP connectors sign in through: discovery
 * (RFC 8414, RFC 9728) for whichever of the node's origins was asked, clients
 * registered dynamically (RFC 7591) or known by a metadata document (CIMD),
 * authorization code with PKCE S256, rotating refresh tokens, and revocation
 * (RFC 7009). A consent creates or renews a grant: its person's authorization of
 * one client over the workspaces they chose. Tokens are for /mcp only.
 */
import { createHash } from "node:crypto";
import {
  type OauthClientRow,
  consumeOauthCode,
  getMemberRole,
  getOauthClient,
  insertOauthClient,
  insertOauthCode,
  insertOauthToken,
  listWorkspacesForUser,
  revokeOauthTokenFamily,
  rotateRefreshToken,
  upsertMetadataClient,
  upsertOauthGrant,
  type ApiKeyAccess,
  type NewOauthToken,
  type Sql,
} from "@stuga/db";
import { extractToken, hashConnectorToken, mintConnectorToken, randomBase64url, sha256Hex } from "@stuga/auth";
import { newAgentId } from "../agents/keys.js";
import { clientAddress, REQUEST_HOST_HEADER } from "../platform/http-server.js";
import type { NodeEnv } from "../env.js";
import { buildAccountContext, Unauthorized } from "../auth/context.js";
import { error, json } from "../http/respond.js";
import { isIpLiteral, isLocalName, isLoopbackHost, isNonPublicAddress } from "../net/addresses.js";
import { vetOutboundUrl } from "../net/outbound.js";

/** What a grant is named when its client gave no name. */
const CONNECTOR_AGENT_NAME = "MCP Connector";
const CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_SCOPE = "mcp";
/** An access token lives an hour; the client refreshes it. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token unused this long lapses, and the person signs in again. */
export const REFRESH_TOKEN_IDLE_DAYS = 90;
/** However often it refreshes, a sign-in ends this long after it happened. */
export const SIGN_IN_MAX_DAYS = 365;
const MAX_CONSENT_BODY_BYTES = 16 * 1024;
/** Long enough for any real client; short enough that 20 of them cannot be a payload on an open endpoint. */
const MAX_REDIRECT_URI_CHARS = 2048;
/** A client id is a registered `cid_…` or the https URL of its metadata document. */
const MAX_CLIENT_ID_CHARS = 2048;
/** A client metadata document is a few hundred bytes; this is generous. */
const MAX_METADATA_BYTES = 64 * 1024;
const METADATA_TIMEOUT_MS = 5_000;
/** How long a fetched metadata document is trusted before it is fetched again. */
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Token responses carry credentials, so no cache may keep them. */
const sensitiveJson = (data: unknown, status: number): Response =>
  json(data, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

// ---- Origins ------------------------------------------------------------------------

/**
 * The node's origin a request came in on: PUBLIC_ORIGIN or one of EXTRA_ORIGINS,
 * matched on the Host the client sent. Discovery answers on that origin, so a
 * client that reached the node by its LAN name is sent back to its LAN name.
 */
export function requestOrigin(env: Pick<NodeEnv, "publicOrigin" | "extraOrigins">, req: Request): string {
  const host = req.headers.get(REQUEST_HOST_HEADER)?.toLowerCase();
  if (!host) return env.publicOrigin;
  return [env.publicOrigin, ...env.extraOrigins].find((origin) => new URL(origin).host === host) ?? env.publicOrigin;
}

/** Every URL this node answers /mcp at: one resource server, reachable by several names. */
function mcpResources(env: Pick<NodeEnv, "publicOrigin" | "extraOrigins">): string[] {
  return [env.publicOrigin, ...env.extraOrigins].map((origin) => `${origin}/mcp`);
}

/** Only an origin the internet can reach may promise to fetch client metadata documents, which live on the internet. */
function isPublicHttpsOrigin(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  if (protocol !== "https:") return false;
  return !isLocalName(hostname) && !(isIpLiteral(hostname) && isNonPublicAddress(hostname));
}

// ---- Discovery ----------------------------------------------------------------------

export function wellKnownAuthorizationServer(env: NodeEnv, req: Request): Response {
  const base = requestOrigin(env, req);
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: isPublicHttpsOrigin(base),
  });
}

export function wellKnownProtectedResource(env: NodeEnv, req: Request): Response {
  const base = requestOrigin(env, req);
  return json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
  });
}

/** The 401 that starts a client's discovery, pointing at the metadata for the origin it called. */
export function unauthorizedChallenge(env: Pick<NodeEnv, "publicOrigin" | "extraOrigins">, req: Request): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${requestOrigin(env, req)}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}

// ---- Clients ------------------------------------------------------------------------

/** Absolute HTTPS, or plain HTTP to loopback for a native client. */
export function isValidRedirectUri(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_CHARS) return false;
  try {
    const parsed = new URL(value);
    if (parsed.hash || parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * A redirect URI a client registered, matched exactly — except that a loopback
 * one matches on any port (RFC 8252 §7.3): a native client listens wherever the
 * system gave it a port that day.
 */
export function redirectUriMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let target: URL;
  try {
    target = new URL(given);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" || !isLoopbackHost(target.hostname)) return false;
  const portless = (u: URL): string => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
  return registered.some((r) => {
    try {
      const url = new URL(r);
      return url.protocol === "http:" && isLoopbackHost(url.hostname) && portless(url) === portless(target);
    } catch {
      return false;
    }
  });
}

/**
 * Registering a client, or making the node fetch one's metadata document, takes
 * no credential by design, so its budget is keyed on the client address: an open
 * endpoint must not grow the client table or send the node fetching without end.
 * The standard budget, not the auth one, so a burst cannot lock people out of signing in.
 */
async function clientBudgetSpent(env: NodeEnv, req: Request, what: "register" | "metadata"): Promise<boolean> {
  const { success } = await env.rateLimit.limit({ key: `oauth:${what}:${clientAddress(req, env.trustProxyHeaders)}` });
  return !success;
}

async function registrationRefusal(env: NodeEnv, req: Request): Promise<Response | null> {
  if (!(await clientBudgetSpent(env, req, "register"))) return null;
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
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: clientName,
    },
    { status: 201 },
  );
}

/** A client id that names its own metadata document. */
function isMetadataClientId(clientId: string): boolean {
  if (!clientId.startsWith("https://")) return false;
  try {
    return new URL(clientId).pathname.length > 1;
  } catch {
    return false;
  }
}

export class ClientRefusal extends Error {}

/** Read a response body up to a limit, refusing more. */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ClientRefusal("the client metadata document is too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ClientRefusal("the client metadata document is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Fetch and check a client's metadata document: https only, never a private
 * address, no redirects, and a `client_id` inside that repeats its own URL.
 */
async function fetchClientMetadata(clientId: string): Promise<{ redirectUris: string[]; clientName: string }> {
  const vetted = await vetOutboundUrl(clientId);
  if (!vetted.ok) throw new ClientRefusal(`cannot fetch the client metadata document: ${vetted.reason}`);
  const res = await fetch(vetted.url.toString(), {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  }).catch((e) => {
    throw new ClientRefusal(`cannot fetch the client metadata document: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (res.status !== 200) throw new ClientRefusal(`the client metadata document answered HTTP ${res.status}`);
  let doc: { client_id?: unknown; redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  try {
    doc = JSON.parse(await readCappedText(res, MAX_METADATA_BYTES)) as typeof doc;
  } catch (e) {
    if (e instanceof ClientRefusal) throw e;
    throw new ClientRefusal("the client metadata document is not JSON");
  }
  if (doc.client_id !== clientId) throw new ClientRefusal("the client metadata document names a different client_id");
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every((u) => typeof u === "string" && isValidRedirectUri(u))) {
    throw new ClientRefusal("the client metadata document has no valid redirect_uris");
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    throw new ClientRefusal("only public PKCE clients are supported");
  }
  return { redirectUris: [...new Set(uris as string[])], clientName: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : "" };
}

/** The client a request names: registered, or known by its metadata document, fetched again once a day. */
async function resolveClient(env: NodeEnv, req: Request, clientId: string): Promise<OauthClientRow> {
  if (!clientId || clientId.length > MAX_CLIENT_ID_CHARS) throw new ClientRefusal("unknown client_id");
  const known = await getOauthClient(env.sql, clientId);
  if (known?.kind === "dcr") return known;
  if (!isMetadataClientId(clientId)) throw new ClientRefusal("unknown client_id");
  const fresh = known?.metadata_fetched_at && Date.now() - Date.parse(known.metadata_fetched_at) < METADATA_TTL_MS;
  if (known && fresh) return known;
  if (await clientBudgetSpent(env, req, "metadata")) throw new ClientRefusal("too many client lookups; slow down and retry shortly");
  return upsertMetadataClient(env.sql, { clientId, ...(await fetchClientMetadata(clientId)) });
}

/** The host that vouches for a client: its metadata document's, or none for one that registered itself. */
function verifiedHost(client: Pick<OauthClientRow, "kind" | "client_id">): string | null {
  return client.kind === "cimd" ? new URL(client.client_id).host : null;
}

/**
 * What the consent screen shows about a client, from the node's own records, so
 * a crafted consent link cannot dress one client up as another.
 */
export async function handleClientInfo(env: NodeEnv, req: Request): Promise<Response> {
  const clientId = new URL(req.url).searchParams.get("client_id") ?? "";
  try {
    const client = await resolveClient(env, req, clientId);
    return json({ client_id: client.client_id, client_name: client.client_name, verified_host: verifiedHost(client) });
  } catch (e) {
    if (e instanceof ClientRefusal) return error(400, e.message);
    throw e;
  }
}

// ---- Authorization ------------------------------------------------------------------

/**
 * The app's consent screen. It must not be /oauth/authorize: the API wins every
 * GET it claims on the shared origin, so the hand-off would redirect to itself
 * forever. The API answers this path for POST only.
 */
export const CONSENT_PATH = "/oauth/consent";

/** A `resource` names this node's /mcp, whichever of its origins; absent, it is the origin asked. */
function resourceRefusal(env: NodeEnv, resource: string | null): string | null {
  if (resource === null || resource === "") return null;
  return mcpResources(env).includes(resource.replace(/\/$/, "")) ? null : "resource is not this node's /mcp endpoint";
}

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
  if (state.length > 1024 || clientId.length > MAX_CLIENT_ID_CHARS || redirectUri.length > MAX_REDIRECT_URI_CHARS) {
    return error(400, "authorization parameters too long");
  }
  if (codeChallengeMethod !== "S256" || !PKCE_CHALLENGE.test(codeChallenge)) {
    return error(400, "PKCE S256 code_challenge required");
  }
  let client: OauthClientRow;
  try {
    client = await resolveClient(env, req, clientId);
  } catch (e) {
    if (e instanceof ClientRefusal) return error(400, e.message);
    throw e;
  }
  if (!redirectUriMatches(client.redirect_uris, redirectUri)) return error(400, "redirect_uri mismatch");
  const badResource = resourceRefusal(env, q.get("resource"));
  if (badResource) return error(400, badResource);

  const consent = new URL(`${requestOrigin(env, req)}${CONSENT_PATH}`);
  consent.searchParams.set("client_id", clientId);
  consent.searchParams.set("redirect_uri", redirectUri);
  consent.searchParams.set("state", state);
  consent.searchParams.set("code_challenge", codeChallenge);
  consent.searchParams.set("code_challenge_method", codeChallengeMethod);
  consent.searchParams.set("response_type", responseType);
  return new Response(null, { status: 302, headers: { location: consent.toString() } });
}

/** The workspaces a consent may name: every one its person belongs to other than as a guest. */
async function consentableWorkspaces(sql: Sql, alias: string): Promise<Set<string>> {
  const rows = await listWorkspacesForUser(sql, alias);
  return new Set(rows.filter((w) => w.role !== "guest").map((w) => w.workspace_id));
}

/**
 * The person's answer on the consent screen: which workspaces, and whether the
 * client may only read. Both answers return the redirect back to the client,
 * and only after `redirect_uri` matched one the client registered: the screen's
 * own query string is attacker-reachable, so the page never navigates to it itself.
 */
export async function handleConsent(env: NodeEnv, req: Request): Promise<Response> {
  if (!extractToken(req)) return error(401, "login required");
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONSENT_BODY_BYTES) {
    return error(413, "request body too large");
  }
  let account;
  try {
    account = await buildAccountContext(req, env);
  } catch (e) {
    if (e instanceof Unauthorized) return error(401, "invalid token");
    throw e;
  }
  // An agent's credential is not a login: an agent must not mint further agents.
  if (account.isAgent) return error(401, "login required");

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

  let client: OauthClientRow;
  try {
    client = await resolveClient(env, req, clientId);
  } catch (e) {
    if (e instanceof ClientRefusal) return error(400, "invalid client/redirect");
    throw e;
  }
  if (!redirectUriMatches(client.redirect_uris, redirectUri)) return error(400, "invalid client/redirect");
  const back = (params: Record<string, string>): Response => {
    const redirect = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...params, ...(state ? { state } : {}) })) redirect.searchParams.set(key, value);
    return sensitiveJson({ redirect: redirect.toString() }, 200);
  };

  if (decision === "deny") return back({ error: "access_denied" });

  const codeChallenge = body?.code_challenge;
  if (typeof codeChallenge !== "string" || !PKCE_CHALLENGE.test(codeChallenge)) return error(400, "invalid consent params");
  const access = body?.access ?? "propose";
  if (access !== "read" && access !== "propose") return error(400, "access must be read | propose");

  const allowed = await consentableWorkspaces(env.sql, account.alias);
  if (allowed.size === 0) return error(409, "create or join a workspace before connecting an agent");
  // "all" is every workspace its person belongs to, now and later; otherwise the ones they ticked.
  let workspaceScope: string[] | null;
  if (body?.workspaces === "all") {
    workspaceScope = null;
  } else {
    const ids = body?.workspaces;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((id) => typeof id === "string")) {
      return error(400, "choose at least one workspace");
    }
    const unique = [...new Set(ids as string[])];
    // A guest connects no agent; one refusal for unknown and not-a-member alike.
    if (!unique.every((id) => allowed.has(id))) return error(403, "one of those workspaces is not available to connect");
    workspaceScope = unique;
  }

  const code = randomBase64url(32);
  await insertOauthCode(env.sql, {
    codeHash: sha256Hex(code),
    clientId,
    userAlias: account.alias,
    workspaceScope,
    access: access as ApiKeyAccess,
    redirectUri,
    codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return back({ code });
}

// ---- Tokens -------------------------------------------------------------------------

/** A new access token and refresh token for one sign-in, which began at `startedAt`, and the response that hands them over. */
function mintTokens(startedAt: Date): { rows: NewOauthToken[]; response: Response } {
  const access = mintConnectorToken("access");
  const refresh = mintConnectorToken("refresh");
  const now = Date.now();
  const refreshEnds = Math.min(now + REFRESH_TOKEN_IDLE_DAYS * 86_400_000, startedAt.getTime() + SIGN_IN_MAX_DAYS * 86_400_000);
  const accessEnds = Math.min(now + ACCESS_TOKEN_TTL_SECONDS * 1000, refreshEnds);
  return {
    rows: [
      { tokenHash: access.hash, kind: "access", expiresAt: new Date(accessEnds) },
      { tokenHash: refresh.hash, kind: "refresh", expiresAt: new Date(refreshEnds) },
    ],
    response: sensitiveJson(
      {
        access_token: access.token,
        token_type: "Bearer",
        expires_in: Math.max(0, Math.round((accessEnds - now) / 1000)),
        refresh_token: refresh.token,
        scope: OAUTH_SCOPE,
      },
      200,
    ),
  };
}

async function tokenParams(req: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONSENT_BODY_BYTES) return null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return ((await req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  const params: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(await req.text())) params[k] = v;
  return params;
}

/** Exchange a code for the grant's first tokens, or a refresh token for the next; form-encoded per RFC 6749, or JSON. */
export async function handleToken(env: NodeEnv, req: Request): Promise<Response> {
  const params = await tokenParams(req);
  if (!params) return tokenError("invalid_request");
  const stringParam = (name: string): string => (typeof params[name] === "string" ? params[name] : "");
  const clientId = stringParam("client_id");
  if (!clientId || clientId.length > MAX_CLIENT_ID_CHARS) return tokenError("invalid_request");
  if (resourceRefusal(env, stringParam("resource") || null)) return tokenError("invalid_target");

  if (params.grant_type === "refresh_token") {
    const refreshToken = stringParam("refresh_token");
    if (!refreshToken || refreshToken.length > 512) return tokenError("invalid_request");
    // The lookup also keeps a registration alive while it refreshes. One the node no longer knows registers again.
    if (!(await getOauthClient(env.sql, clientId))) return sensitiveJson({ error: "invalid_client" }, 401);
    let minted: ReturnType<typeof mintTokens> | null = null;
    const rotated = await rotateRefreshToken(env.sql, {
      tokenHash: hashConnectorToken(refreshToken),
      clientId,
      graceSeconds: env.auth.refreshRotationGraceSeconds,
      next: (startedAt) => (minted = mintTokens(startedAt)).rows,
    });
    return rotated.kind === "rotated" && minted ? (minted as ReturnType<typeof mintTokens>).response : tokenError("invalid_grant");
  }
  if (params.grant_type !== "authorization_code") return tokenError("unsupported_grant_type");

  const code = stringParam("code");
  const codeVerifier = stringParam("code_verifier");
  const redirectUri = stringParam("redirect_uri");
  if (!code || code.length > 512 || !redirectUri || redirectUri.length > MAX_REDIRECT_URI_CHARS || !PKCE_VALUE.test(codeVerifier)) {
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
  // The person may have left every workspace in the five minutes since they consented.
  if (consumed.workspace_scope) {
    const still = await Promise.all(consumed.workspace_scope.map((ws) => getMemberRole(env.sql, ws, consumed.user_alias)));
    if (!still.some(Boolean)) return tokenError("invalid_grant");
  }
  const client = await getOauthClient(env.sql, clientId);
  const grant = await upsertOauthGrant(env.sql, {
    grantId: `grt_${randomBase64url(12)}`,
    clientId,
    name: client?.client_name.trim() || CONNECTOR_AGENT_NAME,
    clientHost: client ? verifiedHost(client) : null,
    owner: consumed.user_alias,
    agentId: newAgentId("connector"),
    workspaceScope: consumed.workspace_scope,
    access: consumed.access,
  });
  const startedAt = new Date();
  const familyId = `fam_${randomBase64url(12)}`;
  const { rows, response } = mintTokens(startedAt);
  for (const row of rows) await insertOauthToken(env.sql, { ...row, grantId: grant.grant_id, familyId, familyStartedAt: startedAt });
  return response;
}

/** RFC 7009: end the sign-in a token belongs to. Unknown tokens are not an error, so the answer is always 200. */
export async function handleRevoke(env: NodeEnv, req: Request): Promise<Response> {
  const params = await tokenParams(req);
  const token = params && typeof params.token === "string" ? params.token : "";
  if (!token || token.length > 512) return tokenError("invalid_request");
  await revokeOauthTokenFamily(env.sql, hashConnectorToken(token));
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

function tokenError(code: string): Response {
  return sensitiveJson({ error: code }, 400);
}
