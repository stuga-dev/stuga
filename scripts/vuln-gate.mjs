// The vulnerability gate: reads what the scanners found, applies the policy (SECURITY.md#dependencies)
// and the exceptions in .github/security/accepted-risks.json, and decides whether a release may
// ship. No dependencies, so a sparse checkout of this repository runs it too.
//
//   node scripts/vuln-gate.mjs [scans] [--accepted <file>] [--today <YYYY-MM-DD>] [--issues]
//
//   --osv <file> --lockfile <file>   osv-scanner scan source --all-packages --format json of that pnpm lockfile
//   --govulncheck <file>             govulncheck -format json, source mode; named govulncheck-<cmd>-<os>-<arch>.json
//   --trivy <file>                   trivy image --format json
//   --node-core <file>               the Node.js security WG's vuln/core/index.json, checked against
//                                    --node-version (default: NODE_VERSION in packaging/versions.env)
//   --advisories <name>@<version>=<file>   a repository's published advisories (gh api repos/<r>/security-advisories)
//   --watch <file>                   what the daily watch found: [{"id", "package", "version", "fixed", "url"}]
//
// Exits 0 when nothing blocks, 1 when something does, and 2 when a scan is missing or incomplete or
// the exceptions are wrong. The summary goes to stdout and to $GITHUB_STEP_SUMMARY.
//
// --issues is the daily watch's mode: one issue per blocking ID, labelled vuln-watch and assigned to
// $SECURITY_OWNER, updated while the finding lasts and closed when it clears or is accepted. It
// needs GITHUB_TOKEN and GITHUB_REPOSITORY, and exits 0 unless a scan or the exceptions are wrong.
// A scan that is wrong leaves every issue as it is. Wrong exceptions do not: an entry the gate
// refuses accepts nothing, so its findings keep their issues, and the run then exits 2.
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const SCOPES = ["lockfile", "go", "image", "node", "watch"];
/** How long a finding may wait for its fix, and so the longest an exception may last. */
const FIX_DAYS = { CRITICAL: 7, HIGH: 30, OTHER: 90 };
const EXPIRY_WARNING_DAYS = 7;
/** The step summary's limit is 1 MiB; the worst rows come first. */
const REPORTED_ROWS = 300;
const LABEL = "vuln-watch";
const EXCEPTION_KEYS = { id: 100, package: 200, scope: 20, reason: 500, added: 10, expires: 10, issue: 200 };
const REQUIRED_KEYS = ["id", "package", "scope", "reason", "added", "expires"];

/** A scan this gate cannot judge: missing, unreadable, or not covering what it should. */
export class IncompleteScan extends Error {}

// ---- dates

const DAY = 86_400_000;

function parseDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text ? null : at;
}

function addDays(date, days) {
  return new Date(parseDate(date) + days * DAY).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY);
}

// ---- versions and ranges

/** [major, minor, patch] of a version such as 1.2.3 or v1.2.3; null for anything else. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const PARTIAL = /^(\^|~|[<>]=?|=)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

/** One comparator as a test of a parsed version. Throws on syntax it does not know. */
function comparator(token) {
  if (token === "*" || token === "x" || token === "X") return () => true;
  const m = PARTIAL.exec(token);
  if (!m) throw new Error(`unknown version range "${token}"`);
  const op = m[1] ?? "=";
  const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || /[xX*]/.test(p) ? null : Number(p)));
  if (parts[1] === null && parts[2] !== null) throw new Error(`unknown version range "${token}"`);
  const [x, y, z] = parts;
  const given = parts.filter((p) => p !== null).length;
  const low = [x, y ?? 0, z ?? 0];
  // The first version after everything the partial version names: 1 -> 2.0.0, 1.2 -> 1.3.0.
  const next = given === 1 ? [x + 1, 0, 0] : given === 2 ? [x, y + 1, 0] : [x, y, z + 1];
  const ge = (lo) => (v) => compareVersions(v, lo) >= 0;
  const lt = (hi) => (v) => compareVersions(v, hi) < 0;
  const between = (lo, hi) => (v) => ge(lo)(v) && lt(hi)(v);
  switch (op) {
    case "=":
      return between(low, next);
    case ">=":
      return ge(low);
    case ">":
      return ge(next);
    case "<":
      return lt(low);
    case "<=":
      return lt(next);
    case "~":
      return between(low, given === 1 ? [x + 1, 0, 0] : [x, y + 1, 0]);
    case "^": {
      if (x > 0 || given === 1) return between(low, [x + 1, 0, 0]);
      if (y > 0 || given === 2) return between(low, [0, y + 1, 0]);
      return between(low, [0, 0, z + 1]);
    }
  }
  throw new Error(`unknown version range "${token}"`);
}

