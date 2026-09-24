/** Thousands-separated integer. */
export const fmtInt = (n: number): string => n.toLocaleString();

/** "just now", "5m ago", "Yesterday", "Jun 24", "Jun 24, 2025"; an unparseable value comes back as given. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "Yesterday";
  if (day < 7) return `${day}d ago`;
  const d = new Date(then);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** The calendar day in the viewer's timezone, for grouping a list: "Today", "Yesterday", "Mon, Aug 17", "Aug 17, 2025". */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** Clock time without seconds, in the viewer's locale. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : iso;
}

/** "Aug 17, 2:32 PM": how a version is named, since its seq is an internal counter with gaps. */
export function versionLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
  return `${date}, ${timeOfDay(iso)}`;
}

/** "Oct 1, 2026" for a YYYY-MM-DD day, which has no timezone and must not slide into the one before. */
export function calendarDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** A full local timestamp for tooltips. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

/** The in-app co-author's name, spelled once so every surface agrees. */
export const AI_COAUTHOR_LABEL = "AI co-author";

/** The person a `panel:<alias>` co-author principal belongs to; null for any other principal. */
export function principalHuman(alias: string): string | null {
  return alias.startsWith("panel:") ? alias.slice("panel:".length) : null;
}
