/**
 * Per-request context: authenticate the bearer credential and resolve the
 * caller's principal set from live membership.
 */
import {
  getDirectoryRow,
  resolveHumanAuth,
  getApiKey,
  touchApiKey,
  getMemberRole,
  getFolderSubtreeIds,
  grantForAccessToken,
  type DirectoryRow,
  type Sql,
} from "@stuga/db";
import {
  extractToken,
  principalsFrom,
  userPrincipal,
  AuthError,
  looksLikeApiKey,
  parseApiKey,
  sha256Hex,
  constantTimeEqual,
  agentPrincipal,
  connectorTokenKind,
  hashConnectorToken,
} from "@stuga/auth";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import { AGENT_CLIENT_HEADER, AGENT_LABEL_MAX, AGENT_MODEL_HEADER } from "@stuga/protocol/api/headers";
import type { NodeEnv } from "../env.js";
import { resolvePrincipals } from "./principals.js";
import type { WsTicket } from "./ws-ticket.js";

/** The transport a context was built on; the audit ledger records it as the row's source. */
export type Surface = "web" | "mcp" | "api-key" | "ws";

/** How a request reached the node: the REST API, the /mcp endpoint, or a socket upgrade. */
export type Transport = "http" | "mcp" | "ws";

interface AccountBase {
  /** The node's shared pooled client; nothing in a request ends it. */
  sql: Sql;
  surface: Surface;
  alias: string;
  /** A person's from their directory row; an agent's from its key. */
  displayName: string;
  /** The `x-request-id` this request is answered with, so ledger rows name it. Absent on sockets and in jobs. */
  requestId?: string;
  env: NodeEnv;
}

/** A person, authenticated with a session token. */
interface HumanAccountCtx extends AccountBase {
  isAgent: false;
  onBehalfOf?: undefined;
  scope?: undefined;
  client?: undefined;
  model?: undefined;
}

/** An agent, authenticated with an API key (or the in-app co-author panel). */
interface AgentAccountCtx extends AccountBase {
  isAgent: true;
  /** The human who minted its key (`api_keys.owner`): the reviewer of what it proposes. */
  onBehalfOf: string;
  /** What the key's owner confined it to; undefined for an unnarrowed key. */
  scope?: AgentScope;
  /** The `x-stuga-client` label, sanitized. Display only, never an authority. */
  client?: string;
  /** The `x-stuga-model` label, sanitized. */
  model?: string;
}

/** Authenticated identity without a required workspace membership. */
export type AccountCtx = HumanAccountCtx | AgentAccountCtx;

/**
 * The narrowing an agent credential carries. It only ever subtracts from the
 * owner's live reach: it is intersected with the ACL gate, never consulted instead of it.
 */
interface AgentScope {
  /** Every folder the key may act in, subtrees expanded, or null for the owner's
   *  whole reach. A document is in scope when its own parent folder is in this set. */
  folders: string[] | null;
  /** True for read access: every write surface refuses it. */
  readOnly: boolean;
  /** The API key or OAuth grant this request authenticated with. */
  credentialId: string;
}

interface WorkspaceScope {
  principals: string[];
  /** The tenant every query and route is scoped to. */
  workspaceId: string;
  /** For an agent, its owner's current role, which can only narrow its reach. */
  role: WorkspaceRole;
}

export type Ctx = AccountCtx & WorkspaceScope;

/**
 * A client or model label from a request header, or undefined when absent or
 * blank: control and format characters stripped, whitespace collapsed, capped
 * at AGENT_LABEL_MAX. Displayed, never parsed, so it is shortened rather than refused.
 */
export function agentLabel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  // Whitespace first, so a tab or newline separates words instead of vanishing as a control character.
  const cleaned = raw.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > AGENT_LABEL_MAX ? cleaned.slice(0, AGENT_LABEL_MAX) : cleaned;
}

export class Unauthorized extends Error {}
export class WorkspaceRequired extends Error {}

/** Marks the 409 that means "no workspace yet", so the web client redirects to onboarding on it alone. */
const WORKSPACE_REQUIRED_HEADER = "x-stuga-workspace-required";

export function workspaceRequiredResponse(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set(WORKSPACE_REQUIRED_HEADER, "1");
  return out;
}

/** The key's narrowing as stored: folder roots, not yet expanded. */
interface StoredScope {
  folders: string[] | null;
  readOnly: boolean;
  credentialId: string;
}

type AuthenticatedRequest =
  | { account: HumanAccountCtx }
  | { account: AgentAccountCtx; key: { workspaceId: string; scope: StoredScope } };

/**
 * Expand a key's folder roots into every folder it may act in. A root from
 * another workspace, or one since deleted, contributes nothing, so a key whose
 * roots are all gone reaches nothing rather than everything.
 */
async function expandScope(
  sql: Sql,
  workspaceId: string,
  raw: StoredScope,
): Promise<AgentScope> {
  if (!raw.folders) return { folders: null, readOnly: raw.readOnly, credentialId: raw.credentialId };
  const all = new Set<string>();
  for (const root of raw.folders) {
    for (const id of await getFolderSubtreeIds(sql, root, workspaceId)) all.add(id);
  }
  return { folders: [...all], readOnly: raw.readOnly, credentialId: raw.credentialId };
}

