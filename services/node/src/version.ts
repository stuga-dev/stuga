/**
 * The version is the VERSION file packaging writes at the app root; a source checkout has none.
 * RELEASED beside it holds the day the version was released, when the changelog names one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./app-root.js";

export const DEV_VERSION = "0.0.0-dev";

/** What a release carries: a plain 1.2.3, no leading zeros. */
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type BuildKind = "release" | "source";

/** One line of a file at the app root, or "" when there is no such file. */
function firstLine(appRoot: string, name: string): string {
  try {
    return readFileSync(join(appRoot, name), "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return "";
  }
}

export function readVersion(appRoot: string = APP_ROOT): { version: string; build: BuildKind; releasedAt: string | null } {
  const raw = firstLine(appRoot, "VERSION");
  if (!raw) return { version: DEV_VERSION, build: "source", releasedAt: null };
  const released = firstLine(appRoot, "RELEASED");
  return { version: raw, build: "release", releasedAt: /^\d{4}-\d{2}-\d{2}$/.test(released) ? released : null };
}

const running = readVersion();
export const VERSION = running.version;
export const BUILD = running.build;
/** YYYY-MM-DD. What tells an administrator how old this build is on a node that cannot look for a newer one. */
export const RELEASED_AT = running.releasedAt;

/** The boot line naming this build, the previous one and the schema; printed on every boot, changed or not. */
export function bootSummary(input: {
  version: string;
  previousVersion: string | null;
  schema: { from: number; to: number };
}): string {
  const { version, previousVersion, schema } = input;
  const build =
    previousVersion && previousVersion !== version ? `stuga ${previousVersion} → ${version}` : `stuga ${version}`;
  const db =
    schema.from === 0
      ? `schema ${schema.to} (new database)`
      : schema.from === schema.to
        ? `schema ${schema.to}`
        : `schema ${schema.from} → ${schema.to}`;
  return `${build}, ${db}`;
}

/** A plain 1.2.3. A source build (0.0.0-dev) or a CI build (0.0.0-ci) has nothing to compare with. */
export function isReleaseVersion(version: string): boolean {
  return RELEASE.test(version);
}

/** Negative when `a` is the older one. Both are plain versions. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

export type VersionChange = "same" | "upgrade" | "downgrade" | "unordered";

/**
 * `from` served the data and `to` is about to. Only two plain releases are ordered: a build from
 * source on either side is unordered by design, with no marker of the newest release kept, so an
 * older release after a release and then a build from source is not refused for its version. The
 * schema refusal still covers it.
 */
export function versionChange(from: string, to: string): VersionChange {
  if (from === to) return "same";
  if (!isReleaseVersion(from) || !isReleaseVersion(to)) return "unordered";
  return compareVersions(from, to) < 0 ? "upgrade" : "downgrade";
}
