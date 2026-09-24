import { describe, expect, it, vi } from "vitest";
import type { NodeSettingsRow, NodeStateRow } from "@stuga/db";
import type { JobDeps, JobsEnv } from "../jobs/deps.js";
import { SECURITY_UPDATE_EVENT, checkForUpdates, fetchReleases, lookForUpdates, lookNow, updateStatus } from "./check.js";
import { RELEASES_URL } from "./feed.js";

const NOW = Date.parse("2026-12-02T12:00:00Z");
const HOUR = 60 * 60_000;

const FEED = {
  format: 1,
  releases: [
    { version: "1.10.0", date: "2026-12-01", security: false },
    { version: "1.9.1", date: "2026-11-10", security: true },
    { version: "1.9.0", date: "2026-11-03", security: false },
  ],
};

function feedResponse(body: unknown = FEED, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function state(overrides: Partial<NodeStateRow> = {}): NodeStateRow {
  return {
    node_id: "abcdefghijklmnop",
    app_version: "1.9.0",
    first_boot_at: new Date(NOW - 30 * 24 * HOUR),
    last_boot_at: new Date(NOW - HOUR),
    update_checked_at: null,
    update_feed: null,
    update_check_error: null,
    backup_attempted_at: null,
    backup_error: null,
    ...overrides,
  };
}

interface World {
  env: JobsEnv;
  d: JobDeps;
  fetch: ReturnType<typeof vi.fn>;
  recorded: Array<{ feed: unknown } | { error: string }>;
  notifications: Array<{ row: Record<string, unknown>; delivery: unknown }>;
}

/** A claimed node with the switch on, one administrator, no sink, and a look that is due. */
function world(
  opts: {
    snapshotCheck?: boolean;
    rowCheck?: boolean | null;
    accounts?: number;
    state?: NodeStateRow | null;
    sink?: "none" | "slack";
    admins?: string[];
    response?: () => Promise<Response>;
  } = {},
): World {
  const recorded: World["recorded"] = [];
  const notifications: World["notifications"] = [];
  const seen = new Set<string>();
  const fetch = vi.fn(opts.response ?? (async () => feedResponse()));
  const env = {
    publicOrigin: "https://node.test",
    settings: { current: () => ({ updateCheck: opts.snapshotCheck ?? true, notify: { sink: opts.sink ?? "none" } }) },
  } as unknown as JobsEnv;
  const db = {
    nodeState: async () => (opts.state === undefined ? state() : opts.state),
    nodeSettingsRow: async () => ({ update_check: opts.rowCheck ?? null }) as NodeSettingsRow,
    countAccounts: async () => opts.accounts ?? 1,
    listNodeAdmins: async () => (opts.admins ?? ["ada"]).map((alias) => ({ alias })),
    recordUpdateCheck: async (result: { feed: unknown } | { error: string }) => void recorded.push(result),
    insertNotification: async (row: { id: string }, delivery: unknown) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      notifications.push({ row, delivery });
      return true;
    },
  };
  const d = { db, fetch, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as JobDeps;
  return { env, d, fetch, recorded, notifications };
}

describe("fetchReleases", () => {
  it("asks for the one file and says nothing about the node that asks", async () => {
    const fetch = vi.fn(async () => feedResponse());
    const outcome = await fetchReleases(fetch as unknown as typeof globalThis.fetch);
    expect(outcome).toMatchObject({ releases: FEED.releases, feed: FEED });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RELEASES_URL);
    expect(new URL(url).search).toBe("");
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ accept: "application/json", "user-agent": "stuga-node" });
  });

  it("says why it could not, in words an administrator can act on", async () => {
    const failing = (fn: () => Promise<Response>) => fetchReleases(vi.fn(fn) as unknown as typeof globalThis.fetch);

    expect(await failing(async () => feedResponse("not found", 404))).toEqual({ error: "github.com answered 404" });
    expect(
      await failing(async () => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ error: "could not reach github.com" });
    expect(
      await failing(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    ).toEqual({ error: "github.com did not answer in time" });
    expect(await failing(async () => feedResponse("<html>a captive portal</html>"))).toEqual({
      error: "the release list could not be read",
    });
    expect(await failing(async () => feedResponse({ releases: "none" }))).toEqual({
      error: "the release list could not be read",
    });
    expect(await failing(async () => feedResponse(`{"releases":[],"pad":"${"x".repeat(1024 * 1024)}"}`))).toEqual({
      error: "the release list could not be read",
    });
  });
});

