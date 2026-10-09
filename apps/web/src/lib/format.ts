import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { formatLocale, t, uiLanguage } from "../i18n/i18n";

/** Thousands-separated integer. */
export const fmtInt = (n: number): string => n.toLocaleString(formatLocale());

/** "12 MB", "1.4 GB", "120 GB": a tenth only below ten. */
export function byteSize(bytes: number): string {
  const [n, unit] =
    bytes < 1024 * 1024
      ? [Math.max(1, Math.round(bytes / 1024)), "kilobyte"]
      : bytes < 1024 ** 3
        ? [Math.round(bytes / 1024 ** 2), "megabyte"]
        : bytes < 1024 ** 4
          ? [bytes / 1024 ** 3, "gigabyte"]
          : [bytes / 1024 ** 4, "terabyte"];
  return new Intl.NumberFormat(formatLocale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: n < 10 && (unit === "gigabyte" || unit === "terabyte") ? 1 : 0,
    minimumFractionDigits: n < 10 && (unit === "gigabyte" || unit === "terabyte") ? 1 : 0,
  }).format(n);
}

/** "5m ago" in English, and each language's own short form. */
function ago(n: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(formatLocale(), { style: uiLanguage() === "en" ? "narrow" : "short" }).format(-n, unit);
}

/** "just now", "5m ago", "Yesterday", "Jun 24", "Jun 24, 2025"; an unparseable value comes back as given. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return t("format.justNow");
  const min = Math.round(sec / 60);
  if (min < 60) return ago(min, "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return ago(hr, "hour");
  const day = Math.round(hr / 24);
  if (day === 1) return t("format.yesterday");
  if (day < 7) return ago(day, "day");
  const d = new Date(then);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(formatLocale(), sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** The calendar day in the viewer's timezone, for grouping a list: "Today", "Yesterday", "Mon, Aug 17", "Aug 17, 2025". */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days === 0) return t("format.today");
  if (days === 1) return t("format.yesterday");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    formatLocale(),
    sameYear ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** Clock time without seconds, in the viewer's locale. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(formatLocale(), { hour: "numeric", minute: "2-digit" }) : iso;
}

/** "Aug 17", or "Aug 17, 2025" in another year, in the viewer's timezone. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(formatLocale(), sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Aug 17, 2:32 PM": how a version is named, since its seq is an internal counter with gaps. */
export function versionLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return t("format.dateAtTime", { date: shortDate(iso), time: timeOfDay(iso) });
}

/** "Oct 1, 2026" for a YYYY-MM-DD day, which has no timezone and must not slide into the one before. */
export function calendarDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(d.getTime())) return day;
  return d.toLocaleDateString(formatLocale(), { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** "October 2026" for the start of a UTC month, as the node counts usage. */
export function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(formatLocale(), { timeZone: "UTC", month: "long", year: "numeric" }) : iso;
}

/** "A, B, C": a list of short labels, joined as the reader's locale joins them. */
export function listOf(items: readonly string[]): string {
  return new Intl.ListFormat(formatLocale(), { type: "conjunction", style: "narrow" }).format(items);
}

/** A full local timestamp for tooltips. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(formatLocale()) : iso;
}

/** The in-app co-author's name, spelled once so every surface agrees. */
export function aiCoauthorLabel(): string {
  return t("format.aiCoauthor");
}

/** What a search language is called, in the interface language. */
export function searchLanguageLabel(language: SearchLanguage): string {
  try {
    return new Intl.DisplayNames([uiLanguage() === "en-XA" ? "en" : uiLanguage()], { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** The person a `panel:<alias>` co-author principal belongs to; null for any other principal. */
export function principalHuman(alias: string): string | null {
  return alias.startsWith("panel:") ? alias.slice("panel:".length) : null;
}

/** The name an archive gave an `imported:<name>` comment author, which is no account; null for any other author. */
export function importedAuthor(author: string): string | null {
  return author.startsWith("imported:") ? author.slice("imported:".length) : null;
}
