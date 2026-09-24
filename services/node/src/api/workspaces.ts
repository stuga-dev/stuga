/** `/api/workspaces`: list, create, configure and delete tenants. */
import {
  type WorkspaceRow,
  deleteWorkspaceCascade,
  getMemberRole,
  getWorkspace,
  isWorkspaceOwner,
  listWorkspacesForUser,
  provisionWorkspace,
  updateWorkspaceSettings,
} from "@stuga/db";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import { type DocAccessMode, isDocAccessMode } from "@stuga/protocol/domain/workspaces";
import { recordAudit } from "../audit/record.js";
import { agentInstructionsError, destroyActorStorage } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";

/** The client-facing view of a workspace row: an allowlist, so a new column stays private. */
function workspaceView(row: WorkspaceRow & { role?: WorkspaceRole }) {
  return {
    workspace_id: row.workspace_id,
    name: row.name,
    role: row.role,
    default_doc_access: row.default_doc_access,
    agent_instructions: row.agent_instructions,
    created_at: row.created_at,
  };
}

export async function listWorkspaces({ ctx, req }: AccountCall): Promise<Response> {
  const rows = await listWorkspacesForUser(ctx.sql, ctx.alias);
  const requested = req.headers.get("x-stuga-workspace");
  const active =
    (requested && rows.some((workspace) => workspace.workspace_id === requested) ? requested : null) ??
    rows[0]?.workspace_id ??
    null;
  return json({ workspaces: rows.map(workspaceView), active });
}

export async function createWorkspace({ ctx, req }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; default_doc_access?: unknown };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!name) return error(400, "workspace name is required");
  // Optional: absent leaves the column default to decide.
  if (body.default_doc_access !== undefined && !isDocAccessMode(body.default_doc_access)) {
    return error(400, "default_doc_access must be workspace_edit | workspace_view | private");
  }
  const workspace = await provisionWorkspace(ctx.sql, {
    workspaceId: newId("ws-"),
    name,
    owner: ctx.alias,
    defaultDocAccess: body.default_doc_access,
  });
  return json(workspaceView({ ...workspace, role: "owner" }), { status: 201 });
}

export async function updateWorkspace({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can change settings");
  }
  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    default_doc_access?: unknown;
    agent_instructions?: unknown;
  };
  const patch: { name?: string; defaultDocAccess?: DocAccessMode; agentInstructions?: string } = {};
  const instructionsError = agentInstructionsError(body.agent_instructions);
  if (instructionsError) return instructionsError;
  if (typeof body.agent_instructions === "string") patch.agentInstructions = body.agent_instructions;
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return error(400, "name must be text");
    const name = body.name.trim().slice(0, 100);
    if (!name) return error(400, "name cannot be empty");
    patch.name = name;
  }
  if (body.default_doc_access !== undefined) {
    if (!isDocAccessMode(body.default_doc_access)) {
      return error(400, "default_doc_access must be workspace_edit | workspace_view | private");
    }
    patch.defaultDocAccess = body.default_doc_access;
  }
  // Read first, for the ledger's size of the text it replaces.
  const before = patch.agentInstructions !== undefined ? await getWorkspace(ctx.sql, wsId) : null;
  const ws = await updateWorkspaceSettings(ctx.sql, wsId, patch);
  if (!ws) return error(404, "workspace not found");
  // Sizes only, never the text; filed in the ledger of the workspace changed, which the header need not name.
  if (patch.agentInstructions !== undefined && before && patch.agentInstructions !== before.agent_instructions) {
    recordAudit(
      { ...ctx, workspaceId: wsId },
      {
        action: "workspace.agent_instructions",
        targetKind: "workspace",
        targetId: wsId,
        targetLabel: ws.name,
        detail: { chars: patch.agentInstructions.length, from_chars: before.agent_instructions.length },
      },
    );
  }
  // The row carries no membership, so `role` is left undefined for the client to keep.
  return json(workspaceView(ws));
}

// Delete a workspace and everything in it. Owner only, and the body must echo its name.
export async function deleteWorkspace({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  if (!(await isWorkspaceOwner(ctx.sql, wsId, ctx.alias))) {
    return error(403, "only a workspace owner can delete a workspace");
  }
  const ws = await getWorkspace(ctx.sql, wsId);
  if (!ws) return error(404, "workspace not found");
  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if ((body.confirm ?? "") !== ws.name) {
    return error(400, "type the workspace name in `confirm` to delete it");
  }
  const result = await deleteWorkspaceCascade(ctx.sql, wsId);
  if (!result) return error(404, "workspace not found");
  // Snapshots, actor storage and media outlive the rows. Swept after the commit,
  // best-effort, so a failure never turns a completed deletion into an error.
  // Snapshots only once the actor is destroyed: until then a flush can write one behind the sweep.
  for (const { doc_id, doc_type } of result.docs) {
    await destroyActorStorage(ctx.env, doc_id, doc_type);
    await ctx.env.jobs.send({ kind: "gc_check", docId: doc_id }).catch(() => {});
  }

  // Media keys are `media/<workspaceId>/<hash>`, so the prefix is this tenant's alone.
  try {
    let cursor: string | undefined;
    do {
      const page = await ctx.env.media.list({ prefix: `media/${wsId}/`, cursor });
      if (page.objects.length > 0) await ctx.env.media.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch {
    // `stuga-node media-scan` finds the leftovers unreferenced.
  }

  return json({ deleted: true, docs: result.docs.length });
}