describe("lookForUpdates", () => {
  it("looks when a day has passed, and records what it found", async () => {
    const w = world({ state: state({ update_checked_at: new Date(NOW - 25 * HOUR) }) });
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(w.recorded).toEqual([{ feed: FEED }]);
  });

  it("looks the first time on a node that has never looked", async () => {
    const w = world();
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not look twice in a day, and a look that failed counts", async () => {
    const w = world({ state: state({ update_checked_at: new Date(NOW - 23 * HOUR), update_check_error: "could not reach github.com" }) });
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("never looks from a build that is not a release", async () => {
    for (const version of ["0.0.0-dev", "0.0.0-ci"]) {
      const w = world();
      await lookForUpdates(w.env, w.d, version, NOW);
      expect(w.fetch).not.toHaveBeenCalled();
    }
  });

  it("never looks while the switch is off", async () => {
    const w = world({ snapshotCheck: false, rowCheck: false });
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("believes the row over a snapshot that has not caught up with a setup that turned the switch off", async () => {
    const w = world({ snapshotCheck: true, rowCheck: false });
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("never looks before someone has set the node up and seen the switch", async () => {
    const w = world({ accounts: 0 });
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.recorded).toEqual([]);
  });

  it("records a failed look, tells nobody, and leaves the next one to tomorrow", async () => {
    const w = world({ response: async () => feedResponse("gone", 404) });
    await lookForUpdates(w.env, w.d, "1.9.0", NOW);
    expect(w.recorded).toEqual([{ error: "github.com answered 404" }]);
    expect(w.notifications).toEqual([]);
  });
});

describe("checkForUpdates", () => {
  it("tells every administrator about a waiting security release, once each", async () => {
    const w = world({ admins: ["ada", "grace"] });
    await checkForUpdates(w.env, w.d, "1.9.0");
    await checkForUpdates(w.env, w.d, "1.9.0");

    expect(w.notifications.map((n) => n.row.id)).toEqual([
      `${SECURITY_UPDATE_EVENT}:1.9.1:ada`,
      `${SECURITY_UPDATE_EVENT}:1.9.1:grace`,
    ]);
    expect(w.notifications[0]?.row).toMatchObject({
      // About the node, so of no workspace and no document: the tray opens the stored URL.
      workspace_id: null,
      resource_id: null,
      recipient_alias: "ada",
      event_type: SECURITY_UPDATE_EVENT,
      resource_title: "Security update available: Stuga 1.10.0",
      resource_url: "https://node.test/settings/node/about",
      payload: { running: "1.9.0", latest: "1.10.0", security_version: "1.9.1" },
    });
    expect(w.notifications[0]?.delivery).toBeNull();
  });

  it("sends it to the sink too when the node has one", async () => {
    const w = world({ sink: "slack" });
    await checkForUpdates(w.env, w.d, "1.9.0");
    expect(w.notifications[0]?.delivery).toEqual({
      kind: "notify_deliver",
      recipient: "ada",
      title: "Security update available: Stuga 1.10.0",
      body: "This node runs 1.9.0. Stuga 1.9.1 fixes a security issue.",
      url: "https://node.test/settings/node/about",
    });
  });

  it("tells nobody about an ordinary release, or a security release the node already has", async () => {
    const w = world();
    await checkForUpdates(w.env, w.d, "1.9.1");
    expect(w.recorded).toEqual([{ feed: FEED }]);
    expect(w.notifications).toEqual([]);
  });
});

describe("lookNow", () => {
  it("looks when an administrator asks, even inside the day", async () => {
    const w = world({ state: state({ update_checked_at: new Date(NOW - HOUR) }) });
    expect(await lookNow(w.env, w.d, "1.9.0", NOW)).toBe(true);
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not look again within a minute, with the switch off, or from a build that is not a release", async () => {
    const recent = world({ state: state({ update_checked_at: new Date(NOW - 30_000) }) });
    expect(await lookNow(recent.env, recent.d, "1.9.0", NOW)).toBe(false);
    const off = world({ rowCheck: false });
    expect(await lookNow(off.env, off.d, "1.9.0", NOW)).toBe(false);
    const source = world();
    expect(await lookNow(source.env, source.d, "0.0.0-dev", NOW)).toBe(false);
    for (const w of [recent, off, source]) expect(w.fetch).not.toHaveBeenCalled();
  });
});

describe("updateStatus", () => {
  it("compares the running version with what the last good look listed", () => {
    const checkedAt = new Date(NOW - HOUR);
    const status = updateStatus("1.9.0", state({ update_checked_at: checkedAt, update_feed: FEED }));
    expect(status).toEqual({
      comparable: true,
      checkedAt,
      error: null,
      pending: {
        version: "1.10.0",
        date: "2026-12-01",
        securityVersion: "1.9.1",
        notesUrl: "https://github.com/stuga-dev/stuga/releases/tag/v1.10.0",
      },
    });
  });

  it("is current right after an upgrade, without waiting for the next look", () => {
    expect(updateStatus("1.10.0", state({ update_feed: FEED })).pending).toBeNull();
  });

  it("keeps what it learned through a look that failed", () => {
    const status = updateStatus("1.9.0", state({ update_feed: FEED, update_check_error: "could not reach github.com" }));
    expect(status.error).toBe("could not reach github.com");
    expect(status.pending?.version).toBe("1.10.0");
  });

  it("knows nothing on a build from source, or before the first boot", () => {
    expect(updateStatus("0.0.0-dev", state({ update_feed: FEED }))).toMatchObject({ comparable: false, pending: null });
    expect(updateStatus("1.9.0", null)).toEqual({ comparable: true, checkedAt: null, error: null, pending: null });
  });
});
