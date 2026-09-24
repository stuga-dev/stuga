// What a release says about itself, all of it read from CHANGELOG.md, so a version's date and
// whether it fixes a vulnerability have one source:
//
//   feed.mjs feed             releases.json, the list a running node compares its version with
//   feed.mjs notes <version>  that version's GitHub Release notes
//   feed.mjs date <version>   its date, which build-app.sh writes beside VERSION
//   feed.mjs check <version>  exit 0 only when <version> is the newest entry, so a tag without one fails
//
// Every command takes --changelog <file> (default: CHANGELOG.md at the repository root).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Nodes already released read this shape, so a field only ever gets added. */
const FEED_FORMAT = 1;

const HEADING = /^## \[(?<version>[^\]]+)\](?: - (?<date>\S+))?(?<yanked> \[YANKED\])?\s*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const at = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === text;
}

/** Negative when `a` is the older version. */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The released entries, newest first. Anything that is not a well-formed entry is an error rather
 * than a skipped line: a heading dropped here is a release no node ever hears about.
 */
export function parseChangelog(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("## ")) {
      current?.lines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (!heading) throw new Error(`not a release heading: "${line}" (expected "## [1.2.3] - 2026-01-31")`);
    const { version, date, yanked } = heading.groups;
    if (version === "Unreleased") {
      current = null;
      continue;
    }
    if (!VERSION.test(version)) throw new Error(`"${version}" is not a version such as 1.2.3`);
    if (!date || !isDate(date)) throw new Error(`${version} needs a date such as 2026-01-31, got "${date ?? ""}"`);
    const newer = entries[entries.length - 1];
    if (newer && compareVersions(version, newer.version) >= 0) {
      throw new Error(`${version} is listed below ${newer.version}: entries go newest first`);
    }
    current = { version, date, yanked: Boolean(yanked), lines: [] };
    entries.push(current);
  }
  return entries.map(({ lines, ...entry }) => {
    const sections = splitSections(lines);
    return { ...entry, security: sections.some((s) => s.title === "Security"), sections };
  });
}

/** An entry's `### Title` sections, in order; text before the first one has an empty title. */
function splitSections(lines) {
  const sections = [];
  let current = { title: "", lines: [] };
  for (const line of lines) {
    const title = /^### (.+?)\s*$/.exec(line)?.[1];
    if (title === undefined) {
      current.lines.push(line);
      continue;
    }
    sections.push(current);
    current = { title, lines: [] };
  }
  sections.push(current);
  return sections
    .map((s) => ({ title: s.title, body: s.lines.join("\n").trim() }))
    .filter((s) => s.title !== "" || s.body !== "");
}

/** A yanked version is left out: nobody should be told to move to it. */
export function buildFeed(entries) {
  return {
    format: FEED_FORMAT,
    releases: entries
      .filter((e) => !e.yanked)
      .map(({ version, date, security }) => ({ version, date, security })),
  };
}

function entryFor(entries, version) {
  const entry = entries.find((e) => e.version === version);
  if (!entry) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  return entry;
}

/** Upgrade notes lead, because they are what someone running a node has to act on. */
export function releaseNotes(entries, version) {
  const entry = entryFor(entries, version);
  const upgrade = entry.sections.find((s) => s.title === "Upgrade notes");
  const rest = entry.sections.filter((s) => s !== upgrade);
  const out = ["## Upgrade notes", "", upgrade?.body || "Nothing to do."];
  if (rest.length > 0) {
    out.push("", "## What changed");
    for (const s of rest) out.push("", ...(s.title ? [`### ${s.title}`, ""] : []), s.body);
  }
  return `${out.join("\n")}\n`;
}

/** Refuses a tag whose entry was never written, or was written under an older one. */
export function checkNewest(entries, version) {
  const entry = entryFor(entries, version);
  if (entry.yanked) throw new Error(`${version} is marked [YANKED]`);
  const newest = entries[0];
  if (newest.version !== version) throw new Error(`the newest entry is ${newest.version}, not ${version}`);
}

function main(argv) {
  const args = [...argv];
  let changelog = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));
  const flag = args.indexOf("--changelog");
  if (flag !== -1) {
    const [, file] = args.splice(flag, 2);
    if (!file) throw new Error("--changelog takes a file");
    changelog = file;
  }
  const [command, version] = args;
  const entries = parseChangelog(readFileSync(changelog, "utf8"));
  switch (command) {
    case "feed":
      return `${JSON.stringify(buildFeed(entries), null, 2)}\n`;
    case "notes":
      return releaseNotes(entries, version ?? "");
    case "date":
      return `${entryFor(entries, version ?? "").date}\n`;
    case "check":
      checkNewest(entries, version ?? "");
      return "";
    default:
      throw new Error("usage: feed.mjs feed | notes <version> | date <version> | check <version> [--changelog <file>]");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