/** Whether a version is in an npm-style range: comparator sets joined by ||, commas allowed. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`"${version}" is not a version such as 1.2.3`);
  return String(range)
    .split("||")
    .some((set) => {
      const tokens = set.replace(/,/g, " ").replace(/(\^|~|[<>]=?|=)\s+/g, "$1").trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) throw new Error(`empty version range in "${range}"`);
      return tokens.map(comparator).every((test) => test(v));
    });
}

// ---- severities

function normalSeverity(text) {
  const s = String(text ?? "").toUpperCase();
  if (s === "MODERATE") return "MEDIUM";
  return SEVERITIES.includes(s) ? s : "UNKNOWN";
}

function severityOfScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return "UNKNOWN";
  return n >= 9 ? "CRITICAL" : n >= 7 ? "HIGH" : n >= 4 ? "MEDIUM" : "LOW";
}

function rank(severity) {
  return SEVERITIES.indexOf(severity);
}

/** The rated one of these severities that is worst, or UNKNOWN. */
function worst(severities) {
  return severities.filter((s) => s !== "UNKNOWN").sort((a, b) => rank(a) - rank(b))[0] ?? "UNKNOWN";
}

/** Where a finding without a severity blocks a release. */
const UNRATED_BLOCKS = ["lockfile", "go", "node"];

/** The severity a finding is judged at: one without a severity counts as HIGH where that blocks it. */
function judged(finding) {
  return finding.severity === "UNKNOWN" && UNRATED_BLOCKS.includes(finding.scope) ? "HIGH" : finding.severity;
}

/** A finding's fix target, and so the longest its exception may last. */
function fixDays(finding) {
  return FIX_DAYS[judged(finding)] ?? FIX_DAYS.OTHER;
}

/** Of these findings, the one whose fix target is nearest. */
const strictest = (findings) => [...findings].sort((a, b) => fixDays(a) - fixDays(b))[0];

/** npm and Node.js: high or critical blocks, and so does a finding without a severity. */
const highOrWorse = (severity) => severity === "UNKNOWN" || rank(severity) <= rank("HIGH");

// ---- the scanners

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new IncompleteScan(`${what} ${file}: ${err.code === "ENOENT" ? "missing" : err.message}`);
  }
  if (!text.trim()) throw new IncompleteScan(`${what} ${file}: empty`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new IncompleteScan(`${what} ${file}: not JSON (${err.message})`);
  }
}

/** Every name@version under a `packages:` key, in each YAML document of a pnpm lockfile. */
export function lockfilePackages(text) {
  const out = new Set();
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.startsWith("---") ? null : line.replace(/:.*$/, "");
      continue;
    }
    if (section !== "packages") continue;
    const key = /^ {2}(['"]?)(\S.*?)\1:$/.exec(line)?.[2];
    if (key === undefined) continue;
    const at = key.lastIndexOf("@");
    if (at <= 0) throw new IncompleteScan(`the lockfile lists "${key}", which is not name@version`);
    out.add(key);
  }
  return out;
}

const advisoryUrl = (id) => `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;

/** osv-scanner over a pnpm lockfile, with --all-packages so every package it read is listed. */
export function parseOsv(report, { lockfile, lockfileText }) {
  if (!Array.isArray(report?.results)) throw new IncompleteScan(`osv-scanner's report has no results`);
  const where = basename(lockfile);
  const read = new Set();
  const findings = [];
  for (const result of report.results) {
    for (const pkg of result.packages ?? []) {
      const { name, version } = pkg.package ?? {};
      if (!name || !version) throw new IncompleteScan(`osv-scanner lists a package without a name or version`);
      read.add(`${name}@${version}`);
      const vulns = new Map((pkg.vulnerabilities ?? []).map((v) => [v.id, v]));
      // An advisory in no group of osv-scanner's is a group of its own.
      const groups = [...(pkg.groups ?? [])];
      const grouped = new Set(groups.flatMap((g) => g.ids ?? []));
      for (const id of vulns.keys()) if (!grouped.has(id)) groups.push({ ids: [id], aliases: [] });
      for (const group of groups) {
        if (!group.ids?.length) throw new IncompleteScan(`osv-scanner lists a group without advisories for ${name}@${version}`);
        const members = group.ids.map((id) => vulns.get(id)).filter(Boolean);
        // The worst of the advisories' labels and the group's CVSS score.
        const severity = worst([
          ...members.map((v) => normalSeverity(v.database_specific?.severity)),
          severityOfScore(group.max_severity),
        ]);
        const aliases = new Set([...(group.aliases ?? []), ...group.ids, ...members.flatMap((v) => v.aliases ?? [])]);
        const fixed = fixedVersions(members, name, version);
        const id = group.ids[0];
        aliases.delete(id);
        findings.push({
          scope: "lockfile",
          id,
          aliases: [...aliases].sort(),
          package: name,
          version,
          fixed,
          severity,
          where,
          url: advisoryUrl(id),
          blocks: highOrWorse(severity),
        });
      }
    }
  }
  const listed = lockfilePackages(lockfileText);
  const missing = [...listed].filter((key) => !read.has(key));
  const extra = [...read].filter((key) => !listed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const sample = (keys) => keys.slice(0, 5).join(", ") + (keys.length > 5 ? ", …" : "");
    throw new IncompleteScan(
      `osv-scanner read ${read.size} packages, ${where} lists ${listed.size}` +
        (missing.length ? `; not read: ${sample(missing)}` : "") +
        (extra.length ? `; not in ${where}: ${sample(extra)}` : ""),
    );
  }
  return { findings, scan: `${where} (osv-scanner): ${read.size} packages, every one ${where} lists` };
}

