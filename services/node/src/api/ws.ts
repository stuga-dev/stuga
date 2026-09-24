/** The WebSocket gateway: checks document access, then hands the upgrade to the document's actor. */
import { getDoc } from "@stuga/db";
import { mintWsTicket } from "../auth/ws-ticket.js";
import { canReadDoc, canWriteDoc, scopeFolderIds } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

/**
 * @param writeCeiling Whether the credential that opened this socket permits
 * writing at all: `true` for an API key, the ticket's write tier otherwise. It
 * only narrows the ACL's answer, which is read again here.
 */
export async function routeWebSocket(
  ctx: Ctx,
  env: NodeEnv,
  docId: string,
  agent: string | null,
  writeCeiling: boolean,
): Promise<Response> {
  const doc = await getDoc(ctx.sql, docId);
  if (!doc) return new Response("not found", { status: 404 });
  // Tenant gate first: another workspace's document is not found, whatever the ACL says.
  if (doc.workspace_id !== ctx.workspaceId) return new Response("not found", { status: 404 });
  if (!canReadDoc(ctx, doc)) {
    return new Response("forbidden", { status: 403 });
  }
  // A database session carries presence and run frames only.
  if (doc.doc_type === "database") {
    const dbUrl = new URL("http://actor/connect");
    dbUrl.searchParams.set("dbId", docId);
    dbUrl.searchParams.set("alias", ctx.alias);
    if (ctx.isAgent) dbUrl.searchParams.set("agentAuth", "1");
    return env.databases.get(docId).fetch(dbUrl.toString(), { headers: { upgrade: "websocket" } });
  }
  if (doc.doc_type !== "prose") {
    return new Response("this item has no live document session", { status: 409 });
  }

  const canWrite = canWriteDoc(ctx, doc) && writeCeiling;
  // The actor has no database, so everything it needs to act for this caller
  // (principals, scope, tenant) travels on the URL this function mints.
  const actorUrl = new URL("http://actor/connect");
  actorUrl.searchParams.set("docId", docId);
  actorUrl.searchParams.set("alias", ctx.alias);
  actorUrl.searchParams.set("write", canWrite ? "1" : "0");
  // One param per principal, never a comma-joined list: a group id is free text
  // and could otherwise split into a forged second principal.
  for (const principal of ctx.principals) actorUrl.searchParams.append("principal", principal);
  for (const folderId of scopeFolderIds(ctx) ?? []) actorUrl.searchParams.append("scopeFolder", folderId);
  actorUrl.searchParams.set("workspaceId", ctx.workspaceId);
  // `agentAuth` is asserted from the verified credential and gates the actor's
  // agent rules; `agent` is only a display label a human client may choose.
  if (ctx.isAgent) {
    actorUrl.searchParams.set("agent", ctx.displayName);
    actorUrl.searchParams.set("agentAuth", "1");
  } else if (agent) actorUrl.searchParams.set("agent", agent);
  // The human an agent key acts for, for the actor's audit rows. Attribution only.
  if (ctx.onBehalfOf) actorUrl.searchParams.set("onBehalfOf", ctx.onBehalfOf);

  return env.docs.get(docId).fetch(actorUrl.toString(), {
    headers: { upgrade: "websocket" },
  });
}

/** GET /api/ws/ticket: the ticket a browser opens /ws/:docId with (auth/ws-ticket.ts). */
export async function mintSocketTicket({ ctx, url }: WorkspaceCall): Promise<Response> {
  // An agent socket must carry `agentAuth` from its key; a ticket would open one the actor counts as human.
  if (ctx.isAgent) return error(403, "agents open sockets with their API key");
  const wsDocId = url.searchParams.get("doc");
  if (!wsDocId) return error(400, "doc is required");
  const wsDoc = await getDoc(ctx.sql, wsDocId);
  if (!wsDoc || wsDoc.workspace_id !== ctx.workspaceId) return error(404, "not found");
  if (!canReadDoc(ctx, wsDoc)) return error(403, "forbidden");
  const wsTicket = mintWsTicket(ctx.env.internalSecret, ctx.alias, ctx.workspaceId, wsDocId, canWriteDoc(ctx, wsDoc));
  return json(
    { ticket: wsTicket.value, expires_at: wsTicket.expiresAt, workspace_id: ctx.workspaceId },
    { headers: { "cache-control": "no-store" } },
  );
}
