/**
 * Numbers as a person types and reads them. Typing is strict: a value is taken only when it means
 * one number in the reader's locale, so "4,50" is four and a half (never 450), "1.2.3" and "abc"
 * are refused, and a whole number too large to store exactly is refused rather than rounded.
 * Reading goes through Intl in the reader's locale and the column's format.
 */
import type { NumberFormat } from "@stuga/protocol/databases/types";

export type NumberParse = { ok: true; value: number } | { ok: false; reason: "not_a_number" | "too_large" };

const GROUP_SPACE = /[\s  '’]/g;

/** The decimal sign of a locale: "." or ",". */
export function decimalSign(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * Digits in groups as a reader writes thousands: 1 to 3 digits first, then groups of 3 (2 allowed
 * before the last, as Indian numbering writes them).
 */
function validGroups(groups: string[]): boolean {
  if (groups.length === 1) return /^\d*$/.test(groups[0]!);
  return groups.every((g, i) =>
    i === 0 ? /^\d{1,3}$/.test(g) : i === groups.length - 1 ? /^\d{3}$/.test(g) : /^\d{2,3}$/.test(g),
  );
}

/** A typed number in `locale`. Empty input is the caller's to read as "no value". */
export function parseNumberText(raw: string, locale: string): NumberParse {
  const bad = { ok: false, reason: "not_a_number" } as const;
  let s = raw.trim();
  let negative = false;
  const takeSign = () => {
    const m = /^([+\-−])\s*/.exec(s);
    if (m) {
      negative = m[1] !== "+";
      s = s.slice(m[0].length);
    }
  };
  // A currency sign either side and a trailing percent sign are how the value is shown, not part of it.
  takeSign();
  s = s.replace(/^\p{Sc}\s*/u, "");
  if (!negative) takeSign();
  s = s.replace(/\s*\p{Sc}$/u, "").replace(/\s*%$/, "");

  const exp = /[eE][+-]?\d+$/.exec(s);
  const mantissa = exp ? s.slice(0, exp.index) : s;
  if (!/^[\d.,\s  '’]*\d[\d.,\s  '’]*$/.test(mantissa)) return bad;
  if (/^[\s  '’]|[\s  '’]$/.test(mantissa)) return bad;

  const dec = decimalSign(locale);
  const dots = mantissa.split(".").length - 1;
  const commas = mantissa.split(",").length - 1;
  let decimalSep: string | null = null;
  if (dots > 0 && commas > 0) {
    decimalSep = mantissa.lastIndexOf(".") > mantissa.lastIndexOf(",") ? "." : ",";
    if ((decimalSep === "." ? dots : commas) > 1) return bad;
  } else if (dots + commas === 1) {
    const sep = dots === 1 ? "." : ",";
    const [before, after] = mantissa.split(sep) as [string, string];
    // "1,000" in English and "1.000" in German are thousands; the locale's own sign is always the decimal one.
    const thousands = sep !== dec && /^\d{3}$/.test(after) && /^\d{1,3}$/.test(before.replace(GROUP_SPACE, ""));
    decimalSep = thousands ? null : sep;
  }
  const [intPart, fraction = ""] = decimalSep === null ? [mantissa] : (mantissa.split(decimalSep) as [string, string]);
  const groupSeps = new RegExp(`[${decimalSep === "." ? "," : decimalSep === "," ? "." : ".,"}\\s\\u00A0\\u202F'\\u2019]`);
  if (!validGroups(intPart.split(groupSeps))) return bad;
  if (!/^\d*$/.test(fraction)) return bad;
  const digits = intPart.replace(/\D/g, "");
  if (digits === "" && fraction === "") return bad;

  const value = Number(`${negative ? "-" : ""}${digits || "0"}.${fraction || "0"}${exp ? exp[0] : ""}`);
  if (!Number.isFinite(value)) return { ok: false, reason: "too_large" };
  // Past 2^53 a whole number is stored as a neighbour of itself: refused rather than changed.
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return { ok: false, reason: "too_large" };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Characters that may start typing a number into a cell. */
export const isNumberSeed = (key: string): boolean => /^[\d.,+\-−]$/.test(key);

/** A stored number as the editor shows it: every digit, the locale's decimal sign, no grouping. */
export function numberForEditing(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 20 }).format(n);
}

/** A stored number as the grid shows it, in the column's format. */
export function formatNumber(n: number, format: NumberFormat | undefined, locale: string): string {
  const digits =
    format?.decimals === undefined ? { maximumFractionDigits: format?.style === "currency" ? undefined : 20 } : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals };
  const useGrouping = format?.grouping === true;
  try {
    if (format?.style === "currency" && format.currency) {
      return new Intl.NumberFormat(locale, { style: "currency", currency: format.currency, useGrouping, ...digits }).format(n);
    }
    // A percent column holds 25 for 25%, so it is shown as a unit rather than scaled by Intl's percent style.
    if (format?.style === "percent") {
      return new Intl.NumberFormat(locale, { style: "unit", unit: "percent", useGrouping, ...digits }).format(n);
    }
    return new Intl.NumberFormat(locale, { useGrouping, ...digits }).format(n);
  } catch {
    return String(n);
  }
}
