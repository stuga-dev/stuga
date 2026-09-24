import { SCHEMA_VERSION, getNodeState } from "@stuga/db";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import type { Ctx } from "../../auth/context.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { jobDeps } from "../../jobs/deps.js";
import { lookNow, updateStatus } from "../../updates/check.js";
import { readInstallStatus, requestInstall } from "../../updates/install.js";
import { RELEASES_PAGE, sourceUrl } from "../../updates/feed.js";
import { BUILD, RELEASED_AT, VERSION } from "../../version.js";

// Which build runs against which schema, and what the node knows about newer ones.
// Admin-gated: a version names software to look up vulnerabilities for.
async function versionResponse(ctx: Ctx): Promise<Response> {
  const state = await getNodeState(ctx.sql);
  const status = updateStatus(VERSION, state);
  return json({
    version: VERSION,
    build: BUILD,
    released_at: RELEASED_AT,
    // The code this build was made from, for anyone who wants to read or change what they run.
    source_url: sourceUrl(VERSION, BUILD),
    schema_version: SCHEMA_VERSION,
    previous_version: ctx.env.previousVersion,
    first_boot_at: state?.first_boot_at ?? null,
    last_boot_at: state?.last_boot_at ?? null,
    update: {
      // False for a build from source, which has no release to compare with and never looks.
      comparable: status.comparable,
      checked_at: status.checkedAt,
      error: status.error,
      available: status.pending && {
        version: status.pending.version,
        released_at: status.pending.date,
        // Whether a release after this one fixes a vulnerability, the newest or an earlier one.
        security: status.pending.securityVersion !== null,
        notes_url: status.pending.notesUrl,
      },
      // Where every release is listed: what an administrator opens when the node itself cannot look.
      releases_url: RELEASES_PAGE,
      // How this packaging moves to a newer version.
      upgrade_hint: ctx.env.upgradeHint,
      // Where the packaging can install a newer release on request (the Mac package), and how the last one went.
      install: {
        available: ctx.env.upgradeHelper !== undefined,
        status: ctx.env.upgradeHelper ? await readInstallStatus(ctx.env.upgradeHelper) : null,
      },
    },
  });
}

/**
 * Ask the machine to install the newest release the node knows of. Only where the packaging has a
 * helper that installs a release it can verify; the node itself never installs anything. The new
 * version backs up the database before it changes it.
 */
export async function installNodeVersion({ ctx, req }: WorkspaceCall): Promise<Response> {
  const helper = ctx.env.upgradeHelper;
  if (!helper) return error(409, "this node's packaging does not install upgrades from here; " + ctx.env.upgradeHint);
  const body = (await req.json().catch(() => null)) as { version?: unknown } | null;
  const pending = updateStatus(VERSION, await getNodeState(ctx.sql)).pending;
  if (!pending) return error(409, "the node knows of no newer version to install");
  if (body?.version !== pending.version) return error(409, `the newest version the node knows of is ${pending.version}`);
  await requestInstall(helper, pending.version);
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.upgrade.request",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: { from: VERSION, to: pending.version },
  });
  const res = await versionResponse(ctx);
  return new Response(res.body, { status: 202, headers: res.headers });
}

export async function getNodeVersion({ ctx }: WorkspaceCall): Promise<Response> {
  return versionResponse(ctx);
}

/**
 * Look for a newer version now. Answers like the GET whether or not it looked: a look within the
 * last minute, the switch being off, or a build from source leave what is known as it was.
 */
export async function checkNodeVersion({ ctx }: WorkspaceCall): Promise<Response> {
  await lookNow(ctx.env, jobDeps(ctx.env, {}), VERSION);
  return versionResponse(ctx);
}
