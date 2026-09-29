/**
 * The node's time zone, for work it schedules by the clock on the wall: an IANA
 * name, taken from the browser that set the node up, UTC until then. Node ships
 * full ICU, so every name a browser reports resolves here.
 */

/** `raw` when it is a time zone this runtime knows, else null. */
export function knownTimeZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The wall-clock fields of `at` in `timeZone`. */
function wallClock(at: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute") };
}

/** How far `timeZone` is ahead of UTC at `at`, in milliseconds. */
function offsetAt(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * The instant it is `hour`:00 on the given calendar day in `timeZone`. On a
 * night the clocks change, an hour that does not exist or happens twice lands
 * on a neighbour: a daily backup an hour off once a season does no harm.
 */
function instantOf(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour);
  const first = naive - offsetAt(new Date(naive), timeZone);
  const second = naive - offsetAt(new Date(first), timeZone);
  const third = naive - offsetAt(new Date(second), timeZone);
  const shows = (t: number) => {
    const w = wallClock(new Date(t), timeZone);
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === 0;
  };
  const exact = [first, second, third].filter(shows);
  // An hour that happens twice: its first time. One that never happens: just after the gap.
  return new Date(exact.length > 0 ? Math.min(...exact) : Math.max(first, second, third));
}

/** The calendar day `days` after the given one. */
function addDays(day: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const at = new Date(Date.UTC(day.year, day.month - 1, day.day + days, 12));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** The weekday of a calendar day, 0 (Sunday) to 6. */
function weekdayOf(day: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

/**
 * The scheduled instants around `now`, nearest first, walking `step` days at a time: `hour`:00 in
 * `timeZone` on every day, or only on `weekday` (0 is Sunday). A week and a day covers either.
 */
function* scheduled(now: Date, hour: number, timeZone: string, weekday: number | null, step: 1 | -1): Generator<Date> {
  const today = wallClock(now, timeZone);
  for (let days = 0; days <= 7; days++) {
    const day = addDays(today, days * step);
    if (weekday === null || weekdayOf(day) === weekday) yield instantOf(day.year, day.month, day.day, hour, timeZone);
  }
}

/** The most recent `hour`:00 in `timeZone` at or before `now`, on `weekday` when there is one. */
export function lastScheduled(now: Date, hour: number, timeZone: string, weekday: number | null = null): Date {
  for (const at of scheduled(now, hour, timeZone, weekday, -1)) if (at.getTime() <= now.getTime()) return at;
  throw new Error(`no ${hour}:00 in the last eight days in ${timeZone}`);
}

/** The first `hour`:00 in `timeZone` after `now`, on `weekday` when there is one. */
export function nextScheduled(now: Date, hour: number, timeZone: string, weekday: number | null = null): Date {
  for (const at of scheduled(now, hour, timeZone, weekday, 1)) if (at.getTime() > now.getTime()) return at;
  throw new Error(`no ${hour}:00 in the next eight days in ${timeZone}`);
}
