/**
 * `/api/node/remote-access`: the node's remote address (docs/remote-access.md), shown, turned on
 * with a code from the remote-access service, and turned off; and the connector the packaging
 * refused, asked for again. Where the packaging offers no remote access the GET says so and the
 * rest refuse.
 */
import type { RemoteAccessEnableError } from "@stuga/protocol/api/remote-access";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import { json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { RemoteAccessRefusal } from "../../remote/service.js";

const refuse = (status: number, body: RemoteAccessEnableError): Response => json(body, { status });

const unavailable = () => refuse(409, { error: "Remote access isn't set up in this node's packaging.", code: "unavailable" });

export async function getRemoteAccessRoute({ ctx }: WorkspaceCall): Promise<Response> {
  const remote = ctx.env.remoteAccess;
  if (!remote) return json({ available: false });
  return json(await remote.status());
}

export async function enableRemoteAccessRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const remote = ctx.env.remoteAccess;
  if (!remote) return unavailable();
  const body = (await req.json().catch(() => null)) as { code?: unknown; accept_ca_terms?: unknown } | null;
  if (body?.accept_ca_terms !== true) {
    return refuse(400, { error: "accept the certificate authority's subscriber agreement to turn this on" });
  }
  if (body.code !== undefined && body.code !== null && typeof body.code !== "string") {
    return refuse(400, { error: "code must be a string" });
  }
  const code = typeof body.code === "string" && body.code.trim() ? body.code : undefined;
  let result;
  try {
    result = await remote.enable({ ...(code ? { code } : {}), acceptCaTerms: true, by: ctx.alias });
  } catch (e) {
    if (!(e instanceof RemoteAccessRefusal)) throw e;
    return refuse(e.status, { error: e.message, ...(e.code ? { code: e.code as RemoteAccessEnableError["code"] } : {}) });
  }
  const bound = remote.view.current();
  // The code itself is a credential, and stays out of the ledger.
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.remote_access.enable",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: {
      id: bound.id,
      hostname: bound.hostname,
      via: result.via,
      ca_terms_accepted_at: result.status.available ? (result.status.ca_terms?.accepted_at ?? null) : null,
    },
  });
  return json(result.status);
}

export async function disableRemoteAccessRoute({ ctx }: WorkspaceCall): Promise<Response> {
  const remote = ctx.env.remoteAccess;
  if (!remote) return unavailable();
  const status = await remote.disable(ctx.alias);
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.remote_access.disable",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { id: remote.view.current().id },
  });
  return json(status);
}

export async function retryRemoteConnectorRoute({ ctx }: WorkspaceCall): Promise<Response> {
  const remote = ctx.env.remoteAccess;
  if (!remote) return unavailable();
  let status;
  try {
    status = await remote.retryConnector(ctx.alias);
  } catch (e) {
    if (!(e instanceof RemoteAccessRefusal)) throw e;
    return refuse(e.status, { error: e.message, ...(e.code ? { code: e.code as RemoteAccessEnableError["code"] } : {}) });
  }
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.remote_access.connector_retry",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { id: remote.view.current().id },
  });
  return json(status);
}
