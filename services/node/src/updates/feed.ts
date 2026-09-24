/** Where Stuga's source lives: its releases, and the code of every tagged version. */
export const REPOSITORY = "https://github.com/stuga-dev/stuga";

/**
 * The list of releases a node compares its own version with. The release workflow publishes it
 * from CHANGELOG.md as an asset of every release (packaging/release/feed.mjs); `latest/download`
 * is GitHub's pointer to the newest one. Nothing about this node is part of the request.
 */
export const RELEASES_URL = `${REPOSITORY}/releases/latest/download/releases.json`;

/** A release as the feed lists it. */
export interface Release {
  version: string;
  /** The day it was released, YYYY-MM-DD. */
  date: string;
  /** Whether it fixes a vulnerability. */
  security: boolean;
}

/** What a node that is behind has to move to. */
export interface PendingUpdate {
  /** The newest release. */
  version: string;
  date: string;
  /** The newest release after the running one that fixes a vulnerability; null when none does. */
  securityVersion: string | null;
  /** Built here from the version, never read from the feed, so the feed cannot send anyone anywhere else. */
  notesUrl: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** More entries than any changelog will hold; the rest of an absurd feed is dropped. */
const MAX_RELEASES = 5000;

/** A plain 1.2.3. A source build (0.0.0-dev) or a CI build (0.0.0-ci) has nothing to compare with. */
export function isReleaseVersion(version: string): boolean {
  return VERSION.test(version);
}

/** Negative when `a` is the older one. Both are plain versions. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

/** Every release, for someone whose node cannot look but whose browser can. */
export const RELEASES_PAGE = `${REPOSITORY}/releases`;

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_PAGE}/tag/v${version}`;
}

/** The code a build was made from: its tag for a release, the repository for a build from source. */
export function sourceUrl(version: string, build: "release" | "source"): string {
  return build === "release" ? `${REPOSITORY}/tree/v${version}` : REPOSITORY;
}

/**
 * The releases in a feed document. An entry this build cannot read is skipped, not fatal, so a
 * later feed may carry more than this build knows; a document that is no feed at all throws.
 */
export function parseFeed(doc: unknown): Release[] {
  const list = (doc as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(list)) throw new Error("not a release list");
  const releases: Release[] = [];
  for (const entry of list.slice(0, MAX_RELEASES)) {
    const { version, date, security } = (entry ?? {}) as Record<string, unknown>;
    if (typeof version !== "string" || !VERSION.test(version)) continue;
    if (typeof date !== "string" || !DATE.test(date)) continue;
    releases.push({ version, date, security: security === true });
  }
  return releases;
}

/** What the stored feed holds, or nothing: a row written by another build is not trusted to be well-formed. */
export function storedReleases(stored: unknown): Release[] {
  try {
    return parseFeed(stored);
  } catch {
    return [];
  }
}

/** The release to move to, when `running` is behind the newest one listed. */
export function pendingUpdate(running: string, releases: Release[]): PendingUpdate | null {
  if (!isReleaseVersion(running)) return null;
  const newer = releases
    .filter((r) => compareVersions(r.version, running) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = newer[0];
  if (!latest) return null;
  return {
    version: latest.version,
    date: latest.date,
    securityVersion: newer.find((r) => r.security)?.version ?? null,
    notesUrl: releaseNotesUrl(latest.version),
  };
}
