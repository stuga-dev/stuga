/**
 * Looking for a newer version: one GET of the release list a day, its result kept in node_state,
 * and a notification to the node's administrators when a release that fixes a vulnerability is
 * waiting. The request says nothing about this node, and the comparison happens here.
 */
import type { NodeStateRow } from "@stuga/db";
import type { NotifyDeliverMessage } from "@stuga/protocol/internal/jobs";
import type { JobDeps, JobsEnv } from "../jobs/deps.js";
import { RELEASES_URL, type PendingUpdate, type Release, isReleaseVersion, parseFeed, pendingUpdate, storedReleases } from "./feed.js";

/** "Once a day" is what the Settings page promises, so a failed look waits as long as a good one. */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** Between two looks an administrator asks for. */
const MANUAL_CHECK_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Years of weekly releases fit many times over. */
const MAX_FEED_BYTES = 1024 * 1024;

/** Where the notification opens: the page that names the version and says how to upgrade. */
const ABOUT_PATH = "/settings/node/about";

export const SECURITY_UPDATE_EVENT = "SECURITY_UPDATE_AVAILABLE";

type FetchOutcome = { releases: Release[]; feed: unknown } | { error: string };

/** The release list, or why it could not be had, in words an administrator can act on. */
export async function fetchReleases(fetchFn: typeof globalThis.fetch): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetchFn(RELEASES_URL, {
      // No version and no node id: whoever serves the file learns an address asked, and nothing more.
      headers: { accept: "application/json", "user-agent": "stuga-node" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { error: timedOut ? "github.com did not answer in time" : "could not reach github.com" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { error: `github.com answered ${res.status}` };
  }
  try {
    const text = await readCapped(res, MAX_FEED_BYTES);
    const feed: unknown = JSON.parse(text);
    return { releases: parseFeed(feed), feed };
  } catch {
    return { error: "the release list could not be read" };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** What the node knows about newer versions, as the About page shows it. */
export interface UpdateStatus {
  /** Whether this build can be compared with a release at all: false for one built from source. */
  comparable: boolean;
  /** The last look, successful or not; null before the first. */
  checkedAt: Date | null;
  /** Why the last look failed; null when it succeeded or none was made. */
  error: string | null;
  /** The release to move to; null when the node is current, or has never learned otherwise. */
  pending: PendingUpdate | null;
}

export function updateStatus(version: string, state: NodeStateRow | null): UpdateStatus {
  return {
    comparable: isReleaseVersion(version),
    checkedAt: state?.update_checked_at ?? null,
    error: state?.update_check_error ?? null,
    pending: pendingUpdate(version, storedReleases(state?.update_feed)),
  };
}

/**
 * Look now, record what came back, and tell the administrators about a waiting security release.
 * A notification's id names the release and the person, so each hears of each release once,
 * however many looks find it.
 */
export async function checkForUpdates(env: JobsEnv, d: JobDeps, version: string): Promise<void> {
  const outcome = await fetchReleases(d.fetch);
  if ("error" in outcome) {
    await d.db.recordUpdateCheck({ error: outcome.error });
    d.log.warn("could not look for a newer version", { reason: outcome.error });
    return;
  }
  await d.db.recordUpdateCheck({ feed: outcome.feed });
  const pending = pendingUpdate(version, outcome.releases);
  if (!pending?.securityVersion) return;

  const title = `Security update available: Stuga ${pending.version}`;
  const body = `This node runs ${version}. Stuga ${pending.securityVersion} fixes a security issue.`;
  const url = `${env.publicOrigin}${ABOUT_PATH}`;
  for (const admin of await d.db.listNodeAdmins()) {
    const delivery: NotifyDeliverMessage | null =
      env.settings.current().notify.sink === "none"
        ? null
        : { kind: "notify_deliver", recipient: admin.alias, title, body, url };
    await d.db.insertNotification(
      {
        id: `${SECURITY_UPDATE_EVENT}:${pending.securityVersion}:${admin.alias}`,
        workspace_id: null,
        recipient_alias: admin.alias,
        event_type: SECURITY_UPDATE_EVENT,
        resource_id: null,
        resource_title: title,
        resource_url: url,
        actor_alias: null,
        payload: { running: version, latest: pending.version, security_version: pending.securityVersion },
      },
      delivery,
    );
  }
}

/**
 * The maintenance tick's stage. It looks only when the node has been claimed, so whoever set it up
 * has seen the switch, and the switch is read from the row itself once a look is due: the snapshot
 * in memory may be a tick behind a setup that turned it off.
 */
export async function lookForUpdates(env: JobsEnv, d: JobDeps, version: string, now = Date.now()): Promise<void> {
  if (!isReleaseVersion(version)) return;
  if (!env.settings.current().updateCheck) return;
  const state = await d.db.nodeState();
  if (state?.update_checked_at && now - state.update_checked_at.getTime() < CHECK_INTERVAL_MS) return;
  if ((await d.db.nodeSettingsRow())?.update_check === false) return;
  if ((await d.db.countAccounts()) === 0) return;
  await checkForUpdates(env, d, version);
}

/** An administrator asking for a look now. False when one was made within the last minute, or the switch is off. */
export async function lookNow(env: JobsEnv, d: JobDeps, version: string, now = Date.now()): Promise<boolean> {
  if (!isReleaseVersion(version)) return false;
  if ((await d.db.nodeSettingsRow())?.update_check === false) return false;
  const state = await d.db.nodeState();
  if (state?.update_checked_at && now - state.update_checked_at.getTime() < MANUAL_CHECK_INTERVAL_MS) return false;
  await checkForUpdates(env, d, version);
  return true;
}
