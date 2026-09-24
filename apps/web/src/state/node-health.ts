/**
 * The pure model behind the app-wide server notice, fed by probes of /ready,
 * which answers 503 when the node cannot reach its database. The component owns
 * the timers and the fetch.
 */

/** What one probe of /ready found. */
export type Probe =
  /** 200 from the node, database reachable. */
  | "ok"
  /** 503: the node is up but its database is not. */
  | "unready"
  /** No answer: the node, or something in front of it, is down. */
  | "unreachable"
  /** The browser is offline, which says nothing about the server. */
  | "offline"
  /**
   * A 200 without the node's `{ ok: true }`: a proxy or dev server answered with
   * the SPA's index.html. Neither success nor failure, so the operator is warned.
   */
  | "opaque";

/** One failure is a restart or a dropped packet; two in a row outlived a retry. */
export const FAILURES_BEFORE_NOTICE = 2;

export const HEALTHY_POLL_MS = 30_000;

/** Fast after a failure, so both the alarm and the all-clear are prompt. */
export const TROUBLED_POLL_MS = 5_000;

/** A hung probe counts as a failure instead of stalling the poll loop. */
export const PROBE_TIMEOUT_MS = 5_000;

export interface NodeHealth {
  /** Consecutive non-ok probes. */
  failures: number;
  /** The latest verdict, which picks the notice. */
  last: Probe | null;
}

export function newNodeHealth(): NodeHealth {
  return { failures: 0, last: null };
}

/** Fold one probe result in. Pure; a no-op result returns `h` itself. */
export function observe(h: NodeHealth, p: Probe): NodeHealth {
  // Offline, opaque and ok all clear the count: none of them accuses the server.
  if (p === "offline" || p === "opaque" || p === "ok") {
    return h.failures === 0 && h.last === p ? h : { failures: 0, last: p };
  }
  // A 503 names the cause; a later silent probe in the same outage must not replace it with a vaguer story.
  const keepsSpecific = h.failures > 0 && h.last === "unready" && p === "unreachable";
  return { failures: h.failures + 1, last: keepsSpecific ? "unready" : p };
}

/** How long to wait before the next probe. */
export function pollDelay(h: NodeHealth): number {
  return h.failures === 0 ? HEALTHY_POLL_MS : TROUBLED_POLL_MS;
}

/** What the banner says, or null when there is nothing to report. */
export interface NodeNotice {
  status: "error" | "warning";
  title: string;
  description: string;
}

/** Claims nothing about whether a given edit was stored; the document's own indicator answers that. */
export function notice(h: NodeHealth): NodeNotice | null {
  if (h.failures < FAILURES_BEFORE_NOTICE) return null;
  if (h.last === "unready") {
    return {
      status: "error",
      title: "This server can’t reach its database",
      description:
        "It’s still running, so pages load — but the part that stores your work isn’t answering. Keep this tab open, and tell whoever runs this server.",
    };
  }
  return {
    status: "warning",
    title: "Can’t reach the server",
    description:
      "This tab has lost contact with the server and keeps retrying. Keep it open so anything you’ve typed isn’t lost.",
  };
}
