/**
 * The name a person signs in with and is @mentioned by. Every account has one,
 * unique on its node, whether it signs in with a password or through the
 * identity provider; email is optional contact detail and never identifies
 * anyone, because nothing ever verifies it.
 */

/** Lowercase letters, digits, and `.`, `_`, `-` after the first character; 2–32 long. Mirrored by a CHECK in 0001. */
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const MAX_USERNAME = 32;
/** Room kept at the end of a suggestion's base for a `-NNN` suffix. */
const SUFFIX_ROOM = 4;

/** Usernames are case-insensitive: every lookup and every write goes through this. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** Takes the normalized form. */
export function isValidUsername(username: string): boolean {
  return USERNAME.test(username);
}

/** One sentence a person can act on, shown by the sign-up form and returned by the node. */
export const USERNAME_RULE =
  "Use 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.";

/**
 * Handles no one may take: they read as the node or its operator speaking, or
 * are what mail and web conventions route to staff. Exact match after normalization.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  "admin",
  "administrator",
  "root",
  "stuga",
  "support",
  "security",
  "abuse",
  "postmaster",
  "system",
  "api",
  "www",
  "me",
  "null",
  "undefined",
];

/** Takes the normalized form. */
export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.includes(username);
}

/**
 * A valid base to suggest a username from: an email-shaped value keeps its
 * local part, accents are dropped, anything else outside the rule becomes `-`,
 * runs of separators collapse, and the ends are trimmed to letters or digits.
 * Short enough to take a `-NNN` suffix; `user` when nothing usable is left.
 */
export function usernameBase(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  const at = s.indexOf("@");
  if (at > 0) s = s.slice(0, at);
  s = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, (run) => run[0]!)
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, MAX_USERNAME - SUFFIX_ROOM)
    .replace(/[^a-z0-9]+$/, "");
  return isValidUsername(s) ? s : "user";
}

/** A small counter a name may already end in, like the `-2` of `ada-2`; a year such as `-1990` is part of the name. */
const COUNTER = /^(.+?)-([1-9]\d?)$/;

/**
 * The names to offer from `base`, in order: `base`, `base-2`, `base-3`, … for
 * `count` suffixes, keeping only valid, unreserved ones. A base that already
 * ends in a counter is counted on from it (`ada-2`, `ada-3`, …), never given a
 * second one (`ada-2-2`). The caller removes the taken ones with one query.
 */
export function usernameCandidates(base: string, count = 20): string[] {
  const counted = COUNTER.exec(base);
  const stem = counted ? counted[1]! : base;
  const first = counted ? Number(counted[2]) : 1;
  const out: string[] = [];
  for (let i = first; i < first + count; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const name = stem.slice(0, MAX_USERNAME - suffix.length) + suffix;
    if (isValidUsername(name) && !isReservedUsername(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** What a suggestion starts from: the provider's preferred username, else the email's local part, else the name. */
export function usernameSource(claims: { preferredUsername?: string | null; email?: string | null; name?: string | null }): string {
  return claims.preferredUsername?.trim() || claims.email?.trim() || claims.name?.trim() || "";
}

/** Shape check for the optional contact address; CRLF must never reach an SMTP envelope. */
export function isEmailShaped(input: string): boolean {
  return input.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}
