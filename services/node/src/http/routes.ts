/**
 * Every route the app answers, in match order. The first route whose method and
 * path match wins, so a group's catch-all comes after the routes it covers.
 */
import { getAcl, setAcl } from "../api/acl.js";
import { getWhoami, updateWhoami } from "../api/account.js";
import {
  ask,
  createAskThreadRoute,
  deleteAskThreadRoute,
  getAskThreadRoute,
  listAskThreadsRoute,
  renameAskThreadRoute,
} from "../api/ask.js";
import {
  changeCollectionItemsRoute,
  createCollectionRoute,
  deleteCollectionRoute,
  getCollectionRoute,
  listCollectionsRoute,
  renameCollectionRoute,
} from "../api/collections.js";
import { addDocComment, deleteDocComment, listDocComments, resolveDocComment } from "../api/comments.js";
import {
  createDocumentRoute,
  deleteDocument,
  getDocInstructions,
  getDocument,
  getMarkdown,
  listDocuments,
  requestAccess,
  updateDocState,
  updateDocument,
} from "../api/docs.js";
import { addFavoriteRoute, listFavoritesRoute, removeFavoriteRoute } from "../api/favorites.js";
import {
  createFolderRoute,
  deleteFolderRoute,
  getFolderContents,
  getFolderInstructions,
  listFolderAncestors,
  listFolderChildren,
  updateFolderRoute,
  getPlacementInstructions,
} from "../api/folders.js";
import { syncGroup } from "../api/groups.js";
import { createInvite, listInvites, redeemInvite, revokeInvite } from "../api/invites.js";
import { listKeys, mintKey, revokeKey, rotateKey, updateKey } from "../api/keys.js";
import { listConnections, revokeConnection, updateConnection } from "../api/connections.js";
import { clearMediaTicket, mintMediaTicketRoute, readMedia, uploadImage } from "../api/media.js";
import { changeMemberRole, inviteMember, listMemberCandidates, listMembers, removeMember } from "../api/members.js";
import { listModels } from "../api/models.js";
import {
  grantNodeAdminRoute,
  listNodeAdminsRoute,
  mintPasswordResetRoute,
  revokeNodeAdminRoute,
  searchNodeUsersRoute,
} from "../api/node/admins.js";
import {
  getAiSettingsRoute,
  listProviderModels,
  resetAiSettingsRoute,
  saveAiSettingsRoute,
  testAiSettings,
} from "../api/node/ai-settings.js";
import {
  getNodeSettingsRoute,
  resetNodeSettingsRoute,
  saveNodeSettingsRoute,
  testNotifySink,
} from "../api/node/settings.js";
import { checkNodeVersion, getNodeVersion, installNodeVersion } from "../api/node/version.js";
import { getNodeBackups, startNodeBackup } from "../api/node/backups.js";
import { listNotificationsRoute, markNotificationsReadRoute, unreadNotifications } from "../api/notifications.js";
import { addOtherNode, listOtherNodes, removeOtherNode } from "../api/other-nodes.js";
import { ackDocRun, decideDocRun, getDocRun, listDocRuns, proposeEdit, revertDocRun } from "../api/runs.js";
import { retrieve, search } from "../api/search.js";
import { createShareLink, listDocShareLinks, redeemShareLink, revokeDocShareLink } from "../api/share-links.js";
import { getUsage } from "../api/usage.js";
import { listUsers, searchDirectory } from "../api/users.js";
import {
  deleteDocVersion,
  getVersionContent,
  listDocVersions,
  recoverDocument,
  restoreVersion,
} from "../api/versions.js";
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from "../api/workspaces.js";
import { mintSocketTicket } from "../api/ws.js";
import { getAgentBundle } from "../agents/bundle/route.js";
import { getAgentInstaller } from "../agents/install.js";
import { getAgentSetup } from "../agents/setup.js";
import { exportAudit, listAudit, listAuditFacets, listNodeAudit } from "../audit/routes.js";
import { databaseCoauthor } from "../databases/coauthor.js";
import { handleDatabaseImportUpload } from "../databases/imports/staging.js";
import {
  ackDatabaseRun,
  addColumn,
  commitImport,
  createImport,
  createTable,
  createView,
  databaseNotFound,
  databaseRoute,
  decideDatabaseRun,
  deleteColumn,
  deleteRows,
  deleteTable,
  deleteView,
  getDatabaseRun,
  getSchema,
  insertRows,
  listDatabaseRuns,
  listOps,
  listRows,
  openRowPageRoute,
  queryDatabase,
  renameTable,
  revertDatabaseRun,
  revertOp,
  updateColumn,
  updateRows,
  updateView,
} from "../databases/routes.js";
import { getInstructions, getProvenance, listEvents } from "../governance/events.js";
import { agentStats, listRunInbox } from "../governance/inbox.js";
import {
  createWebhook,
  deleteWebhookRoute,
  listWebhooksRoute,
  updateWebhookRoute,
} from "../governance/webhooks/routes.js";
import { handleMcpRequest } from "../mcp/handler.js";
import {
  handleAuthorize,
  handleClientInfo,
  handleConsent,
  handleRegister,
  handleRevoke,
  handleToken,
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
} from "../mcp/oauth.js";
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import type { AppRoute } from "./dispatch.js";
import { error, json } from "./respond.js";
import type { Method, WorkspaceCall } from "./router.js";