/** The lowest fixed version above the installed one, from the advisories' ranges. */
function fixedVersions(vulns, name, version) {
  const installed = parseVersion(version);
  const fixed = vulns
    .flatMap((v) => v.affected ?? [])
    .filter((a) => a.package?.name === name)
    .flatMap((a) => a.ranges ?? [])
    .flatMap((r) => r.events ?? [])
    .map((e) => e.fixed)
    .filter(Boolean)
    .map((f) => ({ text: f, parsed: parseVersion(f) }))
    .filter((f) => !installed || !f.parsed || compareVersions(f.parsed, installed) > 0)
    .sort((a, b) => (a.parsed && b.parsed ? compareVersions(a.parsed, b.parsed) : 0));
  return fixed[0]?.text ?? "";
}

/** The top-level JSON values of a stream, such as govulncheck's. */
export function jsonStream(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") {
      if (depth++ === 0) start = i;
    } else if (c === "}" || c === "]") {
      if (--depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
      if (depth < 0) throw new Error("unbalanced JSON");
    } else if (depth === 0 && !/\s/.test(c)) throw new Error(`unexpected "${c}" between JSON values`);
  }
  if (depth !== 0 || inString) throw new Error("the stream ends inside a value");
  return values;
}

const GO_LEVELS = ["symbol", "package", "module"];

/** govulncheck in source mode: a finding whose trace reaches a function blocks. */
export function parseGovulncheck(text, file) {
  let values;
  try {
    values = jsonStream(text);
  } catch (err) {
    throw new IncompleteScan(`govulncheck ${file}: not a JSON stream (${err.message})`);
  }
  const config = values.find((v) => v.config)?.config;
  if (!config) throw new IncompleteScan(`govulncheck ${file}: no config, so the scan did not start`);
  if (config.scan_mode !== "source" || config.scan_level !== "symbol") {
    const scan = `a ${config.scan_mode} scan at ${config.scan_level} level`;
    throw new IncompleteScan(`govulncheck ${file}: ${scan}, not source at symbol level`);
  }
  // The modules it read, which a scan that stopped while loading the code never lists.
  if (!values.some((v) => v.SBOM)) throw new IncompleteScan(`govulncheck ${file}: no SBOM, so it never loaded the code`);
  const where = basename(file, ".json").replace(/^govulncheck-/, "").replace(/-(\w+)-(\w+)$/, " $1/$2");
  const osv = new Map(values.filter((v) => v.osv).map((v) => [v.osv.id, v.osv]));
  // One finding per ID in each module, at the deepest level found: an ID can cover stdlib and a module.
  const byKey = new Map();
  for (const { finding } of values.filter((v) => v.finding)) {
    const top = finding.trace?.[0] ?? {};
    const level = top.function ? "symbol" : top.package ? "package" : "module";
    const key = `${finding.osv}\u0000${top.module ?? ""}`;
    const seen = byKey.get(key);
    if (seen && GO_LEVELS.indexOf(seen.level) <= GO_LEVELS.indexOf(level)) continue;
    byKey.set(key, { finding, top, level });
  }
  const findings = [...byKey.values()].map(({ finding, top, level }) => {
    const entry = osv.get(finding.osv);
    const pkg = top.module === "stdlib" ? "stdlib" : top.module ?? "";
    return {
      scope: "go",
      id: finding.osv,
      aliases: (entry?.aliases ?? []).filter((a) => a !== finding.osv),
      package: pkg,
      version: top.version ?? config.go_version ?? "",
      fixed: finding.fixed_version ?? "",
      severity: "UNKNOWN",
      where: `${where} (${level})`,
      url: `https://pkg.go.dev/vuln/${finding.osv}`,
      blocks: level === "symbol",
    };
  });
  const count = (level) => [...byKey.values()].filter((f) => f.level === level).length;
  return {
    findings,
    scan:
      `${where} (govulncheck, ${config.go_version}): ` +
      `${count("symbol")} reachable, ${count("package")} imported, ${count("module")} required`,
  };
}

/** trivy over an image: OS packages with a Debian fix block at HIGH and above. */
export function parseTrivy(report, file) {
  if (report?.SchemaVersion !== 2 || !Array.isArray(report.Results)) {
    throw new IncompleteScan(`trivy ${file}: not a trivy report (schema 2)`);
  }
  const os = report.Metadata?.OS;
  const arch = report.Metadata?.ImageConfig?.architecture;
  const where = `${report.ArtifactName}${arch ? ` ${report.Metadata.ImageConfig.os ?? "linux"}/${arch}` : ""}`;
  if (!os?.Family) throw new IncompleteScan(`trivy ${where}: no operating system detected, so its packages were not scanned`);
  if (!report.Results.some((r) => r.Class === "os-pkgs")) {
    throw new IncompleteScan(`trivy ${where}: no result for the ${os.Family} ${os.Name} packages`);
  }
  const findings = [];
  let fixable = 0;
  for (const result of report.Results) {
    const osPackages = result.Class === "os-pkgs";
    for (const v of result.Vulnerabilities ?? []) {
      const severity = normalSeverity(v.Severity);
      const fixed = v.FixedVersion ?? "";
      if (osPackages && fixed) fixable++;
      findings.push({
        scope: "image",
        id: v.VulnerabilityID,
        aliases: (v.VendorIDs ?? []).filter((a) => a !== v.VulnerabilityID),
        package: v.PkgName,
        version: v.InstalledVersion ?? "",
        fixed,
        severity,
        where: osPackages ? where : `${where} ${result.Target}`,
        url: v.PrimaryURL || advisoryUrl(v.VulnerabilityID),
        blocks: osPackages && fixed !== "" && rank(severity) <= rank("HIGH"),
      });
    }
  }
  return {
    findings,
    scan: `${where} (trivy, ${os.Family} ${os.Name}): ${findings.length} findings, ${fixable} in its OS packages with a fix`,
    warning: os.EOSL ? `${where}: ${os.Family} ${os.Name} is past its end of support` : undefined,
  };
}