function surfaceOf(transport: Transport, isAgent: boolean): Surface {
  if (transport !== "http") return transport;
  return isAgent ? "api-key" : "web";
}

/** Authenticate a request without assuming the user already belongs to a workspace. */
async function authenticateRequest(req: Request, env: NodeEnv, transport: Transport): Promise<AuthenticatedRequest> {
  const token = extractToken(req);
  if (!token) throw new Unauthorized("missing token");
  const sql = env.sql;
  // An OAuth token's audience is /mcp, and only buildMcpCaller reads one.
  if (connectorTokenKind(token)) throw new Unauthorized("this token is for the /mcp endpoint only");

  // An API key resolves the key's own principal here; buildContext adds its owner's delegated set.
  if (looksLikeApiKey(token)) {
    const parsed = parseApiKey(token);
    if (!parsed) throw new Unauthorized("malformed api key");
    const row = await getApiKey(sql, parsed.keyId);
    if (!row || !constantTimeEqual(sha256Hex(parsed.secret), row.secret_hash)) {
      throw new Unauthorized("invalid api key");
    }
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw new Unauthorized("api key expired");
    await touchApiKey(sql, parsed.keyId).catch(() => {});
    return {
      account: {
        sql,
        surface: surfaceOf(transport, true),
        alias: row.agent_id,
        displayName: row.name || row.agent_id,
        isAgent: true,
        onBehalfOf: row.owner,
        client: agentLabel(req.headers.get(AGENT_CLIENT_HEADER)),
        model: agentLabel(req.headers.get(AGENT_MODEL_HEADER)),
        env,
      },
      key: {
        workspaceId: row.workspace_id,
        scope: { folders: row.scope_folders, readOnly: row.access === "read", credentialId: row.key_id },
      },
    };
  }

  let alias: string;
  try {
    ({ alias } = await env.verifier.verify(token));
  } catch (err) {
    if (err instanceof AuthError) throw new Unauthorized("invalid token");
    throw err;
  }
  return {
    account: {
      sql,
      surface: surfaceOf(transport, false),
      alias,
      // Filled from the directory row by the caller, which also refuses a token whose account is gone.
      displayName: "",
      isAgent: false,
      env,
    },
  };
}

/**
 * The name a person goes by, from their directory row. Accounts are made only
 * by registration or a first visit, never by a request, so a verified token
 * whose account no longer exists is refused.
 */
function directoryName(row: DirectoryRow | null): string {
  if (!row) throw new Unauthorized("this account no longer exists");
  return row.display_name || row.username;
}

/** Build identity context for account-level workspace creation and invite redemption. */
export async function buildAccountContext(req: Request, env: NodeEnv): Promise<AccountCtx> {
  const { account } = await authenticateRequest(req, env, "http");
  if (account.isAgent) return account;
  return { ...account, displayName: directoryName(await getDirectoryRow(account.sql, account.alias)) };
}

/** Build a workspace-scoped request context. */
export async function buildContext(req: Request, env: NodeEnv, transport: Transport = "http"): Promise<Ctx> {
  const authenticated = await authenticateRequest(req, env, transport);
  if ("key" in authenticated) {
    // An agent acts with its owner's reach, re-derived from live membership on
    // every request (a key outlives offboarding otherwise), in the workspace
    // pinned on the key and never one a request names.
    const { account, key } = authenticated;
    const workspaceId = key.workspaceId;
    const owner = account.onBehalfOf;
    const scope = await expandScope(account.sql, workspaceId, key.scope);
    const ownerRole = await getMemberRole(account.sql, workspaceId, owner);
    if (!ownerRole) {
      // 401 prompts a re-consent, which rebinds the key to a workspace its owner is in.
      throw new Unauthorized("the user who authorized this connector is no longer a member of this workspace");
    }
    const inherited = await resolvePrincipals(account.sql, owner, workspaceId, ownerRole);
    return {
      ...account,
      scope,
      // Its own principal stays: documents it created are granted to agent:<id>.
      principals: [...new Set([agentPrincipal(account.alias), ...inherited])],
      workspaceId,
      role: ownerRole,
    };
  }

  const { account } = authenticated;
  // Directory row, membership and groups in one round trip, cached nowhere, so
  // offboarding takes effect on the next request. The workspace override counts
  // only as a membership that exists; `|| null` turns an empty one into none.
  const requested = req.headers.get("x-stuga-workspace") || null;
  const auth = await resolveHumanAuth(
    account.sql,
    account.alias,
    userPrincipal(account.alias),
    requested,
  );
  // Before the membership check: a deleted account is refused, not sent to onboarding.
  const displayName = directoryName(auth.user);

  if (!auth.membership) {
    throw new WorkspaceRequired("create or join a workspace first");
  }
  const { workspace_id: workspaceId, role } = auth.membership;

  return {
    ...account,
    displayName,
    principals: principalsFrom(account.alias, workspaceId, role, auth.groupIds),
    workspaceId,
    role,
  };
}

