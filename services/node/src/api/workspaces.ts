/** `/api/workspaces`: list, create (empty, from an archive or from a sample), configure and delete tenants. */
import {
  type WorkspaceRow,
  deleteWorkspaceCascade,
  finishWorkspaceImport,
  getMemberRole,
  getWorkspace,
  isWorkspaceOwner,
  listUnfinishedImports,
  listWorkspacesForUser,
  provisionWorkspace,
  updateWorkspaceSettings,
} from "@stuga/db";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import { ARCHIVE_WORK_MAX_MS, type DocAccessMode, isDocAccessMode } from "@stuga/protocol/domain/workspaces";
import { ArchiveError } from "../archive/format.js";
import { type ArchiveContents, type ImportResult, ImportStepError, importWorkspaceArchive, readArchive } from "../archive/import.js";
import { SampleDownloadError, sampleCatalog, sampleStepReplay } from "../archive/samples.js";
import { archiveWorkBegins, archiveWorkHeld } from "../archive/under-way.js";
import { recordAudit } from "../audit/record.js";
import type { AccountCtx } from "../auth/context.js";
import { agentInstructionsError, destroyActorStorage } from "../documents/access.js";
import type { NodeEnv } from "../env.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";
import { imageUploadLimits } from "../media/media.js";

const DOC_ACCESS_MESSAGE = "default_doc_access must be workspace_edit | workspace_view | private";

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
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; default_doc_access?: unknown; sample?: unknown };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (body.sample !== undefined) return workspaceFromSample(ctx, body.sample, name, body.default_doc_access);
  if (!name) return error(400, "workspace name is required");
  // Optional: absent leaves the column default to decide.
  if (body.default_doc_access !== undefined && !isDocAccessMode(body.default_doc_access)) {
    return error(400, DOC_ACCESS_MESSAGE);
  }
  const workspace = await provisionWorkspace(ctx.sql, {
    workspaceId: newId("ws-"),
    name,
    owner: ctx.alias,
    defaultDocAccess: body.default_doc_access,
  });
  return json(workspaceView({ ...workspace, role: "owner" }), { status: 201 });
}

/**
 * The people importing an archive now, uploaded or a sample's. Each import holds its archive until
 * it is done, so a person runs one at a time and the node IMPORTS_AT_ONCE.
 */
const importing = new Set<string>();
const IMPORTS_AT_ONCE = 3;

/**
 * `work`'s answer, as `alias`'s one import under way; 409 while they have one, the node has as many
 * as it runs, or a backup waits for the ones under way.
 */
async function asImport(alias: string, work: () => Promise<Response>): Promise<Response> {
  if (importing.has(alias)) return error(409, "you are already importing a workspace; try again when it is done");
  if (importing.size >= IMPORTS_AT_ONCE) return error(409, "other workspaces are being imported on this node; try again when one is done");
  const held = archiveWorkHeld();
  if (held) return error(409, held);
  importing.add(alias);
  const ended = archiveWorkBegins();
  try {
    return await work();
  } finally {
    importing.delete(alias);
    ended();
  }
}

/** The samples published where SAMPLES_URL points, in the index's order. */
export async function listWorkspaceSamples({ ctx }: AccountCall): Promise<Response> {
  const catalog = sampleCatalog(ctx.env.samplesUrl);
  const index = await catalog.index();
  // A copy kept past a failed look would offer samples the node cannot download now.
  if (!index || catalog.lastLookFailed()) return json({ samples: [], unavailable: true });
  return json({ samples: index.samples.map(({ id, title, description, name, langs }) => ({ id, title, description, name, langs })) });
}

/**
 * A new workspace from a published sample: its archive downloaded and checked against the index,
 * imported, and its steps proposed by Sample agent for the caller to review. `name` defaults to
 * the sample's.
 */
async function workspaceFromSample(ctx: AccountCtx, sample: unknown, name: string, access: unknown): Promise<Response> {
  if (typeof sample !== "string") return error(400, "sample must be a sample's id");
  if (access !== undefined && !isDocAccessMode(access)) return error(400, DOC_ACCESS_MESSAGE);
  const catalog = sampleCatalog(ctx.env.samplesUrl);
  const index = await catalog.index();
  if (!index) return error(502, "could not download the sample");
  const entry = index.samples.find((s) => s.id === sample);
  if (!entry) return error(400, `there is no sample "${sample}"`);
  return asImport(ctx.alias, async () => {
    let contents: ArchiveContents;
    try {
      const bytes = await catalog.download(index, entry);
      contents = await readArchive(bytes, { maxImageBytes: imageUploadLimits(ctx.env.settings.current().maxBodyBytes).bytes });
    } catch (err) {
      if (!(err instanceof SampleDownloadError) && !(err instanceof ArchiveError)) throw err;
      console.error("could not download a sample", { requestId: ctx.requestId ?? null, sample: entry.id, tag: index.tag, error: err.message });
      return error(502, "could not download the sample");
    }
    return workspaceFromArchive(ctx, contents, { name: name || entry.name, access, sample: entry.id });
  });
}

/**
 * A new workspace from a workspace archive, the zip as the body. The archive
 * is read and checked whole before the workspace exists. `name` defaults to
 * the archive's.
 */