/** The Node.js security WG's core list: an advisory whose range holds NODE_VERSION and whose fix does not. */
export function parseNodeCore(index, version, file) {
  if (!index || typeof index !== "object" || Array.isArray(index) || Object.keys(index).length === 0) {
    throw new IncompleteScan(`the Node.js core list ${file}: empty or not an object`);
  }
  const findings = [];
  for (const [key, entry] of Object.entries(index)) {
    let affected;
    try {
      affected = satisfies(version, entry.vulnerable) && !(entry.patched && satisfies(version, entry.patched));
    } catch (err) {
      throw new IncompleteScan(`the Node.js core list ${file}, entry ${key}: ${err.message}`);
    }
    if (!affected) continue;
    const cves = (entry.cve ?? []).filter(Boolean);
    const severity = normalSeverity(entry.severity);
    findings.push({
      scope: "node",
      id: `NSWG-CORE-${key}`,
      aliases: cves,
      package: "node",
      version,
      fixed: entry.patched ?? "",
      severity,
      where: "Node.js",
      url: entry.ref || (cves[0] ? advisoryUrl(cves[0]) : "https://github.com/nodejs/security-wg/tree/main/vuln/core"),
      blocks: highOrWorse(severity),
    });
  }
  return {
    findings,
    scan: `Node.js ${version} (security WG list, ${Object.keys(index).length} advisories): ${findings.length} affect it`,
  };
}

/** A repository's published security advisories that cover the version Stuga pins. */
export function parseAdvisories(advisories, name, version, file) {
  if (!Array.isArray(advisories)) throw new IncompleteScan(`advisories of ${name} ${file}: not a list`);
  const findings = [];
  for (const a of advisories) {
    if (a.state && a.state !== "published") continue;
    if (a.withdrawn_at) continue;
    const ranges = (a.vulnerabilities ?? []).map((v) => v.vulnerable_version_range).filter(Boolean);
    let affected = ranges.length === 0;
    for (const range of ranges) {
      try {
        affected ||= satisfies(version, range);
      } catch {
        // A range this gate cannot read is a human's to check.
        affected = true;
      }
    }
    if (!affected) continue;
    findings.push({
      scope: "watch",
      id: a.ghsa_id,
      aliases: a.cve_id ? [a.cve_id] : [],
      package: name,
      version,
      fixed: (a.vulnerabilities ?? []).map((v) => v.patched_versions).filter(Boolean).join(", "),
      severity: normalSeverity(a.severity),
      where: `${name} advisories`,
      url: a.html_url || advisoryUrl(a.ghsa_id),
      blocks: false,
      watch: true,
    });
  }
  return { findings, scan: `${name} ${version} (repository advisories, ${advisories.length}): ${findings.length} cover it` };
}

/** Items the watch found by other means, such as a newer Go patch release. */
export function parseWatch(items, file) {
  if (!Array.isArray(items)) throw new IncompleteScan(`watch ${file}: not a list`);
  const findings = items.map((item, i) => {
    if (typeof item?.id !== "string" || !item.id || typeof item.package !== "string" || !item.package) {
      throw new IncompleteScan(`watch ${file}, item ${i}: needs an id and a package`);
    }
    return {
      scope: "watch",
      id: item.id,
      aliases: [],
      package: item.package,
      version: String(item.version ?? ""),
      fixed: String(item.fixed ?? ""),
      severity: normalSeverity(item.severity),
      where: String(item.where ?? "watch"),
      url: String(item.url ?? ""),
      blocks: false,
      watch: true,
    };
  });
  return { findings, scan: `${basename(file)} (watch): ${findings.length} items` };
}

// ---- exceptions

const sameId = (a, b) => a.toUpperCase() === b.toUpperCase();

function matches(entry, finding) {
  return (
    entry.scope === finding.scope &&
    entry.package === finding.package &&
    [finding.id, ...finding.aliases].some((id) => sameId(id, entry.id))
  );
}

/**
 * Checks every entry's shape, expiry and length. An entry is judged against the findings of the
 * scopes this run scanned: it may last no longer than the fix target of the worst one it matches.
 */
