/** `/api/node/backups`: the node's backups, the daily schedule they follow, and a backup now. */
import { getNodeState } from "@stuga/db";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";

export async function getNodeBackups({ ctx }: WorkspaceCall): Promise<Response> {
  const backups = ctx.env.backups;
  if (!backups) return error(503, "this node does not take backups of itself");
  const state = await getNodeState(ctx.sql);
  const schedule = backups.schedule();
  const { dir, keep } = backups.where();
  return json({
    auto: schedule.auto,
    hour: schedule.hour,
    time_zone: schedule.timeZone,
    next_at: backups.nextAt()?.toISOString() ?? null,
    running: backups.running(),
    waiting: backups.waiting(),
    // The last scheduled or requested backup that was tried, and why it failed.
    attempted_at: state?.backup_attempted_at ?? null,
    error: state?.backup_error ?? null,
    dir,
    keep,
    backups: (await backups.list()).map((b) => ({
      name: b.name,
      created_at: b.createdAt,
      bytes: b.bytes,
      stuga_version: b.stugaVersion,
      // Taken by a newer version before it upgraded this data.
      before_upgrade: b.runtimeVersion !== b.stugaVersion,
    })),
  });
}

/** Start a backup now. It runs after the answer, so the page that asked sees the node pause and come back. */
export async function startNodeBackup({ ctx }: WorkspaceCall): Promise<Response> {
  const backups = ctx.env.backups;
  if (!backups) return error(503, "this node does not take backups of itself");
  const refused = backups.startNow();
  if (refused) return error(409, refused);
  recordAudit(nodeAuditCtx(ctx), { action: "node.backup.start", targetKind: "node", targetId: ctx.env.publicOrigin, detail: {} });
  return json({ started: true }, { status: 202 });
}
