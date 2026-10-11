/**
 * GET /api/usage: this month's AI token counts by model and by principal and model. Owner or admin only.
 * The four counts are disjoint: what a model read is input plus cache read plus cache write, since a
 * provider with a prompt cache reports most of a long prompt as cached.
 */
import { getMemberRole, usageRollup } from "@stuga/db";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

export async function getUsage({ ctx }: WorkspaceCall): Promise<Response> {
  const usageRole = await getMemberRole(ctx.sql, ctx.workspaceId, ctx.alias);
  if (usageRole !== "owner" && usageRole !== "admin") {
    return error(403, "only a workspace owner or admin can view usage");
  }
  // The current UTC month.
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rollup = await usageRollup(ctx.sql, ctx.workspaceId, since);
  const byModel = rollup.byModel.map((r) => ({
    model: r.model,
    kind: r.kind,
    calls: r.calls,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
  }));
  // One row per principal and model. A principal's rows stay together, heaviest principal first.
  type Counts = { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
  const spent = (r: Counts) => r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
  const perAlias = new Map<string, number>();
  for (const r of rollup.byAlias) perAlias.set(r.alias, (perAlias.get(r.alias) ?? 0) + spent(r));
  const byPrincipal = rollup.byAlias
    .map((r) => ({
      alias: r.alias,
      model: r.model,
      calls: r.calls,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
    }))
    .sort(
      (a, b) =>
        perAlias.get(b.alias)! - perAlias.get(a.alias)! || a.alias.localeCompare(b.alias) || spent(b) - spent(a),
    );
  const totals = byModel.reduce<Counts>(
    (s, r) => ({
      input_tokens: s.input_tokens + r.input_tokens,
      output_tokens: s.output_tokens + r.output_tokens,
      cache_read_tokens: s.cache_read_tokens + r.cache_read_tokens,
      cache_write_tokens: s.cache_write_tokens + r.cache_write_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  );
  return json({
    period: { since: since.toISOString(), label: since.toISOString().slice(0, 7) },
    ai_enabled: ctx.env.aiSettings.current().enabled,
    totals,
    by_model: byModel,
    by_principal: byPrincipal,
  });
}