export function checkExceptions(entries, findings, { today, scanned }) {
  const errors = [];
  const warnings = [];
  const expiring = [];
  if (!Array.isArray(entries)) return { errors: ["accepted-risks.json is not a list"], warnings, expiring, refused: [], active: [] };
  const seen = new Set();
  const active = [];
  const refused = [];
  entries.forEach((entry, i) => {
    const name = `entry ${i + 1}${typeof entry?.id === "string" ? ` (${entry.id})` : ""}`;
    const refuse = (why) => {
      errors.push(`${name}: ${why}`);
      refused.push({ ...entry, why });
    };
    const problems = [];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${name}: not an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!(key in EXCEPTION_KEYS)) problems.push(`unknown key "${key}"`);
    }
    for (const key of REQUIRED_KEYS) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) problems.push(`needs "${key}"`);
    }
    for (const [key, max] of Object.entries(EXCEPTION_KEYS)) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") problems.push(`"${key}" is not a string`);
      else if (typeof entry[key] === "string" && entry[key].length > max) {
        problems.push(`"${key}" is longer than ${max} characters`);
      }
    }
    if (typeof entry.id === "string" && /\s/.test(entry.id)) problems.push(`"id" has a space`);
    if (typeof entry.scope === "string" && !SCOPES.includes(entry.scope)) {
      problems.push(`"scope" is ${entry.scope}, not one of ${SCOPES.join(", ")}`);
    }
    const added = parseDate(entry.added);
    const expires = parseDate(entry.expires);
    if (typeof entry.added === "string" && added === null) problems.push(`"added" is not a date such as 2026-01-31`);
    if (typeof entry.expires === "string" && expires === null) problems.push(`"expires" is not a date such as 2026-01-31`);
    if (added !== null && added > parseDate(today)) problems.push(`"added" is after today`);
    if (added !== null && expires !== null && expires <= added) problems.push(`"expires" is not after "added"`);
    const key = `${entry.scope} ${entry.package} ${String(entry.id).toUpperCase()}`;
    if (seen.has(key)) problems.push("repeats an earlier entry");
    seen.add(key);
    if (problems.length > 0) {
      errors.push(`${name}: ${problems.join("; ")}`);
      return;
    }
    const days = daysBetween(entry.added, entry.expires);
    const left = daysBetween(today, entry.expires);
    if (left <= 0) {
      refuse(`expired on ${entry.expires}`);
      return;
    }
    if (days > FIX_DAYS.OTHER) {
      refuse(`lasts ${days} days, more than the ${FIX_DAYS.OTHER} any exception may`);
      return;
    }
    const matched = findings.filter((f) => matches(entry, f));
    if (scanned.has(entry.scope)) {
      if (matched.length === 0) warnings.push(`${name}: matches nothing ${entry.scope} found; remove it once that is settled`);
      const nearest = strictest(matched);
      if (nearest && days > fixDays(nearest)) {
        refuse(`lasts ${days} days, more than the ${fixDays(nearest)} a ${judged(nearest)} finding may wait`);
        return;
      }
    }
    if (left <= EXPIRY_WARNING_DAYS) {
      warnings.push(`${name}: expires on ${entry.expires}, in ${left} day${left === 1 ? "" : "s"}`);
      expiring.push({ ...entry, left });
    }
    active.push({ ...entry, left, matched: matched.length });
  });
  return { errors, warnings, expiring, refused, active };
}

// ---- the verdict

/**
 * Marks each finding accepted when an active exception covers it. What still blocks, or is watched,
 * is what the gate fails on and the watch keeps an issue for.
 */
export function judge(findings, active) {
  for (const f of findings) {
    f.accepted = active.find((entry) => matches(entry, f));
  }
  return {
    blocking: findings.filter((f) => f.blocks && !f.accepted),
    watched: findings.filter((f) => f.watch && !f.accepted),
  };
}

/** The order rows are listed in: an unrated finding may be as bad as a high one. */
const LISTED = ["CRITICAL", "HIGH", "UNKNOWN", "MEDIUM", "LOW"];

/** Rows that differ only in where they were found become one row, the worst first. */
function merge(findings) {
  const rows = new Map();
  for (const f of findings) {
    const key = [f.scope, f.id, f.package, f.version, f.fixed, f.severity, f.blocks, Boolean(f.accepted)].join("\u0000");
    const row = rows.get(key);
    if (row) {
      if (!row.wheres.includes(f.where)) row.wheres.push(f.where);
    } else rows.set(key, { ...f, wheres: [f.where] });
  }
  const listed = (row) => LISTED.indexOf(judged(row));
  return [...rows.values()].sort(
    (a, b) => listed(a) - listed(b) || a.id.localeCompare(b.id) || a.package.localeCompare(b.package),
  );
}

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ") || "–";

function table(rows) {
  const lines = ["| ID | Package | Version | Fixed in | Severity | Where |", "|---|---|---|---|---|---|"];
  for (const r of rows) {
    const id = r.url ? `[${cell(r.id)}](${r.url})` : cell(r.id);
    const also = r.aliases.length ? ` (${r.aliases.slice(0, 3).map(cell).join(", ")})` : "";
    const severity = r.severity === "UNKNOWN" ? "unrated" : r.severity;
    const where = cell(r.wheres.join(", "));
    lines.push(`| ${id}${also} | ${cell(r.package)} | ${cell(r.version)} | ${cell(r.fixed)} | ${severity} | ${where} |`);
  }
  return lines.join("\n");
}

