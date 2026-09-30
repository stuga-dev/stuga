/**
 * Released migrations are frozen. Every database that ran one recorded its checksum, and the node
 * refuses to start when the file no longer matches, so a change to the schema goes in a new
 * numbered migration, never into one a release has shipped. The release tags say which have shipped:
 * CI fetches them, and a checkout without them checks the pins alone.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_CHECKSUMS, migrationChecksum } from "./migrate.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), "utf8");

/** The first release whose migrations are frozen: earlier releases were previews. */
const FROZEN_FROM = [0, 1, 7];

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}

/** Each migration a release from FROZEN_FROM on shipped, with the first tag that did; null outside a git checkout. */
function shippedMigrations(): Map<string, { tag: string; sum: string }> | null {
  const list = git("tag", "--list", "v*.*.*");
  if (list === null) return null;
  const tags = list
    .split("\n")
    .map((tag) => ({ tag, v: /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number) }))
    .filter((t): t is { tag: string; v: number[] } => t.v !== undefined)
    .filter(({ v }) => compare(v, FROZEN_FROM) >= 0)
    .sort((a, b) => compare(a.v, b.v));
  const shipped = new Map<string, { tag: string; sum: string }>();
  for (const { tag } of tags) {
    for (const path of (git("ls-tree", "--name-only", tag, "packages/db/migrations/") ?? "").split("\n")) {
      const name = path.slice("packages/db/migrations/".length);
      if (!name.endsWith(".sql") || shipped.has(name)) continue;
      shipped.set(name, { tag, sum: migrationChecksum(git("show", `${tag}:${path}`) ?? "") });
    }
  }
  return shipped;
}

/** Negative when version `a` is the older. */
function compare(a: number[], b: number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

const shipped = shippedMigrations();

describe("the migration files", () => {
  it("each has a pinned checksum, and nothing else is pinned", () => {
    const unpinned = MIGRATIONS.filter((name) => !Object.hasOwn(MIGRATION_CHECKSUMS, name));
    expect(
      unpinned,
      `pin each new migration's checksum in MIGRATION_CHECKSUMS (packages/db/src/schema/migrate.ts): ` +
        unpinned.map((name) => `"${name}": "${migrationChecksum(read(name))}"`).join(", "),
    ).toEqual([]);
    expect(Object.keys(MIGRATION_CHECKSUMS).sort()).toEqual([...MIGRATIONS].sort());
  });

  it.each(MIGRATIONS)("%s matches its pinned checksum", (name) => {
    const now = migrationChecksum(read(name));
    const release = shipped?.get(name);
    expect(
      now,
      release
        ? `${name} is now ${now}, not the file ${release.tag} shipped. Released migrations are frozen: every node that ran ` +
            `it recorded ${MIGRATION_CHECKSUMS[name]} and refuses to start on a file that differs. Revert the file and put ` +
            `the change in a new numbered migration.`
        : `${name} is now ${now}, pinned ${MIGRATION_CHECKSUMS[name]}. If no release has shipped it, pin ${now}; once one ` +
            `has, it is frozen and a change goes in a new numbered migration.`,
    ).toBe(MIGRATION_CHECKSUMS[name]);
  });

  it.skipIf(shipped === null)("each migration a release shipped is still the file it shipped", () => {
    // CI fetches the tags; without them nothing here would be checked.
    if (process.env.CI) expect(shipped!.size, "no release tags: git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*'").toBeGreaterThan(0);
    for (const [name, { tag, sum }] of shipped!) {
      expect(MIGRATIONS, `${tag} shipped ${name}, which is no longer in MIGRATIONS. Released migrations are frozen.`).toContain(name);
      expect(
        migrationChecksum(read(name)),
        `${name} is not the file ${tag} shipped. Released migrations are frozen: every node that ran it recorded ` +
          `${sum} and refuses to start on a file that differs. Revert the file and its pin, and put the change in a new ` +
          `numbered migration.`,
      ).toBe(sum);
      expect(MIGRATION_CHECKSUMS[name], `the pin of ${name}, which ${tag} shipped as ${sum}`).toBe(sum);
    }
  });
});
