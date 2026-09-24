/** What agents poll: the workspace event feed, the workspace's instructions, a document's provenance. */
import { getWorkspace, latestWorkspaceEventId, listWorkspaceEvents } from "@stuga/db";
import { WORKSPACE_EVENT_TYPES, isWorkspaceEventType } from "@stuga/protocol/domain/events";
import { databaseDocMessage, readDocProvenance } from "../agents/edits.js";
import { scopeFolderIds } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

export async function listEvents({ ctx, url }: WorkspaceCall): Promise<Response> {
  const p = url.searchParams;
  const afterRaw = p.get("after");
  const after = afterRaw ? Number(afterRaw) : 0;
  if (!Number.isFinite(after) || after < 0) return error(400, "after must be an event id");
  const typesRaw = (p.get("types") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of typesRaw) {
    if (!isWorkspaceEventType(t)) return error(400, `unknown event type ${t}`);
  }
  const limitRaw = Number(p.get("limit") ?? "");
  const events = await listWorkspaceEvents(ctx.sql, {
    workspaceId: ctx.workspaceId,
    principals: ctx.principals,
    after,
    types: typesRaw,
    scopeFolderIds: scopeFolderIds(ctx),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
  });
  // `cursor` is where this page ended; `latest` is where a caller with nothing to catch up on can start.
  const latest = await latestWorkspaceEventId(ctx.sql, ctx.workspaceId);
  return json(
    {
      events: events.map((e) => ({ ...e, id: Number(e.id) })),
      cursor: events.length > 0 ? Number(events[events.length - 1]!.id) : after,
      latest,
      types: WORKSPACE_EVENT_TYPES,
    },
  );
}

export async function getInstructions({ ctx }: WorkspaceCall): Promise<Response> {
  const workspace = await getWorkspace(ctx.sql, ctx.workspaceId);
  return json(
    {
      workspace_id: ctx.workspaceId,
      name: workspace?.name ?? "",
      instructions: workspace?.agent_instructions ?? "",
    },
  );
}

export async function getProvenance({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const out = await readDocProvenance(ctx, docId);
  if (out === null) return error(404, "not found");
  if (out === "database") return error(400, databaseDocMessage(docId));
  return json(out);
}