/** The step summary: what blocks, what is accepted, what is only reported, and what was scanned. */
export function renderSummary({ findings, blocking, watched, exceptions, scans, warnings, errors }) {
  const out = [];
  if (errors.length > 0) out.push(`### Vulnerability gate: cannot judge this run`, "", ...errors.map((e) => `- ${e}`), "");
  else if (blocking.length > 0) {
    const n = merge(blocking).length;
    out.push(`### Vulnerability gate: ${n} finding${n === 1 ? " blocks" : "s block"} a release`, "");
  } else out.push("### Vulnerability gate: nothing blocks a release", "");
  if (blocking.length > 0) out.push("**Blocking**", "", table(merge(blocking)), "");
  if (watched.length > 0) out.push("**Watched**", "", table(merge(watched)), "");
  const accepted = findings.filter((f) => f.accepted);
  if (exceptions.active.length > 0) {
    out.push("**Accepted risks**", "", "| ID | Package | Scope | Expires | Days left | Matches | Issue |");
    out.push("|---|---|---|---|---|---|---|");
    for (const e of exceptions.active) {
      const row = [cell(e.id), cell(e.package), e.scope, e.expires, e.left, e.matched, cell(e.issue)];
      out.push(`| ${row.join(" | ")} |`);
    }
    out.push("");
  }
  const reported = merge(findings.filter((f) => !f.blocks && !f.watch && !f.accepted));
  if (reported.length > 0) {
    const shown = reported.slice(0, REPORTED_ROWS);
    const more = reported.length - shown.length;
    out.push(`<details><summary>Reported, not blocking: ${reported.length}</summary>`, "", table(shown), "");
    if (more > 0) out.push(`And ${more} more, none more severe than these.`, "");
    out.push("</details>", "");
  }
  if (accepted.length > 0) out.push(`Accepted findings: ${merge(accepted).length}.`, "");
  if (warnings.length > 0) out.push("**Warnings**", "", ...warnings.map((w) => `- ${w}`), "");
  out.push("**Scans**", "", ...scans.map((s) => `- ${s}`), "");
  return out.join("\n");
}

// ---- issues

const marker = (key) => `<!-- ${LABEL}: ${key} -->`;
const markerOf = (body) => /<!-- vuln-watch: (.+?) -->/.exec(body ?? "")?.[1];

function issueFor(rows, opened) {
  const first = rows[0];
  const nearest = strictest(rows);
  const packages = [...new Set(rows.map((r) => `${r.package} ${r.version}`.trim()))];
  const title = `${first.id}: ${packages.slice(0, 3).join(", ")}${packages.length > 3 ? ", …" : ""}`;
  const lines = [marker(first.id), table(merge(rows)), ""];
  const days = fixDays(nearest);
  const severity = judged(nearest) === "UNKNOWN" ? "unrated" : judged(nearest);
  lines.push(`Fix target: ${days} days (${severity}), by ${addDays(opened, days)}.`);
  const fix = first.watch ? "Move the pin" : "Fix it";
  lines.push(`${fix} in a release, or accept it in \`.github/security/accepted-risks.json\` for no longer than that.`);
  lines.push("The daily watch closes this once it clears.");
  lines.push("Whether it can be exploited goes in a draft security advisory, not here.");
  return { title, body: lines.join("\n") };
}

const reminderKey = (entry) => `accepted ${entry.scope} ${entry.package} ${entry.id}`;

function expiringIssue(entry) {
  const key = reminderKey(entry);
  return {
    key,
    title: `Accepted risk ${entry.id} (${entry.package}) expires ${entry.expires}`,
    body: [
      marker(key),
      `The exception for ${entry.id} in ${entry.package} (${entry.scope}) expires on ${entry.expires}.`,
      "Fix it before then, or the gate blocks every release.",
    ].join("\n"),
  };
}

