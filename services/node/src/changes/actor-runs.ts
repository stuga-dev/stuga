/**
 * A run as its actor holds it, with every item's status. A document's run summary leaves its hunks
 * out past a size (`hunks_truncated`), so whatever decides something from them (what still waits,
 * what landed) reads the run in full; a database's summary always lists every op, payloads aside.
 */
import type { DocRow } from "@stuga/db";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { Ctx } from "../auth/context.js";

export type AnyRun = AgentRunSummary | DatabaseRunSummary;

/** The run with every item, or null when it is gone or cannot be read now. */
export async function completeRun(ctx: Pick<Ctx, "env">, doc: Pick<DocRow, "doc_id" | "doc_type">, runId: string): Promise<AnyRun | null> {
  if (doc.doc_type === "database") {
    const res = await ctx.env.databases.get(doc.doc_id).fetch(`http://actor/runs/detail?${new URLSearchParams({ dbId: doc.doc_id, runId })}`);
    if (!res.ok) return null;
    return ((await res.json().catch(() => null)) as { run?: DatabaseRunSummary } | null)?.run ?? null;
  }
  const res = await ctx.env.docs.get(doc.doc_id).fetch(`http://actor/runs/detail?${new URLSearchParams({ docId: doc.doc_id, runId, full: "1" })}`);
  if (!res.ok) return null;
  const detail = (await res.json().catch(() => null)) as { run?: AgentRunSummary; hunks?: AgentRunHunk[] } | null;
  if (!detail?.run) return null;
  if (!Array.isArray(detail.hunks)) return detail.run;
  const { hunks_truncated: _truncated, ...run } = detail.run;
  return { ...run, hunks: detail.hunks };
}

/** The run's items, or null when they were left out and their statuses are not known. */
export function itemsOf(run: AnyRun): ReadonlyArray<{ status: string }> | null {
  if ("hunks" in run) return run.hunks_truncated ? null : run.hunks;
  return run.ops;
}