/**
 * A workspace-scoped context for a socket opened with a ticket. The ticket
 * contributes identity and tenant only; reach is resolved from Postgres on every
 * upgrade. The equality check makes the signed tenant binding real, since
 * resolveHumanAuth falls back to another membership when asked for a foreign one.
 */
export async function buildSocketContext(env: NodeEnv, ticket: WsTicket): Promise<Ctx> {
  const sql = env.sql;
  const auth = await resolveHumanAuth(sql, ticket.alias, userPrincipal(ticket.alias), ticket.workspaceId);
  const displayName = directoryName(auth.user);
  if (!auth.membership || auth.membership.workspace_id !== ticket.workspaceId) {
    throw new Unauthorized("this ticket's holder is not a member of the workspace it names");
  }
  const { role } = auth.membership;
  return {
    sql,
    surface: "ws",
    alias: ticket.alias,
    displayName,
    // Tickets are minted only for human sessions.
    isAgent: false,
    env,
    principals: principalsFrom(ticket.alias, ticket.workspaceId, role, auth.groupIds),
    workspaceId: ticket.workspaceId,
    role,
  };
}

/**
 * Who is calling /mcp, and where they may act. Each tool call names its
 * workspace, so the workspace is resolved per call (`workspaceContextFor`),
 * never pinned to the credential.
 */
export interface McpCaller {
  account: AccountCtx;
  /** The workspaces the credential may act in; null = every workspace its person belongs to, now and later. */
  workspaces: readonly string[] | null;
  readOnly: boolean;
  /** A key minted by hand: its workspace and folder narrowing, which apply in that workspace. */
  key?: { workspaceId: string; scope: StoredScope };
}

/** The person an /mcp caller acts for. */
export function mcpPerson(caller: McpCaller): string {
  return caller.account.isAgent ? caller.account.onBehalfOf : caller.account.alias;
}

/**
 * Authenticate an /mcp request: an OAuth access token (a grant over the
 * workspaces its person chose), a key minted by hand (a folder-confined one
 * stays in its workspace), or a person's own session.
 */
export async function buildMcpCaller(req: Request, env: NodeEnv): Promise<McpCaller> {
  const token = extractToken(req);
  if (!token) throw new Unauthorized("missing token");
  const kind = connectorTokenKind(token);
  if (kind === "refresh") throw new Unauthorized("a refresh token is exchanged at /oauth/token, never sent as a bearer");
  if (kind === "access") {
    const grant = await grantForAccessToken(env.sql, hashConnectorToken(token));
    if (!grant) throw new Unauthorized("invalid or expired token");
    return {
      account: {
        sql: env.sql,
        surface: "mcp",
        alias: grant.agent_id,
        displayName: grant.name || grant.agent_id,
        isAgent: true,
        onBehalfOf: grant.owner,
        scope: { folders: null, readOnly: grant.access === "read", credentialId: grant.grant_id },
        client: agentLabel(req.headers.get(AGENT_CLIENT_HEADER)),
        model: agentLabel(req.headers.get(AGENT_MODEL_HEADER)),
        env,
      },
      workspaces: grant.workspace_scope,
      readOnly: grant.access === "read",
    };
  }
  const authenticated = await authenticateRequest(req, env, "mcp");
  if ("key" in authenticated) {
    const { account, key } = authenticated;
    return { account, workspaces: key.scope.folders ? [key.workspaceId] : null, readOnly: key.scope.readOnly, key };
  }
  const displayName = directoryName(await getDirectoryRow(env.sql, authenticated.account.alias));
  return { account: { ...authenticated.account, displayName }, workspaces: null, readOnly: false };
}

/**
 * The context one /mcp call runs under in the workspace it names, or null when
 * the credential may not act there or its person is not a member now. Never a
 * fallback to another workspace, which would land a write in the wrong tenant.
 */
export async function workspaceContextFor(caller: McpCaller, workspaceId: string): Promise<Ctx | null> {
  if (caller.workspaces && !caller.workspaces.includes(workspaceId)) return null;
  const { account } = caller;
  const role = await getMemberRole(account.sql, workspaceId, mcpPerson(caller));
  if (!role) return null;
  // A guest brings no agent into someone else's workspace, the rule consent and key minting follow.
  if (account.isAgent && role === "guest") return null;
  if (!account.isAgent) {
    return { ...account, workspaceId, role, principals: await resolvePrincipals(account.sql, account.alias, workspaceId, role) };
  }
  const inherited = await resolvePrincipals(account.sql, account.onBehalfOf, workspaceId, role);
  // A minted key's folders narrow it in its own workspace; anywhere else it has only its access level.
  const scope =
    caller.key && caller.key.workspaceId === workspaceId
      ? await expandScope(account.sql, workspaceId, caller.key.scope)
      : { folders: null, readOnly: caller.readOnly, credentialId: caller.key?.scope.credentialId ?? account.scope?.credentialId ?? "" };
  return {
    ...account,
    scope,
    // Its own principal stays: documents it created are granted to agent:<id>.
    principals: [...new Set([agentPrincipal(account.alias), ...inherited])],
    workspaceId,
    role,
  };
}