type Gates = Omit<Extract<AppRoute, { auth: "workspace" }>, "method" | "path" | "auth" | "handler">;
type Path = string | RegExp;

/** An API route behind a workspace member's context. */
function api(method: Method | readonly Method[] | "*", path: Path, handler: (call: WorkspaceCall) => Promise<Response>, gates: Gates = {}): AppRoute {
  return { method, path, auth: "workspace", handler, ...gates };
}

const methodNotAllowed = async (): Promise<Response> => error(405, "method not allowed");

const WORKSPACE_ADMIN = { humanOnly: "agents cannot manage workspaces" };
const KEYS = { humanOnly: "agents cannot manage api keys", guestForbidden: "manage api keys" };
const WEBHOOKS = { humanOnly: "agents cannot manage webhooks", workspaceAdmin: "manage webhooks" };
const NODE = { nodeAdmin: true };
/** Sent as a POST for its body, and still only a read. */
const READS = { readOnlyKeys: true } as const;
/** A credential's Ask threads are its own and nobody else sees them, so a read-only key keeps its history. */
const OWN_ASK_THREADS = { readOnlyKeys: true } as const;
const ACCOUNT = { auth: "account", humanOnly: "agents cannot manage workspaces" } as const;
/** A person's bookmarks to other nodes: an agent has no switcher to fill. */
const OTHER_NODES = { auth: "account", humanOnly: "agents cannot read or change a person's other nodes" } as const;
const CONNECTIONS = { auth: "account", humanOnly: "agents cannot manage connections" } as const;

const DOC = "/api/docs/([^/]+)";
const DATABASE = "/api/databases/([^/]+)";
const re = (source: string): RegExp => new RegExp(`^${source}$`);

