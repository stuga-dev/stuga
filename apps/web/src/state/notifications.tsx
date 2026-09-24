/**
 * The notification tray, shared by every mounted bell. The poll asks only for the
 * unread count; the rows are fetched when a tray opens.
 */
import { useCallback, useEffect } from "react";
import { Notifications, type Notification } from "../api";
import { createStore, useStore } from "../lib/store";

const POLL_INTERVAL_MS = 60 * 1000;

interface TrayState {
  /** Unread count for the dot; null until the first poll lands. */
  count: number | null;
  /** The tray's rows; null until a tray has been opened. */
  rows: Notification[] | null;
  /** The last rows fetch failed, so an empty list means "unknown", not "none". */
  rowsFailed: boolean;
}

const EMPTY: TrayState = { count: null, rows: null, rowsFailed: false };
const tray = createStore<TrayState>(EMPTY);

let countInflight: Promise<void> | null = null;
let rowsInflight: Promise<void> | null = null;
/** Bumped by every optimistic write; a count response from an older request is dropped. */
let generation = 0;
/**
 * The created_at through which this client marked everything read. Re-applied to
 * any rows that arrive later, so a rows response that raced a mark-all cannot
 * relight what was just cleared.
 */
let readThrough: string | null = null;
let pollingStarted = false;
let subscribers = 0;

function applyLocalReads(list: Notification[]): Notification[] {
  const through = readThrough;
  if (!through) return list;
  return list.map((n) => (!n.read && n.created_at <= through ? { ...n, read: true } : n));
}

async function loadCount(): Promise<void> {
  const gen = generation;
  try {
    const r = await Notifications.unread();
    if (gen === generation) tray.update((s) => ({ ...s, count: r.unread }));
  } catch {
    // A failed first poll still resolves the dot off "loading".
    if (tray.get().count === null) tray.update((s) => ({ ...s, count: 0 }));
  } finally {
    countInflight = null;
  }
}

async function loadRows(): Promise<void> {
  try {
    const r = await Notifications.list();
    tray.update((s) => ({ ...s, rows: applyLocalReads(r.notifications), rowsFailed: false }));
  } catch {
    tray.update((s) => ({ ...s, rows: s.rows ?? [], rowsFailed: true }));
  } finally {
    rowsInflight = null;
  }
}

/** Re-poll the count; concurrent callers share one request. */
export function refreshNotifications(): void {
  countInflight ??= loadCount();
}

/** Pull the tray's rows; concurrent callers share one request. */
export function refreshNotificationRows(): void {
  rowsInflight ??= loadRows();
}

/** Forget the cache between tests. The poll timer and visibility listener are process-wide and stay. */
export function resetNotificationsForTest(): void {
  countInflight = null;
  rowsInflight = null;
  readThrough = null;
  generation++;
  tray.set(EMPTY);
}

/** One timer for the module; each tick is skipped while the tab is hidden or no bell is mounted. */
function startPolling(): void {
  if (pollingStarted) return;
  pollingStarted = true;
  const poll = () => {
    if (document.visibilityState === "visible" && subscribers > 0) refreshNotifications();
  };
  setInterval(poll, POLL_INTERVAL_MS);
  // Background tabs throttle timers, so a returning tab re-polls at once.
  document.addEventListener("visibilitychange", poll);
}

export function useNotifications() {
  const state = useStore(tray);

  useEffect(() => {
    subscribers++;
    startPolling();
    if (tray.get().count === null) refreshNotifications();
    return () => {
      subscribers--;
    };
  }, []);

  /**
   * Optimistically mark read everything up to the newest row the tray holds. A
   * notification created after the rows were fetched stays unread and relights
   * the dot on the next poll.
   */
  const markAllRead = useCallback(async (): Promise<void> => {
    const before = tray.get().rows;
    if (!before?.some((n) => !n.read)) return;
    const newest = before.reduce((max, n) => (n.created_at > max ? n.created_at : max), before[0]!.created_at);
    const previousWatermark = readThrough;
    generation++;
    readThrough = newest;
    tray.update((s) => ({ ...s, rows: before.map((n) => (n.read ? n : { ...n, read: true })), count: 0 }));
    try {
      await Notifications.markRead({ before: newest });
    } catch {
      // Take the server's word for both the count and the rows, or the dot and the tray disagree.
      readThrough = previousWatermark;
      void (countInflight ?? Promise.resolve()).then(() => refreshNotifications());
      refreshNotificationRows();
    }
  }, []);

  return {
    /** Newest first; null until a tray has been opened. */
    notifications: state.rows,
    rowsFailed: state.rowsFailed,
    /** The server's unread total, which counts rows beyond the tray's window. */
    unread: state.count ?? 0,
    markAllRead,
    loadRows: refreshNotificationRows,
    refresh: refreshNotifications,
  };
}
