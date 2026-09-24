/** The snapshot sweep of a deleted document: queued before its row is deleted, run once its actor is gone. */
import type { Sql } from "@stuga/db";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { JobDeps, JobsEnv } from "./deps.js";

/**
 * How long a queued sweep waits. It has to run after the actor destroy that
 * follows the row delete: until then a flush can write a snapshot behind it,
 * and the destroy waits for whatever the actor is running, an AI turn included.
 */
export const SNAPSHOT_SWEEP_DELAY_SECONDS = 60 * 60;

/**
 * Queue the sweep for a document about to be deleted. Queued before the delete,
 * so a failure here stops the delete instead of leaving snapshots nothing sweeps.
 */
export async function queueSnapshotSweep(sql: Sql, docId: string): Promise<void> {
  const sweep = { kind: "gc_check", docId } satisfies IndexMessage;
  await sql`
    INSERT INTO jobs (body, available_at)
    VALUES (${sql.json(sweep)}, now() + make_interval(secs => ${SNAPSHOT_SWEEP_DELAY_SECONDS}))`;
}

/** Delete every snapshot under a deleted document's prefix, page by page. */
export async function handleGcCheck(env: JobsEnv, d: JobDeps, msg: Extract<IndexMessage, { kind: "gc_check" }>): Promise<void> {
  // The sweep is queued before the delete, so a document still here is one whose delete failed.
  if (await d.db.getDoc(msg.docId)) return;
  let cursor: string | undefined;
  do {
    const page = await env.snapshots.list(cursor === undefined ? { prefix: `${msg.docId}/` } : { prefix: `${msg.docId}/`, cursor });
    if (page.objects.length > 0) await env.snapshots.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
