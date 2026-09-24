// node --test packaging/release/test/feed.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildFeed, checkNewest, parseChangelog, releaseNotes } from "../feed.mjs";

const script = new URL("../feed.mjs", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "stuga-feed-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const CHANGELOG = `# Changelog

Every release, newest first.

## [Unreleased]

### Added

- Something not out yet.

## [1.2.0] - 2026-11-03

### Upgrade notes

Set \`NEW_THING\` before you start the node.

### Added

- Row pages.

## [1.1.1] - 2026-10-27

### Security

- A member could read a document's title without access to it.

### Fixed

- The sidebar kept a deleted folder.

## [1.1.0] - 2026-10-20 [YANKED]

### Changed

- Search ranks titles higher.

## [1.0.0] - 2026-10-01

The first release.
`;

test("the feed lists released versions newest first and leaves out what is not for upgrading to", () => {
  assert.deepEqual(buildFeed(parseChangelog(CHANGELOG)), {
    format: 1,
    releases: [
      { version: "1.2.0", date: "2026-11-03", security: false },
      { version: "1.1.1", date: "2026-10-27", security: true },
      { version: "1.0.0", date: "2026-10-01", security: false },
    ],
  });
});

test("a changelog with nothing released yet is an empty feed", () => {
  assert.deepEqual(buildFeed(parseChangelog("# Changelog\n\n## [Unreleased]\n\n- Work.\n")), { format: 1, releases: [] });
});

test("only a Security section makes a security release", () => {
  const [entry] = parseChangelog("## [1.0.1] - 2026-10-02\n\n### Fixed\n\n- A security hole in the ### Security sense.\n");
  assert.equal(entry.security, false);
});

test("release notes lead with the upgrade notes and keep the other sections", () => {
  assert.equal(
    releaseNotes(parseChangelog(CHANGELOG), "1.2.0"),
    "## Upgrade notes\n\nSet `NEW_THING` before you start the node.\n\n## What changed\n\n### Added\n\n- Row pages.\n",
  );
});

test("release notes say there is nothing to do when the entry has no upgrade notes", () => {
  const notes = releaseNotes(parseChangelog(CHANGELOG), "1.1.1");
  assert.match(notes, /^## Upgrade notes\n\nNothing to do\.\n\n## What changed\n\n### Security\n/);
  assert.match(notes, /### Fixed\n\n- The sidebar kept a deleted folder\.\n$/);
});

test("release notes keep an entry's text that sits under no heading", () => {
  assert.equal(
    releaseNotes(parseChangelog(CHANGELOG), "1.0.0"),
    "## Upgrade notes\n\nNothing to do.\n\n## What changed\n\nThe first release.\n",
  );
});

test("a malformed entry is an error, not a release nobody hears about", () => {
  assert.throws(() => parseChangelog("## 1.0.0 - 2026-10-01\n"), /not a release heading/);
  assert.throws(() => parseChangelog("## [1.0] - 2026-10-01\n"), /not a version/);
  assert.throws(() => parseChangelog("## [1.0.0-rc.1] - 2026-10-01\n"), /not a version/);
  assert.throws(() => parseChangelog("## [1.0.0]\n"), /needs a date/);
  assert.throws(() => parseChangelog("## [1.0.0] - 2026-02-30\n"), /needs a date/);
  assert.throws(() => parseChangelog("## [1.0.0] - 2026-10-01\n## [1.0.1] - 2026-10-02\n"), /newest first/);
  assert.throws(() => parseChangelog("## [1.0.0] - 2026-10-01\n## [1.0.0] - 2026-10-01\n"), /newest first/);
});

test("versions order by number, not by text", () => {
  const entries = parseChangelog("## [1.10.0] - 2026-12-01\n## [1.9.0] - 2026-11-01\n");
  assert.deepEqual(entries.map((e) => e.version), ["1.10.0", "1.9.0"]);
});

test("a tag needs its entry, and the entry has to be the newest", () => {
  const entries = parseChangelog(CHANGELOG);
  assert.doesNotThrow(() => checkNewest(entries, "1.2.0"));
  assert.throws(() => checkNewest(entries, "1.3.0"), /no entry for 1\.3\.0/);
  assert.throws(() => checkNewest(entries, "1.1.1"), /newest entry is 1\.2\.0/);
  assert.throws(() => checkNewest(entries, "1.1.0"), /YANKED/);
});

test("the command line prints one thing to stdout and fails with a reason", () => {
  const file = join(scratch, "CHANGELOG.md");
  writeFileSync(file, CHANGELOG);
  const run = (...args) => execFileSync(process.execPath, [script, ...args, "--changelog", file], { encoding: "utf8" });

  assert.equal(JSON.parse(run("feed")).releases.length, 3);
  assert.equal(run("date", "1.1.1"), "2026-10-27\n");
  assert.match(run("notes", "1.2.0"), /^## Upgrade notes/);
  assert.equal(run("check", "1.2.0"), "");

  const refused = spawnSync(process.execPath, [script, "check", "9.9.9", "--changelog", file], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /error: CHANGELOG\.md has no entry for 9\.9\.9/);

  const unknown = spawnSync(process.execPath, [script, "nonsense", "--changelog", file], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /usage:/);
});

test("the repository's own changelog parses", () => {
  assert.doesNotThrow(() => JSON.parse(execFileSync(process.execPath, [script, "feed"], { encoding: "utf8" })));
});
