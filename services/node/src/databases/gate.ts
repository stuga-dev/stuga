/**
 * The gate to a database actor. The actor trusts the identity it is handed, so
 * it must only be reached through here, after the tenant, ACL and scope checks;
 * the actor owns content correctness.
 */
import { type DocRow, getDoc, touchDoc } from "@stuga/db";
import type { DatabaseActor as DatabaseActorIdentity, DatabaseSchema, TableSchema } from "@stuga/protocol/databases/types";
import type { ActorHandle } from "@stuga/runtime";
import { recordAudit, recordEvent } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canReadDoc } from "../authz/authz.js";
import { error, json } from "../http/respond.js";

/** A readable, untrashed database in the caller's workspace, or null: a prose id reads as absent. */
export async function authorizedDatabase(ctx: Ctx, docId: string): Promise<DocRow | null> {
  const doc = await getDoc(ctx.sql, docId);
  if (!doc || !canReadDoc(ctx, doc)) return null;
  if (doc.doc_type !== "database" || doc.trashed) return null;
  return doc;
}

export function databaseActor(ctx: Ctx, docId: string): ActorHandle {
  return ctx.env.databases.get(docId);
}

function actorOf(ctx: Ctx): DatabaseActorIdentity {
  return { alias: ctx.alias, is_agent: ctx.isAgent, on_behalf_of: ctx.onBehalfOf };
}

/** The node's Activity retention, carried on every mutation: the actor has no settings store. */
function opsKeepOf(ctx: Ctx): number {
  return ctx.env.settings.current().databaseOpsKeep;
}

/**
 * Forward a request to the actor, appending the trusted identity. `asActor`
 * overrides it only for the in-app co-author, which proposes under a
 * server-minted panel identity on the human's behalf.
 */
export async function callDatabaseActor(
  ctx: Ctx,
  docId: string,
  path: string,
  body: Record<string, unknown> | null,
  method = "POST",
  asActor?: DatabaseActorIdentity,
): Promise<Response> {
  const url = `http://actor/${path}${path.includes("?") ? "&" : "?"}dbId=${encodeURIComponent(docId)}`;
  return databaseActor(ctx, docId).fetch(
    url,
    method === "GET"
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, actor: asActor ?? actorOf(ctx), ops_keep: opsKeepOf(ctx) }),
        },
  );
}

/** The in-app co-author's ledger identity for one human: stable, and visibly not the human. */
export function panelActor(ctx: Ctx): DatabaseActorIdentity {
  return { alias: `panel:${ctx.alias}`, is_agent: true, on_behalf_of: ctx.alias };
}

const PASSED_THROUGH = new Set([400, 404, 409, 423, 429]);

/** The status to answer an actor failure with: its deliberate refusals pass through, anything else is a 502. */
export function actorRefusalStatus(res: Response): number {
  return PASSED_THROUGH.has(res.status) ? res.status : 502;
}

/** An actor response as the client's: JSON on success, a refusal with its message, else a 502. */
export async function proxyActor(res: Response, fallback: string): Promise<Response> {
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return body ? json(body) : error(502, fallback);
  }
  const status = actorRefusalStatus(res);
  if (status === 502) return error(502, fallback);
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return error(status, body?.message ?? fallback);
}

/** The schema as this caller sees it: an agent's own pending tables and columns are overlaid. */
export async function projectedSchema(ctx: Ctx, docId: string): Promise<DatabaseSchema | null> {
  const path = ctx.isAgent ? `schema?agent=${encodeURIComponent(ctx.alias)}` : "schema";
  const res = await callDatabaseActor(ctx, docId, path, null, "GET");
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as DatabaseSchema | null;
}

/** The one table `ref` names by id, physical name or display name, or the refusal. */
export function findTable(schema: DatabaseSchema, ref: string): { table: TableSchema } | { status: 400 | 404; error: string } {
  const hits = schema.tables.filter((t) => t.table_id === ref || t.name === ref || t.display === ref);
  if (hits.length === 1) return { table: hits[0]! };
  if (hits.length > 1) {
    return { status: 400, error: `"${ref}" is ambiguous — use a table_id: ${hits.map((t) => `${t.table_id} (${t.display})`).join(", ")}` };
  }
  const tables = schema.tables.map((t) => `${t.name} (${t.table_id})`).join(", ") || "none";
  return { status: 404, error: `no table "${ref}" — tables here: ${tables}` };
}

/** Tell the human their agent changed a database; the notify job collapses a busy session to one per hour. */
async function notifyDatabaseEdit(ctx: Ctx, doc: DocRow, summary: string): Promise<void> {
  if (!ctx.isAgent) return;
  await ctx.env.jobs.send({
    kind: "notify",
    recipient: ctx.onBehalfOf,
    workspaceId: ctx.workspaceId,
    eventType: "DATABASE_AGENT_EDIT",
    docId: doc.doc_id,
    title: `${ctx.displayName || ctx.alias} edited "${doc.title || "Untitled"}"`,
    body: `${summary} You can review and revert from the database's Activity panel.`,
    actor: ctx.alias,
  }).catch(() => {});
}

/** One mutation's bookkeeping: recency, the agent notification, the audit row and the event. */
export async function afterDatabaseMutation(ctx: Ctx, doc: DocRow, summary: string): Promise<void> {
  await touchDoc(ctx.sql, doc.doc_id).catch(() => {});
  await notifyDatabaseEdit(ctx, doc, summary);
  recordAudit(ctx, {
    action: "database.mutate",
    targetKind: "database",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: { summary },
  });
  recordEvent(ctx, "database.changed", doc.doc_id, { title: doc.title, summary });
}
