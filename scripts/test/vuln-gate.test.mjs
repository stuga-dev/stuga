// node --test scripts/test/vuln-gate.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  IncompleteScan,
  checkExceptions,
  githubApi,
  judge,
  jsonStream,
  lockfilePackages,
  main,
  parseAdvisories,
  parseGovulncheck,
  parseNodeCore,
  parseOsv,
  parseTrivy,
  parseWatch,
  renderSummary,
  satisfies,
  syncIssues,
} from "../vuln-gate.mjs";

const script = new URL("../vuln-gate.mjs", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "stuga-vuln-gate-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TODAY = "2026-10-11";

// ---- fixtures, shaped as each scanner writes them

const LOCKFILE = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.6.0
        version: 12.6.0

packages:

  pnpm@12.6.0:
    resolution: {integrity: sha512-x}
    hasBin: true

snapshots:

  pnpm@12.6.0: {}

---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      sharp:
        specifier: ^0.34.0
        version: 0.34.1

packages:

  '@img/colour@1.0.0':
    resolution: {integrity: sha512-y}

  katex@0.16.47:
    resolution: {integrity: sha512-z}

  sharp@0.34.1:
    resolution: {integrity: sha512-w}

snapshots:

  '@img/colour@1.0.0': {}

  sharp@0.34.1:
    dependencies:
      '@img/colour': 1.0.0
`;

function osvVuln(id, { severity, aliases = [], fixed, name } = {}) {
  return {
    id,
    aliases,
    affected: [{ package: { ecosystem: "npm", name }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed }] }] }],
    database_specific: severity ? { severity } : {},
  };
}

function osvReport({ sharp = [], katex = [], extra = [] } = {}) {
  const pkg = (name, version, vulns) => ({
    package: { name, version, ecosystem: "npm" },
    ...(vulns.length
      ? {
          vulnerabilities: vulns.map((v) => v.vuln),
          groups: vulns.map((v) => ({ ids: [v.vuln.id], aliases: [v.vuln.id, ...v.vuln.aliases], max_severity: v.score ?? "" })),
        }
      : {}),
  });
  return {
    results: [
      {
        source: { path: "/src/pnpm-lock.yaml", type: "lockfile" },
        packages: [
          pkg("pnpm", "12.6.0", []),
          pkg("@img/colour", "1.0.0", []),
          pkg("katex", "0.16.47", katex),
          pkg("sharp", "0.34.1", sharp),
          ...extra.map((name) => pkg(name, "1.0.0", [])),
        ],
      },
    ],
  };
}

const osvOf = (report) => parseOsv(report, { lockfile: "/src/pnpm-lock.yaml", lockfileText: LOCKFILE });

function goStream({ level = "symbol", mode = "source", sbom = true, findings = [] } = {}) {
  const values = [
    { config: { protocol_version: "v1.0.0", scanner_name: "govulncheck", scanner_version: "v1.9.0", go_version: "go1.27.2", scan_level: level, scan_mode: mode } },
    { progress: { message: "Scanning your code" } },
    ...(sbom ? [{ SBOM: { go_version: "go1.27.2", modules: [{ path: "github.com/fatedier/frp" }, { path: "stdlib", version: "v1.27.2" }] } }] : []),
    ...findings.flatMap((f) => [
      { osv: { id: f.id, aliases: f.aliases ?? [] } },
      { finding: { osv: f.id, fixed_version: f.fixed ?? "v1.27.3", trace: [f.trace] } },
    ]),
  ];
  return values.map((v) => JSON.stringify(v, null, 2)).join("\n");
}

const STDLIB_CALL = { module: "stdlib", version: "v1.27.2", package: "net/http", function: "Serve" };
const STDLIB_IMPORT = { module: "stdlib", version: "v1.27.2", package: "net/http" };
const MODULE_ONLY = { module: "golang.org/x/net", version: "v0.56.0" };
const X_NET_CALL = { module: "golang.org/x/net", version: "v0.56.0", package: "golang.org/x/net/http2", function: "ServeConn" };

function trivyReport({ os = { Family: "debian", Name: "12.15" }, results } = {}) {
  return {
    SchemaVersion: 2,
    ArtifactName: "ghcr.io/stuga-dev/stuga-postgres:0.0.0-drill",
    ArtifactType: "container_image",
    Metadata: { ...(os ? { OS: os } : {}), ImageConfig: { os: "linux", architecture: "amd64" } },
    Results: results ?? [
      {
        Target: "ghcr.io/stuga-dev/stuga-postgres:0.0.0-drill (debian 12.15)",
        Class: "os-pkgs",
        Type: "debian",
        Vulnerabilities: [
          { VulnerabilityID: "CVE-2026-13221", VendorIDs: ["DLA-4821-1"], PkgName: "perl-base", InstalledVersion: "5.36.0-7+deb12u3", FixedVersion: "5.36.0-7+deb12u4", Status: "fixed", Severity: "CRITICAL" },
          { VulnerabilityID: "CVE-2026-1000", PkgName: "libc6", InstalledVersion: "2.36-9", Status: "affected", Severity: "HIGH" },
          { VulnerabilityID: "CVE-2026-1001", PkgName: "tzdata", InstalledVersion: "2025a", FixedVersion: "2025b", Status: "fixed", Severity: "MEDIUM" },
        ],
      },
      {
        Target: "usr/local/bin/gosu",
        Class: "lang-pkgs",
        Type: "gobinary",
        Vulnerabilities: [{ VulnerabilityID: "CVE-2026-2000", PkgName: "stdlib", InstalledVersion: "v1.24.6", FixedVersion: "1.25.1", Status: "fixed", Severity: "CRITICAL" }],
      },
    ],
  };
}

/** A fixable Debian finding trivy has no severity for, as DLAs often are. */
const UNRATED_DLA = { VulnerabilityID: "DLA-4783-1", PkgName: "libssl3", InstalledVersion: "3.0.17-1~deb12u2", FixedVersion: "3.0.17-1~deb12u3", Status: "fixed", Severity: "UNKNOWN" };

const NODE_CORE = {
  1: { cve: ["CVE-2017-1000381"], vulnerable: "8.x || 7.x", patched: "^8.1.4 || ^7.10.1", severity: "high" },
  186: { cve: ["CVE-2026-58040"], vulnerable: "22.x || 24.x || 26.x", patched: "^22.23.2 || ^24.18.1 || ^26.5.1", severity: "high" },
  187: { cve: ["CVE-2026-58041"], vulnerable: "26.x", patched: "^26.5.1", severity: "low" },
  188: { cve: [], vulnerable: ">= 26.0.0 <26.6.0", patched: "^26.6.0", severity: "unknown" },
  189: { cve: ["CVE-2026-58099"], vulnerable: "<= 25", patched: "", severity: "critical" },
};

function entry(overrides = {}) {
  return { id: "GHSA-aaaa-bbbb-cccc", package: "sharp", scope: "lockfile", reason: "dev-only, not in any bundle", added: "2026-10-01", expires: "2026-10-31", ...overrides };
}

// ---- ranges

test("version ranges as the Node.js list and GitHub advisories write them", () => {
  assert.equal(satisfies("26.10.0", "22.x || 24.x || 26.x"), true);
  assert.equal(satisfies("26.10.0", "^22.23.2 || ^24.18.1 || ^26.5.1"), true);
  assert.equal(satisfies("26.5.0", "^26.5.1"), false);
  assert.equal(satisfies("10.9.0", ">= 10.9.0"), true);
  assert.equal(satisfies("10.20.0", "<= 10"), true);
  assert.equal(satisfies("11.0.0", "<= 10"), false);
  assert.equal(satisfies("6.1.9", ">=6.0.0 <6.2.0 || 5.x"), true);
  assert.equal(satisfies("0.10.48", "^0.10.48"), true);
  assert.equal(satisfies("0.11.0", "^0.10.48"), false);
  assert.equal(satisfies("0.70.0", ">= 0.53.0, <= 0.70.0"), true);
  assert.equal(satisfies("0.71.0", ">= 0.53.0, <= 0.70.0"), false);
  assert.equal(satisfies("1.2.4", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
  assert.throws(() => satisfies("1.0.0", "1.0.0 - 2.0.0"), /unknown version range/);
  assert.throws(() => satisfies("1.0.0", "latest"), /unknown version range/);
});

// ---- the lockfile and osv-scanner

test("the lockfile lists the packages of every document, quoted or not", () => {
  assert.deepEqual([...lockfilePackages(LOCKFILE)].sort(), ["@img/colour@1.0.0", "katex@0.16.47", "pnpm@12.6.0", "sharp@0.34.1"]);
});

test("npm: high and critical block, dev dependencies too; lower is reported", () => {
  const { findings, scan } = osvOf(
    osvReport({
      sharp: [{ vuln: osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "HIGH", aliases: ["CVE-2026-1"], fixed: "0.35.5", name: "sharp" }) }],
      katex: [{ vuln: osvVuln("GHSA-238p-pmpm-9mq7", { severity: "LOW", fixed: "0.18.2", name: "katex" }) }],
    }),
  );
  assert.match(scan, /4 packages, every one pnpm-lock.yaml lists/);
  const sharp = findings.find((f) => f.package === "sharp");
  assert.equal(sharp.blocks, true);
  assert.equal(sharp.fixed, "0.35.5");
  assert.deepEqual(sharp.aliases, ["CVE-2026-1"]);
  assert.equal(findings.find((f) => f.package === "katex").blocks, false);
});

test("npm: a missing severity counts as high, and a CVSS score stands in for a label", () => {
  const { findings } = osvOf(
    osvReport({
      sharp: [{ vuln: osvVuln("MAL-2026-1", { name: "sharp", fixed: "0.35.5" }) }],
      katex: [{ vuln: osvVuln("GHSA-dddd-eeee-ffff", { name: "katex", fixed: "0.18.2" }), score: "5.3" }],
    }),
  );
  const sharp = findings.find((f) => f.id === "MAL-2026-1");
  assert.equal(sharp.severity, "UNKNOWN");
  assert.equal(sharp.blocks, true);
  const katex = findings.find((f) => f.id === "GHSA-dddd-eeee-ffff");
  assert.equal(katex.severity, "MEDIUM");
  assert.equal(katex.blocks, false);
});

test("npm: the worse of the label and the CVSS score counts", () => {
  const { findings } = osvOf(
    osvReport({
      sharp: [
        { vuln: osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "MODERATE", name: "sharp", fixed: "0.35.5" }), score: "7.5" },
        { vuln: osvVuln("GHSA-gggg-hhhh-iiii", { severity: "CRITICAL", name: "sharp", fixed: "0.35.5" }), score: "5.3" },
      ],
      katex: [{ vuln: osvVuln("GHSA-dddd-eeee-ffff", { severity: "HIGH", name: "katex", fixed: "0.18.2" }), score: "9.8" }],
    }),
  );
  assert.deepEqual(findings.map((f) => [f.id, f.severity, f.blocks]), [
    ["GHSA-dddd-eeee-ffff", "CRITICAL", true],
    ["GHSA-aaaa-bbbb-cccc", "HIGH", true],
    ["GHSA-gggg-hhhh-iiii", "CRITICAL", true],
  ]);
});

test("npm: an advisory in no group is judged on its own", () => {
  const report = osvReport();
  const sharp = report.results[0].packages.find((p) => p.package.name === "sharp");
  sharp.vulnerabilities = [
    osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "HIGH", name: "sharp", fixed: "0.35.5" }),
    osvVuln("GHSA-dddd-eeee-ffff", { severity: "LOW", name: "sharp", fixed: "0.35.5" }),
  ];
  const verdict = () => osvOf(report).findings.map((f) => [f.id, f.blocks]);
  assert.deepEqual(verdict(), [["GHSA-aaaa-bbbb-cccc", true], ["GHSA-dddd-eeee-ffff", false]]);
  sharp.groups = [{ ids: ["GHSA-dddd-eeee-ffff"], aliases: [], max_severity: "3.1" }];
  assert.deepEqual(verdict(), [["GHSA-dddd-eeee-ffff", false], ["GHSA-aaaa-bbbb-cccc", true]]);
  sharp.groups = [{ ids: [], aliases: [] }];
  assert.throws(() => osvOf(report), /a group without advisories for sharp@0.34.1/);
});

test("npm: a scan that did not read every package of the lockfile is incomplete", () => {
  const short = osvReport();
  short.results[0].packages = short.results[0].packages.filter((p) => p.package.name !== "sharp");
  assert.throws(() => osvOf(short), (err) => err instanceof IncompleteScan && /read 3 packages, pnpm-lock.yaml lists 4; not read: sharp@0.34.1/.test(err.message));
  assert.throws(() => osvOf(osvReport({ extra: ["left-pad"] })), /not in pnpm-lock.yaml: left-pad@1.0.0/);
  assert.throws(() => osvOf({}), IncompleteScan);
});

// ---- govulncheck

test("Go: a finding the code reaches blocks; one it only imports or requires is reported", () => {
  const { findings, scan } = parseGovulncheck(
    goStream({
      findings: [
        { id: "GO-2026-1", aliases: ["CVE-2026-11"], trace: STDLIB_CALL },
        { id: "GO-2026-2", trace: STDLIB_IMPORT },
        { id: "GO-2026-3", trace: MODULE_ONLY, fixed: "v0.57.0" },
      ],
    }),
    "/tmp/go/govulncheck-frpc-linux-amd64.json",
  );
  assert.match(scan, /^frpc linux\/amd64 \(govulncheck, go1.27.2\): 1 reachable, 1 imported, 1 required$/);
  assert.deepEqual(findings.map((f) => [f.id, f.package, f.blocks]), [
    ["GO-2026-1", "stdlib", true],
    ["GO-2026-2", "stdlib", false],
    ["GO-2026-3", "golang.org/x/net", false],
  ]);
  assert.deepEqual(findings[0].aliases, ["CVE-2026-11"]);
});

test("Go: one ID found at several levels of a module is judged at the deepest", () => {
  const text = goStream({ findings: [{ id: "GO-2026-1", trace: MODULE_ONLY }, { id: "GO-2026-1", trace: X_NET_CALL }] });
  const { findings } = parseGovulncheck(text, "govulncheck-frpc-darwin-arm64.json");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocks, true);
});

/** GO-2026-1 reachable in the standard library and in golang.org/x/net, as one advisory can be. */
const twoModules = () =>
  parseGovulncheck(
    goStream({
      findings: [
        { id: "GO-2026-1", trace: STDLIB_CALL },
        { id: "GO-2026-1", trace: MODULE_ONLY, fixed: "v0.57.0" },
        { id: "GO-2026-1", trace: X_NET_CALL, fixed: "v0.57.0" },
      ],
    }),
    "govulncheck-frpc-linux-amd64.json",
  );

test("Go: one ID in two modules is a finding in each, and an exception for one leaves the other blocking", () => {
  const { findings, scan } = twoModules();
  assert.match(scan, /: 2 reachable, 0 imported, 0 required$/);
  assert.deepEqual(findings.map((f) => [f.id, f.package, f.version, f.fixed, f.blocks]), [
    ["GO-2026-1", "stdlib", "v1.27.2", "v1.27.3", true],
    ["GO-2026-1", "golang.org/x/net", "v0.56.0", "v0.57.0", true],
  ]);
  const result = checkExceptions([entry({ id: "GO-2026-1", package: "stdlib", scope: "go" })], findings, { today: TODAY, scanned: new Set(["go"]) });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(judge(findings, result.active).blocking.map((f) => f.package), ["golang.org/x/net"]);
});

test("Go: a scan that is not source at symbol level, or never started, is incomplete", () => {
  assert.throws(() => parseGovulncheck(goStream({ mode: "binary" }), "x.json"), /a binary scan at symbol level/);
  assert.throws(() => parseGovulncheck(goStream({ level: "module" }), "x.json"), /not source at symbol level/);
  assert.throws(() => parseGovulncheck("", "x.json"), /no config/);
  assert.throws(() => parseGovulncheck(goStream({ sbom: false }), "x.json"), /x.json: no SBOM, so it never loaded the code/);
  assert.throws(() => parseGovulncheck('{"config": {', "x.json"), /not a JSON stream/);
});

test("a JSON stream splits on its top-level values, braces inside strings included", () => {
  assert.deepEqual(jsonStream('{"a": "}{"}\n{"b": [1, {"c": "\\"}"}]}'), [{ a: "}{" }, { b: [1, { c: '"}' }] }]);
});

// ---- trivy

test("images: an OS package at high or worse with a Debian fix blocks; the rest is reported", () => {
  const { findings, scan } = parseTrivy(trivyReport(), "trivy.json");
  assert.match(scan, /linux\/amd64 \(trivy, debian 12.15\): 4 findings, 2 in its OS packages with a fix/);
  const verdict = Object.fromEntries(findings.map((f) => [f.id, f.blocks]));
  assert.deepEqual(verdict, { "CVE-2026-13221": true, "CVE-2026-1000": false, "CVE-2026-1001": false, "CVE-2026-2000": false });
  assert.deepEqual(findings[0].aliases, ["DLA-4821-1"]);
});

test("images: an OS package finding without a severity is reported, fixed or not", () => {
  const report = trivyReport();
  report.Results[0].Vulnerabilities.push(UNRATED_DLA);
  const dla = parseTrivy(report, "t.json").findings.find((f) => f.id === "DLA-4783-1");
  assert.equal(dla.severity, "UNKNOWN");
  assert.equal(dla.blocks, false);
});

test("images: no operating system or no OS packages result is an incomplete scan", () => {
  assert.throws(() => parseTrivy(trivyReport({ os: null }), "t.json"), /no operating system detected/);
  assert.throws(() => parseTrivy(trivyReport({ results: [] }), "t.json"), /no result for the debian 12.15 packages/);
  assert.throws(() => parseTrivy({ Results: [] }, "t.json"), /not a trivy report/);
  assert.match(parseTrivy(trivyReport({ os: { Family: "debian", Name: "10", EOSL: true } }), "t.json").warning, /past its end of support/);
});

// ---- Node.js and the watch

test("Node.js: an advisory covering the version blocks at high, critical or unknown", () => {
  const { findings, scan } = parseNodeCore(NODE_CORE, "26.5.0", "index.json");
  assert.match(scan, /Node.js 26.5.0 \(security WG list, 5 advisories\): 3 affect it/);
  assert.deepEqual(findings.map((f) => [f.id, f.severity, f.blocks]), [
    ["NSWG-CORE-186", "HIGH", true],
    ["NSWG-CORE-187", "LOW", false],
    ["NSWG-CORE-188", "UNKNOWN", true],
  ]);
  assert.equal(parseNodeCore(NODE_CORE, "26.10.0", "index.json").findings.length, 0);
  assert.throws(() => parseNodeCore({ 1: { vulnerable: "8.x - 9.x" } }, "26.10.0", "index.json"), IncompleteScan);
  assert.throws(() => parseNodeCore({}, "26.10.0", "index.json"), IncompleteScan);
});

test("advisories: a published one whose range covers the pin is watched", () => {
  const advisories = [
    { ghsa_id: "GHSA-26gq-p25f-99cp", cve_id: "CVE-2026-73564", severity: "medium", state: "published", vulnerabilities: [{ vulnerable_version_range: ">= 0.53.0, <= 0.70.0", patched_versions: "0.70.1" }] },
    { ghsa_id: "GHSA-new0-0000-0000", severity: "high", state: "published", vulnerabilities: [{ vulnerable_version_range: "<= 0.71.0", patched_versions: "0.71.1" }] },
    { ghsa_id: "GHSA-gone-0000-0000", severity: "high", state: "published", withdrawn_at: "2026-10-01T00:00:00Z", vulnerabilities: [] },
    { ghsa_id: "GHSA-odd0-0000-0000", severity: "low", state: "published", vulnerabilities: [{ vulnerable_version_range: "all of them" }] },
  ];
  const { findings } = parseAdvisories(advisories, "frp", "0.71.0", "frp.json");
  assert.deepEqual(findings.map((f) => [f.id, f.watch, f.blocks]), [
    ["GHSA-new0-0000-0000", true, false],
    ["GHSA-odd0-0000-0000", true, false],
  ]);
});

// ---- exceptions

const sharpHigh = () =>
  osvOf(osvReport({ sharp: [{ vuln: osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "HIGH", aliases: ["CVE-2026-1"], fixed: "0.35.5", name: "sharp" }) }] })).findings;
const scanned = new Set(["lockfile"]);

test("an exception accepts its finding by any alias, and is listed with its days left", () => {
  const findings = sharpHigh();
  const result = checkExceptions([entry({ id: "cve-2026-1" })], findings, { today: TODAY, scanned });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.active[0].left, 20);
  const { blocking } = judge(findings, result.active);
  assert.deepEqual(blocking, []);
});

test("an exception names its scope and package: another package's finding still blocks", () => {
  const findings = sharpHigh();
  const result = checkExceptions([entry({ package: "katex" })], findings, { today: TODAY, scanned });
  assert.equal(judge(findings, result.active).blocking.length, 1);
  assert.match(result.warnings[0], /matches nothing lockfile found/);
});

test("an exception names its scope: the same package and ID found in another still blocks", () => {
  const findings = sharpHigh();
  const result = checkExceptions([entry({ scope: "image" })], findings, { today: TODAY, scanned });
  assert.deepEqual(result.errors, []);
  assert.equal(judge(findings, result.active).blocking.length, 1);
});

test("a malformed exception is refused, every problem named", () => {
  const { errors } = checkExceptions(
    [
      entry({ expiry: "2026-10-31" }),
      entry({ reason: "" }),
      entry({ id: "GHSA-1", added: "2026-02-30" }),
      entry({ id: "GHSA-2", scope: "docker" }),
      entry({ id: "GHSA-3", reason: "x".repeat(501) }),
      entry({ id: "GHSA-4", added: "2026-10-12" }),
      entry({ id: "GHSA-5", expires: "2026-09-30" }),
      entry({ id: "GHSA-6 GHSA-7" }),
      entry({ id: "GHSA-8" }),
      entry({ id: "ghsa-8" }),
      entry({ id: "GHSA-9", package: "p".repeat(201) }),
      entry({ id: "GHSA-10", issue: "#".repeat(201) }),
      entry({ id: `GHSA-${"1".repeat(96)}` }),
      entry({ id: "GHSA-11", scope: "lockfile".repeat(3) }),
      "GHSA-12",
    ],
    [],
    { today: TODAY, scanned },
  );
  const expected = [
    /^entry 1 \(GHSA-aaaa-bbbb-cccc\): unknown key "expiry"$/,
    /^entry 2 .*needs "reason"/,
    /^entry 3 .*"added" is not a date/,
    /^entry 4 .*"scope" is docker/,
    /^entry 5 .*"reason" is longer than 500/,
    /^entry 6 .*"added" is after today/,
    /^entry 7 .*"expires" is not after "added"/,
    /^entry 8 .*"id" has a space/,
    /^entry 10 \(ghsa-8\): repeats an earlier entry$/,
    /^entry 11 .*"package" is longer than 200 characters$/,
    /^entry 12 .*"issue" is longer than 200 characters$/,
    /^entry 13 .*"id" is longer than 100 characters$/,
    /^entry 14 .*"scope" is longer than 20 characters/,
    /^entry 15: not an object$/,
  ];
  assert.equal(errors.length, expected.length, errors.join("\n"));
  expected.forEach((pattern, i) => assert.match(errors[i], pattern));
  assert.match(checkExceptions({}, [], { today: TODAY, scanned }).errors[0], /not a list/);
});

test("an exception is refused once it expires, or when it lasts longer than its finding's fix target", () => {
  const findings = sharpHigh();
  const expired = checkExceptions([entry({ added: "2026-09-01", expires: TODAY })], findings, { today: TODAY, scanned });
  assert.match(expired.errors[0], /expired on 2026-10-11/);
  const long = checkExceptions([entry({ added: "2026-10-01", expires: "2026-11-01" })], findings, { today: TODAY, scanned });
  assert.match(long.errors[0], /lasts 31 days, more than the 30 a HIGH finding may wait/);
  const forever = checkExceptions([entry({ package: "katex", added: "2026-10-01", expires: "2027-01-01" })], findings, { today: TODAY, scanned });
  assert.match(forever.errors[0], /lasts 92 days, more than the 90 any exception may/);
});

test("a critical finding's exception lasts at most 7 days, and one about to expire is a warning", () => {
  const findings = parseTrivy(trivyReport(), "t.json").findings;
  const images = new Set(["image"]);
  const base = { id: "DLA-4821-1", package: "perl-base", scope: "image" };
  const long = checkExceptions([entry({ ...base, added: "2026-10-05", expires: "2026-10-13" })], findings, { today: TODAY, scanned: images });
  assert.match(long.errors[0], /lasts 8 days, more than the 7 a CRITICAL finding may wait/);
  const soon = checkExceptions([entry({ ...base, added: "2026-10-05", expires: "2026-10-12" })], findings, { today: TODAY, scanned: images });
  assert.deepEqual(soon.errors, []);
  assert.match(soon.warnings[0], /expires on 2026-10-12, in 1 day$/);
  assert.equal(soon.expiring.length, 1);
});

test("an exception matching a high and a critical finding lasts at most the critical's 7 days", () => {
  const report = trivyReport();
  const high = { VulnerabilityID: "CVE-2026-13220", VendorIDs: ["DLA-4821-1"], PkgName: "perl-base", InstalledVersion: "5.36.0-7+deb12u3", FixedVersion: "5.36.0-7+deb12u4", Status: "fixed", Severity: "HIGH" };
  report.Results[0].Vulnerabilities.unshift(high);
  const findings = parseTrivy(report, "t.json").findings;
  const both = entry({ id: "DLA-4821-1", package: "perl-base", scope: "image", added: "2026-10-05", expires: "2026-10-13" });
  const result = checkExceptions([both], findings, { today: TODAY, scanned: new Set(["image"]) });
  assert.match(result.errors[0], /lasts 8 days, more than the 7 a CRITICAL finding may wait/);
});

test("an unrated finding counts as high for its exception where it blocks, and as other in an image", () => {
  const npm = osvOf(osvReport({ sharp: [{ vuln: osvVuln("MAL-2026-1", { name: "sharp", fixed: "0.35.5" }) }] })).findings;
  const malware = entry({ id: "MAL-2026-1", added: "2026-10-01", expires: "2026-11-01" });
  assert.match(checkExceptions([malware], npm, { today: TODAY, scanned }).errors[0], /lasts 31 days, more than the 30 a HIGH finding may wait/);

  const report = trivyReport();
  report.Results[0].Vulnerabilities.push(UNRATED_DLA);
  const image = parseTrivy(report, "t.json").findings;
  const dla = entry({ id: "DLA-4783-1", package: "libssl3", scope: "image", added: "2026-09-01", expires: "2026-11-01" });
  assert.deepEqual(checkExceptions([dla], image, { today: TODAY, scanned: new Set(["image"]) }).errors, []);
});

/** What the daily watch finds: a critical frp advisory, and a newer OpenSSL, which has no severity. */
const watchFindings = () => [
  ...parseAdvisories([{ ghsa_id: "GHSA-new0-0000-0000", severity: "critical", state: "published", vulnerabilities: [] }], "frp", "0.71.0", "frp.json").findings,
  ...parseWatch([{ id: "OpenSSL-3.5.9", package: "openssl", version: "3.5.7", fixed: "3.5.9" }], "watch.json").findings,
];

test("the watch's advisories wait as long as their severity allows, and a newer release 90 days", () => {
  const watch = watchFindings();
  const newer = entry({ id: "OpenSSL-3.5.9", package: "openssl", scope: "watch", added: TODAY, expires: "2027-01-09" });
  const critical = (expires) => entry({ id: "GHSA-new0-0000-0000", package: "frp", scope: "watch", added: TODAY, expires });
  const check = (entries) => checkExceptions(entries, watch, { today: TODAY, scanned: new Set(["watch"]) });

  const long = check([newer, critical("2027-01-09")]);
  assert.deepEqual(long.errors, ["entry 2 (GHSA-new0-0000-0000): lasts 90 days, more than the 7 a CRITICAL finding may wait"]);
  assert.deepEqual(judge(watch, long.active).watched.map((f) => f.id), ["GHSA-new0-0000-0000"]);

  const week = check([newer, critical("2026-10-18")]);
  assert.deepEqual(week.errors, []);
  assert.equal(judge(watch, week.active).watched.length, 0);
});

test("the summary lists unrated findings after high ones, so a long list cuts only milder ones", () => {
  const report = trivyReport();
  const vulns = report.Results[0].Vulnerabilities;
  vulns.push(UNRATED_DLA, { VulnerabilityID: "CVE-2026-1002", PkgName: "tar", InstalledVersion: "1.34", Status: "affected", Severity: "LOW" });
  for (let i = 0; i < 300; i++) {
    vulns.push({ VulnerabilityID: `CVE-2026-${3000 + i}`, PkgName: "zlib1g", InstalledVersion: "1.2.13", Status: "affected", Severity: "MEDIUM" });
  }
  const findings = parseTrivy(report, "t.json").findings;
  const summary = renderSummary({ findings, ...judge(findings, []), exceptions: { active: [] }, scans: [], warnings: [], errors: [] });
  const reported = summary.slice(summary.indexOf("Reported, not blocking: 305"));
  const ids = [...reported.matchAll(/^\| \[([^\]]+)\]/gm)].map((m) => m[1]);
  assert.equal(ids.length, 300);
  assert.deepEqual(ids.slice(0, 4), ["CVE-2026-2000", "CVE-2026-1000", "DLA-4783-1", "CVE-2026-1001"]);
  assert.match(reported, /^And 5 more, none more severe than these\.$/m);
  assert.ok(!ids.includes("CVE-2026-1002"));
});

test("an exception for a scope this run did not scan is not reported as matching nothing", () => {
  const result = checkExceptions([entry({ scope: "image", package: "perl-base" })], [], { today: TODAY, scanned });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
});

// ---- the command

function write(name, value) {
  const file = join(scratch, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function gate(args, env = {}) {
  const summary = join(scratch, `summary-${Math.random().toString(36).slice(2)}.md`);
  const result = spawnSync(process.execPath, [script, "--today", TODAY, ...args], {
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...env },
    encoding: "utf8",
  });
  let text = "";
  try {
    text = readFileSync(summary, "utf8");
  } catch {}
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, summary: text };
}

const lockfile = write("pnpm-lock.yaml", LOCKFILE);
const none = write("accepted-none.json", []);

test("the command: exit 0 when nothing blocks, with the summary of every scan", () => {
  const osv = write("osv-clean.json", osvReport({ katex: [{ vuln: osvVuln("GHSA-238p-pmpm-9mq7", { severity: "LOW", fixed: "0.18.2", name: "katex" }) }] }));
  const go = write("govulncheck-frpc-linux-amd64.json", goStream({ findings: [{ id: "GO-2026-3", trace: MODULE_ONLY }] }));
  const node = write("node-core.json", NODE_CORE);
  const run = gate(["--osv", osv, "--lockfile", lockfile, "--govulncheck", go, "--node-core", node, "--node-version", "26.10.0", "--accepted", none]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /result: nothing blocks a release/);
  assert.match(run.summary, /^### Vulnerability gate: nothing blocks a release/);
  assert.match(run.summary, /Reported, not blocking: 2/);
  assert.match(run.summary, /- Node.js 26.10.0 \(security WG list, 5 advisories\): 0 affect it/);
});

test("the command: exit 1 on a blocking finding, named in the summary and as an annotation", () => {
  const osv = write("osv-high.json", osvReport({ sharp: [{ vuln: osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "HIGH", fixed: "0.35.5", name: "sharp" }) }] }));
  const run = gate(["--osv", osv, "--lockfile", lockfile, "--accepted", none], { GITHUB_ACTIONS: "true" });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /^BLOCKS {3}GHSA-aaaa-bbbb-cccc sharp 0.34.1 \(fixed in 0.35.5\) HIGH pnpm-lock.yaml$/m);
  assert.match(run.stdout, /^::error title=GHSA-aaaa-bbbb-cccc blocks a release::sharp 0.34.1 HIGH in pnpm-lock.yaml$/m);
  assert.match(run.summary, /^### Vulnerability gate: 1 finding blocks a release/);

  const accepted = write("accepted-sharp.json", [entry()]);
  const allowed = gate(["--osv", osv, "--lockfile", lockfile, "--accepted", accepted]);
  assert.equal(allowed.code, 0, allowed.stdout);
  assert.match(allowed.stdout, /^accepted GHSA-aaaa-bbbb-cccc sharp/m);
  assert.match(allowed.summary, /\| GHSA-aaaa-bbbb-cccc \| sharp \| lockfile \| 2026-10-31 \| 20 \| 1 \|/);
});

test("the command: exit 2 on a missing or incomplete scan, or a wrong exceptions file, even beside a block", () => {
  const osv = write("osv-high2.json", osvReport({ sharp: [{ vuln: osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "HIGH", fixed: "0.35.5", name: "sharp" }) }] }));
  const missing = gate(["--osv", osv, "--lockfile", lockfile, "--trivy", join(scratch, "nope.json"), "--accepted", none]);
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /error: trivy .*nope.json: missing/);
  assert.match(missing.summary, /^### Vulnerability gate: cannot judge this run/);
  assert.equal(gate(["--osv", osv, "--accepted", none]).code, 2);
  assert.equal(gate(["--accepted", none]).code, 2);
  const expired = write("accepted-expired.json", [entry({ added: "2026-09-01", expires: "2026-09-30" })]);
  const bad = gate(["--osv", osv, "--lockfile", lockfile, "--accepted", expired]);
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /accepted-risks.json entry 1 \(GHSA-aaaa-bbbb-cccc\): expired on 2026-09-30/);
  const broken = write("accepted-broken.json", "[{");
  assert.equal(gate(["--osv", osv, "--lockfile", lockfile, "--accepted", broken]).code, 2);
});

// ---- the watch's issues

function fakeGithub(issues = [], { label = true } = {}) {
  const calls = [];
  let next = 100;
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (method === "GET" && path.startsWith("/labels/")) return label ? { name: "vuln-watch" } : null;
    if (method === "GET" && path.startsWith("/issues?")) return path.includes("page=1") ? issues : [];
    if (method === "POST" && path === "/issues") return { number: next++, ...body };
    return {};
  };
  return { api, calls };
}

const blockingSharp = () => judge(sharpHigh(), []).blocking;

test("the watch opens one issue per blocking ID, labelled and assigned, with public IDs only", async () => {
  const { api, calls } = fakeGithub([], { label: false });
  const log = await syncIssues({ blocking: blockingSharp(), watched: [], expiring: [], api, owner: "maintainer", today: TODAY });
  assert.deepEqual(log, ["opened #100: GHSA-aaaa-bbbb-cccc: sharp 0.34.1"]);
  assert.deepEqual(calls[1].slice(0, 2), ["POST", "/labels"]);
  const [, , issue] = calls.find(([m, p]) => m === "POST" && p === "/issues");
  assert.deepEqual(issue.labels, ["vuln-watch"]);
  assert.deepEqual(issue.assignees, ["maintainer"]);
  assert.match(issue.body, /^<!-- vuln-watch: GHSA-aaaa-bbbb-cccc -->/);
  assert.match(issue.body, /Fix target: 30 days \(HIGH\), by 2026-11-10\./);
});

test("the watch leaves an unchanged issue alone, reopens one found again, and closes one that cleared", async () => {
  const fresh = fakeGithub();
  await syncIssues({ blocking: blockingSharp(), watched: [], expiring: [], api: fresh.api, owner: "", today: TODAY });
  const { title, body } = fresh.calls.find(([m, p]) => m === "POST" && p === "/issues")[2];
  const open = { number: 7, state: "open", title, body, created_at: "2026-10-11T06:00:00Z", updated_at: "2026-10-11T06:00:00Z" };
  const sync = (api, blocking) => syncIssues({ blocking, watched: [], expiring: [], api, owner: "", today: TODAY });

  assert.deepEqual(await sync(fakeGithub([open]).api, blockingSharp()), []);

  const closed = fakeGithub([{ ...open, state: "closed" }]);
  assert.deepEqual(await sync(closed.api, blockingSharp()), ["reopened #7: GHSA-aaaa-bbbb-cccc: sharp 0.34.1"]);
  assert.ok(closed.calls.some(([m, p, b]) => m === "PATCH" && p === "/issues/7" && b.state === "open"));

  const cleared = fakeGithub([open, { number: 3, state: "open", title: "unrelated", body: "no marker", updated_at: "2026-10-01" }]);
  assert.deepEqual(await sync(cleared.api, []), ["closed #7: GHSA-aaaa-bbbb-cccc: sharp 0.34.1"]);
  assert.ok(cleared.calls.some(([m, p, b]) => m === "PATCH" && p === "/issues/7" && b.state === "closed"));
  assert.ok(!cleared.calls.some(([, p]) => p.startsWith("/issues/3")));
});

test("the watch keeps one issue for an ID found in two modules", async () => {
  const { api, calls } = fakeGithub();
  const log = await syncIssues({ blocking: judge(twoModules().findings, []).blocking, watched: [], expiring: [], api, owner: "", today: TODAY });
  assert.deepEqual(log, ["opened #100: GO-2026-1: stdlib v1.27.2, golang.org/x/net v0.56.0"]);
  assert.equal(calls.filter(([m, p]) => m === "POST" && p === "/issues").length, 1);
});

test("the watch opens an issue for an exception about to expire", async () => {
  const { api, calls } = fakeGithub();
  const log = await syncIssues({ blocking: [], watched: [], expiring: [{ ...entry({ expires: "2026-10-15" }), left: 4 }], api, owner: "", today: TODAY });
  assert.deepEqual(log, ["opened #100: Accepted risk GHSA-aaaa-bbbb-cccc (sharp) expires 2026-10-15"]);
  assert.match(calls.at(-1)[2].body, /^<!-- vuln-watch: accepted lockfile sharp GHSA-aaaa-bbbb-cccc -->/);
});

test("the watch's issue for an advisory gives its severity's fix target, and one for a newer release 90 days", async () => {
  const { api, calls } = fakeGithub();
  await syncIssues({ blocking: [], watched: judge(watchFindings(), []).watched, expiring: [], api, owner: "", today: TODAY });
  const [frp, openssl] = calls.filter(([m, p]) => m === "POST" && p === "/issues").map(([, , issue]) => issue.body);
  assert.match(frp, /^Fix target: 7 days \(CRITICAL\), by 2026-10-18\.\nMove the pin in a release, or accept it .* for no longer than that\.$/m);
  assert.match(openssl, /^Fix target: 90 days \(unrated\), by 2027-01-09\.$/m);
});

/** The reminder the watch opened for an exception expiring on 2026-10-15. */
async function reminderIssue() {
  const { api, calls } = fakeGithub();
  await syncIssues({ blocking: [], watched: [], expiring: [{ ...entry({ expires: "2026-10-15" }), left: 4 }], api, owner: "", today: TODAY });
  const { title, body } = calls.find(([m, p]) => m === "POST" && p === "/issues")[2];
  return { number: 9, state: "open", title, body, created_at: "2026-10-11T06:00:00Z", updated_at: "2026-10-11T06:00:00Z" };
}

test("the watch closes an exception's reminder saying why: it expired, or it was renewed or removed", async () => {
  const today = "2026-10-15";
  const close = async (refused) => {
    const { api, calls } = fakeGithub([await reminderIssue()]);
    await syncIssues({ blocking: [], watched: [], expiring: [], refused, api, owner: "", today });
    assert.ok(calls.some(([m, p, b]) => m === "PATCH" && p === "/issues/9" && b.state === "closed"));
    return calls.find(([m, p]) => m === "POST" && p === "/issues/9/comments")[2].body;
  };
  const { refused } = checkExceptions([entry({ expires: "2026-10-15" })], [], { today, scanned });
  assert.equal(await close(refused), "The exception expired on 2026-10-15, so it accepts nothing now.");
  assert.equal(await close([]), "Cleared on 2026-10-15: the exception was renewed or removed.");
});

test("the GitHub client speaks for the repository with the token, and reads a missing resource as none", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([url, init]);
    if (url.endsWith("/labels/vuln-watch")) return new Response("", { status: 404 });
    if (init.method === "PATCH") return new Response("bad", { status: 422 });
    return new Response(JSON.stringify({ number: 1 }), { status: 201 });
  };
  const api = githubApi({ token: "t0ken", repository: "stuga-dev/stuga", fetchImpl });
  assert.equal(await api("GET", "/labels/vuln-watch"), null);
  assert.deepEqual(await api("POST", "/issues", { title: "x" }), { number: 1 });
  await assert.rejects(api("PATCH", "/issues/1", { state: "closed" }), /PATCH \/repos\/stuga-dev\/stuga\/issues\/1: 422 bad/);
  const [url, init] = requests[1];
  assert.equal(url, "https://api.github.com/repos/stuga-dev/stuga/issues");
  assert.equal(init.headers.authorization, "Bearer t0ken");
  assert.equal(init.body, JSON.stringify({ title: "x" }));
});

/** main() as the daily watch runs it, against a GitHub with these issues: its result, every request it made and its comments. */
async function watchRun(args, { today = TODAY, issues = [] } = {}) {
  const requests = [];
  const comments = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace("/repos/stuga-dev/stuga", "");
    requests.push(`${init.method} ${path}`);
    if (path.endsWith("/comments")) comments.push(JSON.parse(init.body).body);
    if (init.method !== "GET") return new Response(JSON.stringify({ number: 100 }), { status: 201 });
    return new Response(path.startsWith("/labels/") ? '{"name": "vuln-watch"}' : JSON.stringify(issues), { status: 200 });
  };
  const env = { GITHUB_TOKEN: "t0ken", GITHUB_REPOSITORY: "stuga-dev/stuga", SECURITY_OWNER: "maintainer" };
  return { ...(await main(["--today", today, "--issues", ...args], env, fetchImpl)), requests, comments };
}

const sharpScan = write("osv-watch.json", osvReport({ sharp: [{ vuln: osvVuln("GHSA-aaaa-bbbb-cccc", { severity: "HIGH", fixed: "0.35.5", name: "sharp" }) }] }));

test("the watch exits 0 while findings block, each with its issue", async () => {
  const run = await watchRun(["--osv", sharpScan, "--lockfile", lockfile, "--accepted", none]);
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(run.requests, ["GET /labels/vuln-watch", "GET /issues", "POST /issues"]);
  assert.match(run.output, /^result: 1 blocking and 0 watched findings, 1 issue changes$/m);
});

test("the watch changes no issue when a scan cannot be judged", async () => {
  const missing = await watchRun(["--osv", sharpScan, "--lockfile", lockfile, "--trivy", join(scratch, "nope.json"), "--accepted", none]);
  assert.equal(missing.code, 2);
  assert.deepEqual(missing.requests, []);
  const partial = await watchRun(["--osv", write("osv-short.json", { results: [] }), "--lockfile", lockfile, "--accepted", none]);
  assert.equal(partial.code, 2);
  assert.deepEqual(partial.requests, []);
});

test("the watch keeps its issues when an exception is wrong, and then exits 2", async () => {
  const expired = write("accepted-expired-watch.json", [entry({ added: "2026-09-01", expires: "2026-09-30" })]);
  const run = await watchRun(["--osv", sharpScan, "--lockfile", lockfile, "--accepted", expired]);
  assert.equal(run.code, 2);
  assert.deepEqual(run.requests, ["GET /labels/vuln-watch", "GET /issues", "POST /issues"]);
  assert.match(run.output, /^error: accepted-risks.json entry 1 \(GHSA-aaaa-bbbb-cccc\): expired on 2026-09-30$/m);
  assert.match(run.output, /^result: 1 blocking and 0 watched findings, 1 issue changes; fix the exceptions$/m);
});

test("the watch closes the reminder of an exception that expired, saying so, and opens its finding's issue", async () => {
  const accepted = write("accepted-expires-15.json", [entry({ expires: "2026-10-15" })]);
  const run = await watchRun(["--osv", sharpScan, "--lockfile", lockfile, "--accepted", accepted], { today: "2026-10-15", issues: [await reminderIssue()] });
  assert.equal(run.code, 2);
  assert.deepEqual(run.requests, ["GET /labels/vuln-watch", "GET /issues", "POST /issues", "POST /issues/9/comments", "PATCH /issues/9"]);
  assert.deepEqual(run.comments, ["The exception expired on 2026-10-15, so it accepts nothing now."]);
});