/** GitHub's REST API with GITHUB_TOKEN, or a stand-in for tests. */
export function githubApi({ token, repository, fetchImpl = fetch }) {
  return async (method, path, body) => {
    const url = path.startsWith("/repos/") ? path : `/repos/${repository}${path}`;
    const response = await fetchImpl(`https://api.github.com${url}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
}

/**
 * One issue per blocking or watched ID and per exception about to expire, each found again by the
 * marker in its body: opened or reopened while it lasts, closed once it is gone. An exception's
 * closes with why: the gate refused it (`refused`, with its `why`), or it was renewed or removed.
 */
export async function syncIssues({ blocking, watched, expiring, refused = [], api, owner, today }) {
  const log = [];
  if (!(await api("GET", `/labels/${LABEL}`))) {
    await api("POST", "/labels", { name: LABEL, color: "b60205", description: "Opened by the daily vulnerability watch" });
  }
  const issues = [];
  for (let page = 1; ; page++) {
    const batch = await api("GET", `/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    issues.push(...(batch ?? []).filter((i) => !i.pull_request));
    if (!batch || batch.length < 100) break;
  }
  const byKey = new Map();
  for (const issue of issues.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))) {
    const key = markerOf(issue.body);
    if (!key) continue;
    const kept = byKey.get(key);
    if (!kept || kept.state !== "open" || issue.state === "open") byKey.set(key, issue);
  }
  const wanted = new Map();
  for (const f of [...blocking, ...watched]) {
    const rows = wanted.get(f.id)?.rows ?? [];
    rows.push(f);
    wanted.set(f.id, { rows });
  }
  for (const [key, { rows }] of wanted) {
    const existing = byKey.get(key);
    const opened = existing?.state === "open" ? existing.created_at.slice(0, 10) : today;
    const { title, body } = issueFor(rows, opened);
    if (!existing) {
      const created = await api("POST", "/issues", { title, body, labels: [LABEL], ...(owner ? { assignees: [owner] } : {}) });
      log.push(`opened #${created.number}: ${title}`);
    } else if (existing.state !== "open") {
      await api("PATCH", `/issues/${existing.number}`, { title, body, state: "open", ...(owner ? { assignees: [owner] } : {}) });
      await api("POST", `/issues/${existing.number}/comments`, { body: `Found again on ${today}.` });
      log.push(`reopened #${existing.number}: ${title}`);
    } else if (existing.title !== title || existing.body !== body) {
      await api("PATCH", `/issues/${existing.number}`, { title, body });
      log.push(`updated #${existing.number}: ${title}`);
    }
  }
  for (const entry of expiring) {
    const { key, title, body } = expiringIssue(entry);
    wanted.set(key, {});
    const existing = byKey.get(key);
    if (!existing) {
      const created = await api("POST", "/issues", { title, body, labels: [LABEL], ...(owner ? { assignees: [owner] } : {}) });
      log.push(`opened #${created.number}: ${title}`);
    } else if (existing.state !== "open") {
      await api("PATCH", `/issues/${existing.number}`, { title, body, state: "open" });
      log.push(`reopened #${existing.number}: ${title}`);
    }
  }
  const refusedWhy = new Map(refused.map((entry) => [reminderKey(entry), entry.why]));
  for (const [key, issue] of byKey) {
    if (issue.state !== "open" || wanted.has(key)) continue;
    const why = refusedWhy.get(key);
    const note = why
      ? `The exception ${why}, so it accepts nothing now.`
      : key.startsWith("accepted ")
        ? `Cleared on ${today}: the exception was renewed or removed.`
        : `Cleared on ${today}: no longer found, or accepted.`;
    await api("POST", `/issues/${issue.number}/comments`, { body: note });
    await api("PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    log.push(`closed #${issue.number}: ${issue.title}`);
  }
  return log;
}

// ---- the command

function nodeVersionPin() {
  const pins = readFileSync(fileURLToPath(new URL("../packaging/versions.env", import.meta.url)), "utf8");
  const version = /^NODE_VERSION=(\S+)$/m.exec(pins)?.[1];
  if (!version) throw new IncompleteScan("packaging/versions.env sets no NODE_VERSION");
  return version;
}

/** Reads every scan; an incomplete one is recorded, not thrown, so the summary names them all. */
function readScans(values) {
  const findings = [];
  const scans = [];
  const warnings = [];
  const errors = [];
  const scanned = new Set();
  const take = (scope, read) => {
    try {
      const result = read();
      findings.push(...result.findings);
      scans.push(result.scan);
      if (result.warning) warnings.push(result.warning);
      scanned.add(scope);
    } catch (err) {
      if (!(err instanceof IncompleteScan)) throw err;
      errors.push(err.message);
    }
  };
  if (values.osv?.length && !values.lockfile) errors.push("--osv needs --lockfile, the lockfile it scanned");
  for (const file of values.osv ?? []) {
    if (!values.lockfile) break;
    take("lockfile", () => {
      let lockfileText;
      try {
        lockfileText = readFileSync(values.lockfile, "utf8");
      } catch (err) {
        throw new IncompleteScan(`lockfile ${values.lockfile}: ${err.message}`);
      }
      return parseOsv(readJson(file, "osv-scanner"), { lockfile: values.lockfile, lockfileText });
    });
  }
  for (const file of values.govulncheck ?? []) {
    take("go", () => {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        throw new IncompleteScan(`govulncheck ${file}: ${err.code === "ENOENT" ? "missing" : err.message}`);
      }
      return parseGovulncheck(text, file);
    });
  }
  for (const file of values.trivy ?? []) take("image", () => parseTrivy(readJson(file, "trivy"), file));
  for (const file of values["node-core"] ?? []) {
    take("node", () => parseNodeCore(readJson(file, "the Node.js core list"), values["node-version"] ?? nodeVersionPin(), file));
  }
  for (const spec of values.advisories ?? []) {
    take("watch", () => {
      const m = /^(.+)@([^@=]+)=(.+)$/.exec(spec);
      if (!m) throw new IncompleteScan(`--advisories takes <name>@<version>=<file>, not "${spec}"`);
      return parseAdvisories(readJson(m[3], `advisories of ${m[1]}`), m[1], m[2], m[3]);
    });
  }
  for (const file of values.watch ?? []) take("watch", () => parseWatch(readJson(file, "watch"), file));
  if (scans.length === 0 && errors.length === 0) errors.push("no scans given");
  return { findings, scans, warnings, errors, scanned };
}