export const APP_ROUTES: readonly AppRoute[] = [
  // Readiness asks the database and says nothing else: anyone who can reach the port can call it.
  {
    method: "*",
    path: "/ready",
    auth: "none",
    handler: async ({ env }) => {
      try {
        await env.sql`SELECT 1`;
        return json({ ok: true });
      } catch {
        return json({ ok: false }, { status: 503 });
      }
    },
  },
  { method: "GET", path: "/api/models", auth: "none", handler: listModels },
  { method: "GET", path: /^\/api\/agent-install\/([^/]+)$/, auth: "none", handler: getAgentInstaller },
  { method: "*", path: /^\/api\/agent-install\/([^/]+)$/, auth: "none", handler: methodNotAllowed },
  { method: "DELETE", path: "/api/media/ticket", auth: "none", handler: clearMediaTicket },
  { method: "GET", path: "/api/media/ticket", auth: "workspace", unmetered: true, handler: mintMediaTicketRoute },
  { method: "*", path: "/api/media/ticket", auth: "none", handler: methodNotAllowed },
  { method: "GET", path: MEDIA_GET_PATH, auth: "none", handler: readMedia },

  // OAuth for agent connectors: consent verifies the human's token itself, token verifies the PKCE code.
  { method: "*", path: "/.well-known/oauth-authorization-server", auth: "none", handler: async ({ env, req }) => wellKnownAuthorizationServer(env, req) },
  // RFC 9728 puts the resource's path after the well-known name; the bare name is kept for clients that ask for it.
  {
    method: "*",
    path: /^\/\.well-known\/oauth-protected-resource(?:\/mcp)?$/,
    auth: "none",
    handler: async ({ env, req }) => wellKnownProtectedResource(env, req),
  },
  { method: "POST", path: "/oauth/register", auth: "none", handler: ({ env, req }) => handleRegister(env, req) },
  { method: "GET", path: "/oauth/authorize", auth: "none", handler: ({ env, req }) => handleAuthorize(env, req) },
  { method: "GET", path: "/oauth/client", auth: "none", handler: ({ env, req }) => handleClientInfo(env, req) },
  { method: "POST", path: "/oauth/consent", auth: "none", handler: ({ env, req }) => handleConsent(env, req) },
  { method: "POST", path: "/oauth/token", auth: "none", handler: ({ env, req }) => handleToken(env, req) },
  { method: "POST", path: "/oauth/revoke", auth: "none", handler: ({ env, req }) => handleRevoke(env, req) },
  { method: "*", path: "/mcp", auth: "mcp", handler: ({ caller, req }) => handleMcpRequest(caller, req) },
  // Upgrades are answered by the upgrade handler; this is a client that forgot the header.
  { method: "*", path: /^\/ws\/([^/]+)$/, auth: "none", handler: async () => error(426, "expected websocket") },
  // The signed, single-use URL a staged import hands out is the whole credential.
  {
    method: "PUT",
    path: re(`${DATABASE}/imports/([^/]+)/upload`),
    auth: "none",
    handler: ({ env, req, url, match }) => handleDatabaseImportUpload(env, req, match[1]!, match[2]!, url.searchParams.get("sig")),
  },

  // Before any membership exists: workspace discovery and creation, and redemptions.
  { method: "GET", path: "/api/workspaces", ...ACCOUNT, handler: listWorkspaces },
  { method: "POST", path: "/api/workspaces", ...ACCOUNT, handler: createWorkspace },
  { method: "POST", path: "/api/invites/redeem", ...ACCOUNT, handler: redeemInvite },
  { method: "POST", path: "/api/share-links/redeem", ...ACCOUNT, handler: redeemShareLink },
  // The switcher's Other nodes, which a person without a workspace has too.
  { method: "GET", path: "/api/me/connections", ...CONNECTIONS, handler: listConnections },
  { method: "PATCH", path: /^\/api\/me\/connections\/([^/]+)$/, ...CONNECTIONS, handler: updateConnection },
  { method: "DELETE", path: /^\/api\/me\/connections\/([^/]+)$/, ...CONNECTIONS, handler: revokeConnection },
  { method: "GET", path: "/api/me/nodes", ...OTHER_NODES, handler: listOtherNodes },
  { method: "POST", path: "/api/me/nodes", ...OTHER_NODES, handler: addOtherNode },
  { method: "DELETE", path: /^\/api\/me\/nodes\/([^/]+)$/, ...OTHER_NODES, handler: removeOtherNode },
  { method: "*", path: /^\/api\/me\/nodes(\/.*)?$/, ...OTHER_NODES, handler: methodNotAllowed },

  api("GET", "/api/whoami", getWhoami),
  api("PATCH", "/api/whoami", updateWhoami, { humanOnly: "agents cannot change the profile of the human who minted them" }),
  api("GET", "/api/ws/ticket", mintSocketTicket),
  api("GET", "/api/agent-setup", getAgentSetup),
  api("GET", "/api/agent-bundle", getAgentBundle, { humanOnly: "agents cannot download the extension" }),

  // Agent governance.
  api("GET", "/api/runs", listRunInbox, { humanOnly: "agents cannot read the review inbox" }),
  api("GET", "/api/agents/stats", agentStats, { humanOnly: "agents cannot read agent statistics" }),
  api("GET", "/api/webhooks", listWebhooksRoute, WEBHOOKS),
  api("POST", "/api/webhooks", createWebhook, WEBHOOKS),
  api("PATCH", /^\/api\/webhooks\/([^/]+)$/, updateWebhookRoute, WEBHOOKS),
  api("DELETE", /^\/api\/webhooks\/([^/]+)$/, deleteWebhookRoute, WEBHOOKS),
  api("*", /^\/api\/webhooks(\/.*)?$/, methodNotAllowed, WEBHOOKS),
  api("GET", "/api/events", listEvents),
  api("GET", "/api/instructions", getInstructions),
  api("GET", re(`${DOC}/provenance`), getProvenance),
  api("GET", "/api/audit/export", exportAudit),

  // Structured databases: the data plane; lifecycle stays on /api/docs.
  api("GET", re(`${DATABASE}/schema`), databaseRoute(getSchema)),
  api("POST", re(`${DATABASE}/tables`), databaseRoute(createTable)),
  api("PATCH", re(`${DATABASE}/tables/([^/]+)`), databaseRoute(renameTable)),
  api("DELETE", re(`${DATABASE}/tables/([^/]+)`), databaseRoute(deleteTable)),
  api("POST", re(`${DATABASE}/tables/([^/]+)/columns`), databaseRoute(addColumn)),
  api("PATCH", re(`${DATABASE}/tables/([^/]+)/columns/([^/]+)`), databaseRoute(updateColumn)),
  api("DELETE", re(`${DATABASE}/tables/([^/]+)/columns/([^/]+)`), databaseRoute(deleteColumn)),
  api("POST", re(`${DATABASE}/tables/([^/]+)/views`), databaseRoute(createView)),
  api("PATCH", re(`${DATABASE}/tables/([^/]+)/views/([^/]+)`), databaseRoute(updateView)),
  api("DELETE", re(`${DATABASE}/tables/([^/]+)/views/([^/]+)`), databaseRoute(deleteView)),
  // Opening a live page only reads; restoring or creating one is refused inside to a caller who cannot write.
  api("POST", re(`${DATABASE}/tables/([^/]+)/rows/([^/]+)/page`), databaseRoute(openRowPageRoute), READS),
  api("POST", re(`${DATABASE}/tables/([^/]+)/rows/list`), databaseRoute(listRows), READS),
  api("POST", re(`${DATABASE}/tables/([^/]+)/rows`), databaseRoute(insertRows)),
  api("PATCH", re(`${DATABASE}/tables/([^/]+)/rows`), databaseRoute(updateRows)),
  api("POST", re(`${DATABASE}/tables/([^/]+)/rows/delete`), databaseRoute(deleteRows)),
  api("POST", re(`${DATABASE}/query`), databaseRoute(queryDatabase), READS),
  api("POST", re(`${DATABASE}/ai`), databaseRoute(databaseCoauthor)),
  api("GET", re(`${DATABASE}/runs`), databaseRoute(listDatabaseRuns)),
  api("GET", re(`${DATABASE}/runs/([^/]+)`), databaseRoute(getDatabaseRun)),
  api("POST", re(`${DATABASE}/runs/([^/]+)/decision`), databaseRoute(decideDatabaseRun)),
  api("POST", re(`${DATABASE}/runs/([^/]+)/revert`), databaseRoute(revertDatabaseRun)),
  api("POST", re(`${DATABASE}/runs/([^/]+)/ack`), databaseRoute(ackDatabaseRun)),
  api("POST", re(`${DATABASE}/imports`), databaseRoute(createImport)),
  api("POST", re(`${DATABASE}/imports/([^/]+)/commit`), databaseRoute(commitImport)),
  api("GET", re(`${DATABASE}/ops`), databaseRoute(listOps)),
  api("POST", re(`${DATABASE}/ops/([^/]+)/revert`), databaseRoute(revertOp)),
  api("*", /^\/api\/databases\/([^/]+)(\/.*)?$/, databaseRoute(databaseNotFound)),

  // Node administration: machine-wide, never a workspace's.
  api("GET", "/api/node/admins", listNodeAdminsRoute, NODE),
  api("POST", "/api/node/admins", grantNodeAdminRoute, NODE),
  api("*", "/api/node/admins", methodNotAllowed, NODE),
  api("DELETE", /^\/api\/node\/admins\/([^/]+)$/, revokeNodeAdminRoute, NODE),
  api("POST", "/api/node/password-resets", mintPasswordResetRoute, NODE),
  api("GET", "/api/node/users", searchNodeUsersRoute, NODE),
  api("GET", "/api/node/settings", getNodeSettingsRoute, NODE),
  api("PUT", "/api/node/settings", saveNodeSettingsRoute, NODE),
  api("DELETE", "/api/node/settings", resetNodeSettingsRoute, NODE),
  api("*", "/api/node/settings", methodNotAllowed, NODE),
  api("POST", "/api/node/settings/notify-test", testNotifySink, NODE),
  api("GET", "/api/node/ai-settings", getAiSettingsRoute, NODE),
  api("PUT", "/api/node/ai-settings", saveAiSettingsRoute, NODE),
  api("DELETE", "/api/node/ai-settings", resetAiSettingsRoute, NODE),
  api("*", "/api/node/ai-settings", methodNotAllowed, NODE),
  api("POST", "/api/node/ai-settings/test", testAiSettings, NODE),
  api("POST", "/api/node/ai-settings/models", listProviderModels, NODE),
  api("GET", "/api/node/audit", listNodeAudit, NODE),
  api("GET", "/api/node/version", getNodeVersion, NODE),
  api("POST", "/api/node/version/check", checkNodeVersion, NODE),
  api("POST", "/api/node/version/install", installNodeVersion, NODE),
  api("GET", "/api/node/backups", getNodeBackups, NODE),
  api("POST", "/api/node/backups", startNodeBackup, NODE),
  api("*", "/api/node/backups", methodNotAllowed, NODE),
  api("*", /^\/api\/node\//, async ({ req, url }) => error(404, `no route for ${req.method} ${url.pathname}`), NODE),

  // Workspaces: tenant management, human-only.
  api("PATCH", /^\/api\/workspaces\/([^/]+)$/, updateWorkspace, WORKSPACE_ADMIN),
  api("DELETE", /^\/api\/workspaces\/([^/]+)$/, deleteWorkspace, WORKSPACE_ADMIN),
  api("GET", /^\/api\/workspaces\/([^/]+)\/members$/, listMembers, WORKSPACE_ADMIN),
  api("POST", /^\/api\/workspaces\/([^/]+)\/members$/, inviteMember, WORKSPACE_ADMIN),
  api("GET", /^\/api\/workspaces\/([^/]+)\/member-candidates$/, listMemberCandidates, WORKSPACE_ADMIN),
  api("PATCH", /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/, changeMemberRole, WORKSPACE_ADMIN),
  api("DELETE", /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/, removeMember, WORKSPACE_ADMIN),
  api("POST", /^\/api\/workspaces\/([^/]+)\/invites$/, createInvite, WORKSPACE_ADMIN),
  api("GET", /^\/api\/workspaces\/([^/]+)\/invites$/, listInvites, WORKSPACE_ADMIN),
  api("DELETE", /^\/api\/workspaces\/([^/]+)\/invites\/([^/]+)$/, revokeInvite, WORKSPACE_ADMIN),
  api("*", /^\/api\/workspaces(\/.*)?$/, methodNotAllowed, WORKSPACE_ADMIN),

  api("GET", "/api/usage", getUsage, { humanOnly: "agents cannot view the usage dashboard" }),
  api("GET", "/api/audit", listAudit),
  api("GET", "/api/audit/facets", listAuditFacets),

  // Agent credentials: personal, and never managed with an agent's own key.
  api("GET", "/api/keys", listKeys, KEYS),
  api("POST", "/api/keys", mintKey, KEYS),
  api("POST", /^\/api\/keys\/([^/]+)\/rotate$/, rotateKey, KEYS),
  api("PATCH", /^\/api\/keys\/([^/]+)$/, updateKey, KEYS),
  api("DELETE", /^\/api\/keys\/([^/]+)$/, revokeKey, KEYS),
  api("*", /^\/api\/keys(\/.*)?$/, methodNotAllowed, KEYS),

  api("GET", "/api/users", listUsers),
  api("GET", "/api/users/search", searchDirectory),

  // Documents.
  api("GET", "/api/docs", listDocuments),
  api("POST", "/api/docs", createDocumentRoute),
  api("GET", re(DOC), getDocument),
  api("PATCH", re(DOC), updateDocument),
  api("DELETE", re(DOC), deleteDocument),
  api("POST", re(`${DOC}/request-access`), requestAccess, { humanOnly: "agents cannot request access" }),
  api("GET", re(`${DOC}/runs`), listDocRuns),
  api("GET", re(`${DOC}/runs/([^/]+)`), getDocRun),
  api("POST", re(`${DOC}/runs/([^/]+)/decision`), decideDocRun),
  api("POST", re(`${DOC}/runs/([^/]+)/revert`), revertDocRun),
  api("POST", re(`${DOC}/runs/([^/]+)/ack`), ackDocRun),
  api("POST", re(`${DOC}/propose`), proposeEdit),
  api("GET", re(`${DOC}/markdown`), getMarkdown),
  api("GET", re(`${DOC}/instructions`), getDocInstructions),
  api("GET", re(`${DOC}/versions`), listDocVersions),
  api("GET", re(`${DOC}/versions/(\\d+)`), getVersionContent),
  api("DELETE", re(`${DOC}/versions/(\\d+)`), deleteDocVersion),
  api("POST", re(`${DOC}/restore`), restoreVersion),
  api("POST", re(`${DOC}/recover`), recoverDocument),
  api("POST", re(`${DOC}/media`), uploadImage),
  api("GET", re(`${DOC}/comments`), listDocComments),
  api("POST", re(`${DOC}/comments`), addDocComment),
  api("PATCH", re(`${DOC}/comments/(\\d+)`), resolveDocComment),
  api("DELETE", re(`${DOC}/comments/(\\d+)`), deleteDocComment),
  api("GET", /^\/api\/(docs|folders)\/([^/]+)\/acl$/, getAcl),
  api("PUT", /^\/api\/(docs|folders)\/([^/]+)\/acl$/, setAcl),
  api("PATCH", re(`${DOC}/state`), updateDocState),
  api("POST", re(`${DOC}/share-links`), createShareLink),
  api("GET", re(`${DOC}/share-links`), listDocShareLinks),
  api("DELETE", re(`${DOC}/share-links/([^/]+)`), revokeDocShareLink),

  api("GET", "/api/folders", listFolderChildren),
  api("POST", "/api/folders", createFolderRoute),
  // One segment, so it never matches the per-folder routes below.
  api("GET", "/api/folders/instructions", getPlacementInstructions),
  api("GET", /^\/api\/folders\/([^/]+)\/ancestors$/, listFolderAncestors),
  api("GET", /^\/api\/folders\/([^/]+)\/contents$/, getFolderContents),
  api("GET", /^\/api\/folders\/([^/]+)\/instructions$/, getFolderInstructions),
  api("PATCH", /^\/api\/folders\/([^/]+)$/, updateFolderRoute),
  api("DELETE", /^\/api\/folders\/([^/]+)$/, deleteFolderRoute),

  api("GET", "/api/collections", listCollectionsRoute),
  api("POST", "/api/collections", createCollectionRoute),
  api(["POST", "DELETE"], /^\/api\/collections\/([^/]+)\/items$/, changeCollectionItemsRoute),
  api("GET", /^\/api\/collections\/([^/]+)$/, getCollectionRoute),
  api("PATCH", /^\/api\/collections\/([^/]+)$/, renameCollectionRoute),
  api("DELETE", /^\/api\/collections\/([^/]+)$/, deleteCollectionRoute),

  api("GET", "/api/ask/threads", listAskThreadsRoute),
  api("POST", "/api/ask/threads", createAskThreadRoute, OWN_ASK_THREADS),
  api("GET", /^\/api\/ask\/threads\/([^/]+)$/, getAskThreadRoute),
  api("PATCH", /^\/api\/ask\/threads\/([^/]+)$/, renameAskThreadRoute, OWN_ASK_THREADS),
  api("DELETE", /^\/api\/ask\/threads\/([^/]+)$/, deleteAskThreadRoute, OWN_ASK_THREADS),

  api("PUT", /^\/api\/groups\/([^/]+)$/, syncGroup),
  api("POST", "/api/search", search, READS),
  api("POST", "/api/ask", ask, READS),
  api("POST", "/api/retrieve", retrieve, READS),

  api("GET", "/api/favorites", listFavoritesRoute),
  api("PUT", "/api/favorites", addFavoriteRoute),
  api("DELETE", /^\/api\/favorites\/([^/]+)$/, removeFavoriteRoute),

  api("GET", "/api/notifications/unread", unreadNotifications),
  api("GET", "/api/notifications", listNotificationsRoute),
  api("POST", "/api/notifications/read", markNotificationsReadRoute),

  api("*", /^\/api\//, async () => error(404, "no such route")),
];