export async function importWorkspace({ ctx, req, url }: AccountCall): Promise<Response> {
  const name = (url.searchParams.get("name") ?? "").trim().slice(0, 100);
  const access = url.searchParams.get("default_doc_access") ?? undefined;
  if (access !== undefined && !isDocAccessMode(access)) return error(400, DOC_ACCESS_MESSAGE);
  return asImport(ctx.alias, async () => {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) return error(400, "send the archive as the request body");
    let contents: ArchiveContents;
    try {
      contents = await readArchive(bytes, { maxImageBytes: imageUploadLimits(ctx.env.settings.current().maxBodyBytes).bytes });
    } catch (err) {
      if (err instanceof ArchiveError) return error(400, `cannot import this archive: ${err.message}`);
      throw err;
    }
    return workspaceFromArchive(ctx, contents, { name: name || contents.manifest.workspace.name, access });
  });
}

/**
 * Provision a workspace owned by the caller and import `contents` into it, as
 * they would write it; a sample's steps follow, as Sample agent. Until the
 * import is done the workspace is marked, so no list shows it. A write that
 * fails, or an import still writing after ARCHIVE_WORK_MAX_MS, deletes the
 * workspace again, and a node stopped partway deletes it when it starts
 * (purgeUnfinishedImports). An import goes on when its client goes away, since a
 * proxy that gave up on the request leaves the person to find the workspace once
 * it is done. Answers as a create does, with the document to open first when the
 * archive names one.
 */
async function workspaceFromArchive(
  ctx: AccountCtx,
  contents: ArchiveContents,
  input: { name: string; access?: DocAccessMode; sample?: string },
): Promise<Response> {
  const workspace = await provisionWorkspace(ctx.sql, {
    workspaceId: newId("ws-"),
    name: input.name,
    owner: ctx.alias,
    defaultDocAccess: input.access,
    importing: true,
  });
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), ARCHIVE_WORK_MAX_MS);
  let imported: ImportResult;
  try {
    const { signal } = limit;
    // Only an archive the node fetched and checked against the samples index is trusted with steps.
    const opts = input.sample
      ? { trusted: true, sampleSteps: sampleStepReplay(ctx, workspace.workspace_id, contents.index, { signal }), signal }
      : { signal };
    imported = await importWorkspaceArchive(ctx, workspace.workspace_id, contents, opts);
    await finishWorkspaceImport(ctx.sql, workspace.workspace_id);
  } catch (err) {
    console.error("workspace import failed", {
      requestId: ctx.requestId ?? null,
      workspaceId: workspace.workspace_id,
      step: err instanceof ImportStepError ? err.step : null,
      error: err instanceof Error ? err.message : String(err),
    });
    await purgeWorkspace(ctx.env, workspace.workspace_id).catch((purgeErr: unknown) =>
      console.error("could not delete the workspace a failed import left", {
        workspaceId: workspace.workspace_id,
        error: purgeErr instanceof Error ? purgeErr.message : String(purgeErr),
      }),
    );
    if (limit.signal.aborted) return error(500, `the import did not finish within ${ARCHIVE_WORK_MAX_MS / 60_000} minutes, so the workspace was not created`);
    return error(500, "the archive could not be imported, so the workspace was not created");
  } finally {
    clearTimeout(timer);
  }
  recordAudit(
    { ...ctx, workspaceId: workspace.workspace_id },
    {
      action: "workspace.import",
      targetKind: "workspace",
      targetId: workspace.workspace_id,
      targetLabel: workspace.name,
      detail: { ...imported.counts, ...(input.sample ? { sample: input.sample } : {}) },
    },
  );
  // Read again: the import gave it the archive's agent instructions.
  const current = (await getWorkspace(ctx.sql, workspace.workspace_id)) ?? workspace;
  return json(
    { ...workspaceView({ ...current, role: "owner" }), ...(imported.startDocId ? { start_doc_id: imported.startDocId } : {}) },
    { status: 201 },
  );
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
      return error(400, DOC_ACCESS_MESSAGE);
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
  const result = await purgeWorkspace(ctx.env, wsId);
  if (!result) return error(404, "workspace not found");
  return json({ deleted: true, docs: result.docs });
}

/**
 * Delete a workspace's rows, then what outlives them: each document's actor
 * storage and snapshots, and its media. The number of documents it held, or
 * null when there is no such workspace.
 */
export async function purgeWorkspace(env: NodeEnv, wsId: string): Promise<{ docs: number } | null> {
  const result = await deleteWorkspaceCascade(env.sql, wsId);
  if (!result) return null;
  // Snapshots, actor storage and media outlive the rows. Swept after the commit,
  // best-effort, so a failure never turns a completed deletion into an error.
  // Snapshots only once the actor is destroyed: until then a flush can write one behind the sweep.
  for (const { doc_id, doc_type } of result.docs) {
    await destroyActorStorage(env, doc_id, doc_type);
    await env.jobs.send({ kind: "gc_check", docId: doc_id }).catch(() => {});
  }

  // Media keys are `media/<workspaceId>/<hash>`, so the prefix is this tenant's alone.
  try {
    let cursor: string | undefined;
    do {
      const page = await env.media.list({ prefix: `media/${wsId}/`, cursor });
      if (page.objects.length > 0) await env.media.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch {
    // `stuga-node media-scan` finds the leftovers unreferenced.
  }
  return { docs: result.docs.length };
}

/**
 * Delete each workspace an import was still writing when the node last stopped, and log it. Run
 * at boot before the node serves, so no import of this run is taken for one.
 */
export async function purgeUnfinishedImports(env: NodeEnv): Promise<void> {
  for (const ws of await listUnfinishedImports(env.sql)) {
    const started = new Date(ws.import_started_at!).toISOString();
    console.info(`[node] deleting workspace ${ws.workspace_id} ("${ws.name}"): its import, started ${started}, stopped when the node did`);
    await purgeWorkspace(env, ws.workspace_id).catch((err: unknown) =>
      console.error("[node] could not delete the workspace an unfinished import left", {
        workspaceId: ws.workspace_id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