/** A workflow command: GitHub reads %, CR and LF as escapes in its text, and : and , in a property too. */
const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const annotation = (level, title, message) =>
  `::${level} title=${escapeData(title).replace(/:/g, "%3A").replace(/,/g, "%2C")}::${escapeData(message)}`;

function plain(f) {
  const state = f.accepted ? "accepted" : f.blocks ? "BLOCKS" : f.watch ? "watch" : "reported";
  const fixed = f.fixed ? ` (fixed in ${f.fixed})` : "";
  return `${state.padEnd(8)} ${f.id} ${f.package} ${f.version}${fixed} ${f.severity} ${f.where}`;
}

export async function main(argv, env = process.env, fetchImpl = fetch) {
  const { values } = parseArgs({
    args: argv,
    options: {
      osv: { type: "string", multiple: true },
      lockfile: { type: "string" },
      govulncheck: { type: "string", multiple: true },
      trivy: { type: "string", multiple: true },
      "node-core": { type: "string", multiple: true },
      "node-version": { type: "string" },
      advisories: { type: "string", multiple: true },
      watch: { type: "string", multiple: true },
      accepted: { type: "string" },
      today: { type: "string" },
      issues: { type: "boolean" },
    },
  });
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  if (parseDate(today) === null) throw new Error(`--today takes a date such as 2026-01-31, not "${today}"`);
  const { findings, scans, warnings, errors, scanned } = readScans(values);
  const scansJudged = errors.length === 0;

  const acceptedFile = values.accepted ?? fileURLToPath(new URL("../.github/security/accepted-risks.json", import.meta.url));
  let entries = [];
  try {
    entries = readJson(acceptedFile, "accepted risks");
  } catch (err) {
    errors.push(err.message);
  }
  const exceptions = checkExceptions(entries, findings, { today, scanned });
  errors.push(...exceptions.errors.map((e) => `accepted-risks.json ${e}`));
  warnings.push(...exceptions.warnings.map((w) => `accepted-risks.json ${w}`));
  const { blocking, watched } = judge(findings, exceptions.active);

  const summary = renderSummary({ findings, blocking, watched, exceptions, scans, warnings, errors });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  const annotate = env.GITHUB_ACTIONS === "true";
  const lines = [];
  const reported = findings.filter((f) => !f.blocks && !f.watch && !f.accepted);
  for (const f of merge(findings.filter((f) => !reported.includes(f)))) lines.push(plain({ ...f, where: f.wheres.join(", ") }));
  if (reported.length > 0) {
    lines.push(`reported ${merge(reported).length} findings that do not block, listed in the step summary`);
  }
  for (const s of scans) lines.push(`scan     ${s}`);
  for (const w of warnings) lines.push(annotate ? annotation("warning", "Vulnerability gate", w) : `warning: ${w}`);
  for (const e of errors) lines.push(annotate ? annotation("error", "Vulnerability gate", e) : `error: ${e}`);
  if (annotate) {
    for (const f of merge(blocking)) {
      const where = f.wheres.join(", ");
      lines.push(annotation("error", `${f.id} blocks a release`, `${f.package} ${f.version} ${f.severity} in ${where}`));
    }
  }

  // Wrong exceptions still let the watch keep its issues: an entry the gate refuses accepts nothing.
  if (errors.length > 0 && !(values.issues && scansJudged)) {
    lines.push("result: this run cannot be judged; fix the scan or the exceptions");
    return { code: 2, output: lines.join("\n") };
  }
  if (values.issues) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) throw new Error("--issues needs GITHUB_TOKEN and GITHUB_REPOSITORY");
    if (!env.SECURITY_OWNER) {
      const unset = "SECURITY_OWNER is not set, so issues go unassigned";
      lines.push(annotate ? annotation("warning", "Vulnerability watch", unset) : `warning: ${unset}`);
    }
    const api = githubApi({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, fetchImpl });
    const { expiring, refused } = exceptions;
    const log = await syncIssues({ blocking, watched, expiring, refused, api, owner: env.SECURITY_OWNER, today });
    lines.push(...log.map((l) => `issue    ${l}`));
    const counts = `${merge(blocking).length} blocking and ${merge(watched).length} watched findings`;
    if (errors.length > 0) {
      lines.push(`result: ${counts}, ${log.length} issue changes; fix the exceptions`);
      return { code: 2, output: lines.join("\n") };
    }
    lines.push(`result: ${counts}, ${log.length} issue changes`);
    return { code: 0, output: lines.join("\n") };
  }
  const n = merge(blocking).length;
  lines.push(n > 0 ? `result: ${n} finding${n === 1 ? " blocks" : "s block"} a release` : "result: nothing blocks a release");
  return { code: blocking.length > 0 ? 1 : 0, output: lines.join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    ({ code, output }) => {
      console.log(output);
      process.exitCode = code;
    },
    (err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = 2;
    },
  );
}
