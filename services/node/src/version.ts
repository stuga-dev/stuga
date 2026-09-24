/**
 * The version is the VERSION file packaging writes at the app root; a source checkout has none.
 * RELEASED beside it holds the day the version was released, when the changelog names one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./app-root.js";

export const DEV_VERSION = "0.0.0-dev";

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
