// node --test packaging/docker/test/stuga-script.test.mjs
//
// packaging/docker/stuga with a fake docker and curl first on PATH: its version rules against the
// node's, how it reads stuga-node's list, and how restore and upgrade pick a release, refuse an older
// one and write the rollback. going-back.sh and db-password.sh run the same paths on real images.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const stuga = new URL("../stuga", import.meta.url).pathname;
const SCRIPT = readFileSync(stuga, "utf8");
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// ---------------------------------------------------------------- functions on their own

/** A function's definition, as the script has it: `name() {` to the next `}` in column 0, or one line. */
function fn(name) {
  const lines = SCRIPT.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.ok(start >= 0, `${name} is not in packaging/docker/stuga`);
  if (lines[start].trimEnd().endsWith("}")) return lines[start];
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

function bash(body, args = [], input = "") {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`, "bash", ...args], { input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// The node's rule (services/node/src/version.ts), read from its source so the two cannot drift.
const versionSource = ["../../../services/node/src/version.ts", "../../../services/node/src/updates/feed.ts"]
  .map((p) => new URL(p, import.meta.url))
  .filter((u) => existsSync(u))
  .map((u) => readFileSync(u, "utf8"))
  .join("\n");
const literal = /=\s*\/(\^\(0\|\[1-9\]\\d\*\)[^\n/]*\$)\/;/.exec(versionSource);
const RELEASE = new RegExp(literal?.[1] ?? "(?!)");
const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

describe("versions", () => {
  test("the node's release pattern is in its source", () => {
    assert.ok(literal, "no /^(0|[1-9]\\d*)…$/ literal in version.ts or feed.ts");
  });

  test("is_release agrees with the node", () => {
    const cases = ["0.0.0", "0.1.9", "0.1.10", "1.2.3", "10.20.30", "01.2.3", "1.02.3", "1.2.03", "00.0.0",
      "0.0.0-dev", "0.0.0-ci", "0.0.0-drill", "local-abc1234", "9.9.9-test", "1.2", "1.2.3.4", "v1.2.3",
      " 1.2.3", "1.2.3 ", "1.2.3\n4.5.6", ""];
    const got = bash(`${fn("is_release")}\nfor v; do if is_release "$v"; then echo y; else echo n; fi; done`, cases).split("\n").slice(0, -1);
    assert.deepEqual(got, cases.map((v) => (RELEASE.test(v) ? "y" : "n")));
  });

  test("version_lt orders releases as the node does", () => {
    const pairs = [["0.1.9", "0.1.10"], ["0.1.10", "0.1.9"], ["1.0.0", "1.0.0"], ["0.9.9", "1.0.0"], ["2.0.0", "10.0.0"],
      ["1.10.0", "1.9.9"], ["9.0.0", "9.1.0"], ["9.1.0", "9.0.0"]];
    const got = bash(`${fn("version_lt")}\nwhile [ $# -gt 0 ]; do if version_lt "$1" "$2"; then echo y; else echo n; fi; shift 2; done`, pairs.flat())
      .split("\n").slice(0, -1);
    assert.deepEqual(got, pairs.map(([a, b]) => (compare(a, b) < 0 ? "y" : "n")));
  });

  test("older_release needs two releases", () => {
    const pairs = [["8.0.0", "9.0.0"], ["9.0.0", "8.0.0"], ["0.0.0-dev", "9.0.0"], ["8.0.0", ""], ["", "9.0.0"], ["8.0.0", "0.0.0-dev"]];
    const got = bash(`${fn("is_release")}\n${fn("version_lt")}\n${fn("older_release")}\nwhile [ $# -gt 0 ]; do if older_release "$1" "$2"; then echo y; else echo n; fi; shift 2; done`, pairs.flat())
      .split("\n").slice(0, -1);
    assert.deepEqual(got, ["y", "n", "n", "n", "n", "n"]);
  });
});

// One entry of `stuga-node list --json`, keys in the order the contract fixes.
const entry = (name, fields) => ({
  name,
  path: `/backups/${name}`,
  database: "stuga",
  created_at: `${name.slice(0, 10)}T03:00:00.000Z`,
  stuga_version: "9.0.0",
  schema_version: 2,
  bytes: 1024,
  runtime_version: "9.0.0",
  before_upgrade: false,
  ...fields,
});
const listing = (...backups) =>
  JSON.stringify({ backups, partial: ["/backups/x.partial"], replacedDataDirs: [], replacedDatabases: null, unfinishedRestoreDirs: [], unfinishedRestoreDatabases: [] });

describe("backup_rows", () => {
  const rows = (input) => bash(`${fn("backup_rows")}\nbackup_rows`, [], input);

  test("one line per backup, newest first, tab-separated", () => {
    const out = rows(listing(
      entry("2026-10-04T030000Z", {}),
      entry("2026-10-03T030000Z", { stuga_version: "8.0.0", before_upgrade: true }),
      entry("2026-10-02T030000Z", { stuga_version: null, runtime_version: "0.0.0-dev" }),
      entry("2026-10-01T030000Z", { database: "other", stuga_version: "8.0.0", before_upgrade: true }),
    ));
    assert.equal(out, [
      "2026-10-04T030000Z\tstuga\t9.0.0\t9.0.0\tfalse",
      "2026-10-03T030000Z\tstuga\t8.0.0\t9.0.0\ttrue",
      "2026-10-02T030000Z\tstuga\t\t0.0.0-dev\tfalse",
      "2026-10-01T030000Z\tother\t8.0.0\t9.0.0\ttrue",
      "",
    ].join("\n"));
  });

  test("a list from before runtime_version and before_upgrade leaves them empty", () => {
    const old = { name: "2026-10-04T030000Z", path: "/backups/2026-10-04T030000Z", database: "stuga", created_at: "2026-10-04T03:00:00.000Z", stuga_version: "8.0.0", schema_version: 2, bytes: 1 };
    assert.equal(rows(listing(old)), "2026-10-04T030000Z\tstuga\t8.0.0\t\t\n");
  });

  test("no backups, no lines", () => {
    assert.equal(rows(listing()), "");
    assert.equal(rows(""), "");
  });
});

// ---------------------------------------------------------------- commands, on a fake docker

// docker as ./stuga uses it, from state.json beside the stack: compose files merged by -f, containers
// by service, a Postgres that answers app_version, and stuga-node's answers. Every call is logged.
const FAKE_DOCKER = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.FAKE_STATE;
const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(argv) + "\\n");
const out = (text) => process.stdout.write(text);
const exit = (code) => { save(); process.exit(code); };

function merged(files) {
  const images = new Map();
  for (const f of files) {
    let inServices = false, svc = null;
    for (const line of fs.readFileSync(f, "utf8").split("\\n")) {
      if (/^services:\\s*$/.test(line)) { inServices = true; continue; }
      if (/^\\S/.test(line)) { inServices = false; svc = null; continue; }
      if (!inServices) continue;
      let m = /^  ([A-Za-z0-9_-]+):\\s*$/.exec(line);
      if (m) { svc = m[1]; if (!images.has(svc)) images.set(svc, ""); continue; }
      m = /^    image:\\s*"?([^"\\s]*)"?\\s*$/.exec(line);
      if (m && svc) images.set(svc, m[1]);
    }
  }
  return images;
}
const container = (id) => Object.values(s.containers).find((c) => c.id === id);
const versionOf = (image) => s.versions[image];
let ids = s.ids || 0;
const newId = () => { s.ids = ++ids; return "c" + ids; };

if (argv[0] === "compose") {
  const files = [];
  let i = 1;
  while (argv[i] === "-f") { files.push(argv[i + 1]); i += 2; }
  const sub = argv[i++];
  const rest = argv.slice(i);
  const config = merged(files);
  switch (sub) {
    case "config":
      if (rest.includes("--images")) out([...config.values()].filter(Boolean).join("\\n") + "\\n");
      else if (!rest.includes("-q")) out(files.map((f) => fs.readFileSync(f, "utf8")).join("\\n"));
      exit(0);
    case "ps": {
      if (rest.includes("--services")) {
        out(Object.entries(s.containers).filter(([, c]) => c.running).map(([n]) => n + "\\n").join(""));
        exit(0);
      }
      const svc = rest[rest.length - 1];
      const c = s.containers[svc];
      if (rest.includes("-q")) {
        if (c && (rest.includes("-a") || c.running)) out(c.id + "\\n");
        exit(0);
      }
      out("NAME STATUS\\n");
      exit(0);
    }
    case "exec": {
      let j = 0;
      while (rest[j].startsWith("-")) j += rest[j] === "-e" ? 2 : 1;
      const svc = rest[j];
      const cmd = rest.slice(j + 1);
      const c = s.containers[svc];
      if (!c || !c.running) { process.stderr.write("service " + svc + " is not running\\n"); exit(1); }
      if (svc === "postgres" && cmd[0] === "psql") {
        const sql = cmd[cmd.length - 1];
        if (/app_version FROM node_state/.test(sql)) { if (!s.served) exit(1); out(s.served + "\\n"); exit(0); }
        if (/max\\(id\\) FROM schema_migrations/.test(sql)) { out("2\\n"); exit(0); }
        if (/SHOW server_version/.test(sql)) { out("18.0\\n"); exit(0); }
        if (/pg_stat_activity/.test(sql)) { out("0\\n"); exit(0); }
        exit(1);
      }
      if (svc === "node" && cmd.join(" ") === "cat /app/VERSION") {
        const v = versionOf(c.image);
        if (v === undefined) exit(1);
        out(v + "\\n");
        exit(0);
      }
      exit(1);
    }
    case "stop": case "start": {
      if (sub === "stop" && s.stopFails) exit(1);
      for (const svc of rest) if (s.containers[svc]) s.containers[svc].running = sub === "start";
      // What a node did before it stopped: state.onNodeStop is merged into the state once.
      if (sub === "stop" && rest.includes("node") && s.onNodeStop) { Object.assign(s, s.onNodeStop); delete s.onNodeStop; }
      exit(0);
    }
    case "rm": {
      for (const svc of rest.filter((a) => !a.startsWith("-"))) delete s.containers[svc];
      exit(0);
    }
    case "up": {
      const named = rest.filter((a) => !a.startsWith("-"));
      for (const [svc, image] of config) {
        if (named.length && !named.includes(svc)) continue;
        const c = s.containers[svc];
        if (!c || c.image !== image) s.containers[svc] = { id: newId(), image, running: true, restarts: 0 };
        else c.running = true;
        if (svc === "node") {
          if (s.nodeFails) s.containers.node.running = false;
          s.ready = s.nodeFails ? "down" : (s.readyAfterUp || "ok");
          if (s.servedAfterUp) s.served = s.servedAfterUp;
        }
      }
      exit(0);
    }
    case "run": {
      let j = 0, entrypoint = "";
      while (rest[j].startsWith("-")) {
        if (["-v", "-e", "--entrypoint"].includes(rest[j])) { if (rest[j] === "--entrypoint") entrypoint = rest[j + 1]; j += 2; }
        else j += 1;
      }
      const svc = rest[j];
      const args = rest.slice(j + 1);
      s.runs.push({ image: config.get(svc), entrypoint, args });
      if (entrypoint === "cat") {
        const name = args[0].split("/")[2];
        if (!(name in s.manifests)) exit(1);
        out(s.manifests[name]);
        exit(0);
      }
      if (entrypoint === "node") {
        const command = args[1];
        if (command === "list") { out(s.list + "\\n"); exit(0); }
        if (command === "verify") { out('{"ok":true}\\n'); exit(s.verify || 0); }
        if (command === "restore") {
          out('{"ok":true,"replacedDatabase":"stuga_replaced_x","replacedDataDir":"/parent/node.replaced-x"}\\n');
          exit(s.restore || 0);
        }
        if (command === "backup") { out('{"ok":true,"path":"/backups/2026-10-05T030000Z"}\\n'); exit(0); }
      }
      exit(0);
    }
    case "port": exit(1);
    case "logs": out(s.log || ""); exit(0);
    case "pull": case "build": exit(s.pullFails ? 1 : 0);
    default: exit(0);
  }
}
if (argv[0] === "inspect") {
  const template = argv[2], c = container(argv[3]);
  if (!c) exit(1);
  const fields = { "{{.Config.Image}}": c.image, "{{.State.Status}}": c.running ? "running" : "exited", "{{.RestartCount}}": String(c.restarts) };
  out(template.replace(/{{[^}]*}}/g, (t) => fields[t] ?? "") + "\\n");
  exit(0);
}
if (argv[0] === "image" && argv[1] === "inspect") exit(s.images.includes(argv[2]) ? 0 : 1);
if (argv[0] === "pull") {
  if (!s.pullable.includes(argv[1])) exit(1);
  s.images.push(argv[1]);
  exit(0);
}
if (argv[0] === "run") {
  const image = argv[argv.length - 2];
  const v = versionOf(image);
  if (v === undefined) exit(1);
  out(v + "\\n");
  exit(0);
}
if (argv[0] === "logs") { out("a line\\n"); exit(0); }
exit(0);
`;

// /ready as state.ready says (ok, refused or down), and a release's files from releases/<version>/,
// the latest one's from releases/<state.latest>/.
const FAKE_CURL = `#!${process.execPath}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:/.test(a)) || "";
const o = argv.indexOf("-o");
const fail = argv.some((a) => /^-[a-zA-Z]*f/.test(a));
const write = (text) => (o >= 0 ? fs.writeFileSync(argv[o + 1], text) : process.stdout.write(text));
const release = /releases\\/(?:download\\/v([^/]+)|latest\\/download)\\/(.+)$/.exec(url);
if (release) {
  const file = process.env.FAKE_RELEASES + "/" + (release[1] ?? s.latest) + "/" + release[2];
  if (!fs.existsSync(file)) process.exit(22);
  write(fs.readFileSync(file));
  process.exit(0);
}
if (url.endsWith("/ready")) {
  if (s.ready === "ok") { write('{"ok":true}'); process.exit(0); }
  if (s.ready === "refused") { if (fail) process.exit(22); write('{"ok":false,"status":"refused"}'); process.exit(0); }
}
process.exit(7);
`;

const REGISTRY = "ghcr.io/stuga-dev";
const images = (v) => ["postgres", "node", "remote"].map((svc) => `${REGISTRY}/stuga-${svc}:${v}`);
const composeFor = (v) =>
  `name: stuga\nservices:\n${["postgres", "node", "remote"].map((svc) => `  ${svc}:\n    image: ${REGISTRY}/stuga-${svc}:${v}\n`).join("")}`;
const manifest = (stuga, runtime) =>
  `${JSON.stringify({ format: 1, created_at: "2026-10-03T03:00:00.000Z", database: "stuga", stuga_version: stuga, runtime_version: runtime, schema_version: 2 }, null, 2)}\n`;

/**
 * A stack directory with ./stuga, compose.yml naming `pin`, and .env with a password; containers
 * from `containers` ({service: version | {version, running}}). Returns run(args) and the state.
 */
function stack({ pin, containers, served, list = listing(), manifests = {}, present = [], pullable = [], ...extra }) {
  const base = mkdtempSync(join(tmpdir(), "stuga-script-"));
  roots.push(base);
  const dir = join(base, "stack");
  mkdirSync(join(dir, "backups"), { recursive: true });
  for (const name of Object.keys(manifests)) mkdirSync(join(dir, "backups", name));
  cpSync(stuga, join(dir, "stuga"));
  writeFileSync(join(dir, "compose.yml"), composeFor(pin));
  writeFileSync(join(dir, ".env"), "POSTGRES_PASSWORD=x\nHOST_PORT=8787\n");
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  // The releases ./stuga upgrade <version> downloads.
  for (const v of ["8.0.0", "9.0.0", "9.1.0"]) {
    mkdirSync(join(base, "releases", v), { recursive: true });
    writeFileSync(join(base, "releases", v, "compose.yml"), composeFor(v));
    writeFileSync(join(base, "releases", v, "env.example"), "");
    cpSync(stuga, join(base, "releases", v, "stuga"));
  }
  let ids = 0;
  const state = {
    containers: Object.fromEntries(
      Object.entries(containers).map(([svc, c]) => {
        const { version, running = true } = typeof c === "string" ? { version: c } : c;
        return [svc, { id: `c${++ids}`, image: `${REGISTRY}/stuga-${svc}:${version}`, running, restarts: 0 }];
      }),
    ),
    ids,
    versions: Object.fromEntries(["8.0.0", "9.0.0", "9.0.2", "9.1.0"].map((v) => [`${REGISTRY}/stuga-node:${v}`, v])),
    images: [...new Set([...images(pin), ...Object.entries(containers).map(([svc, c]) => `${REGISTRY}/stuga-${svc}:${typeof c === "string" ? c : c.version}`), ...present])],
    pullable,
    served,
    list,
    manifests,
    runs: [],
    ready: "ok",
    ...extra,
  };
  const statePath = join(base, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const calls = join(base, "calls.jsonl");
  writeFileSync(calls, "");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: base,
    FAKE_STATE: statePath,
    FAKE_CALLS: calls,
    FAKE_RELEASES: join(base, "releases"),
    STUGA_READY_QUIET_SECONDS: "4",
    STUGA_READY_MAX_SECONDS: "4",
  };
  return {
    dir,
    run: (...args) => {
      const r = spawnSync("bash", ["./stuga", ...args], { cwd: dir, env, encoding: "utf8", input: "" });
      return { code: r.status, out: r.stdout + r.stderr };
    },
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    read: (name) => readFileSync(join(dir, name), "utf8"),
  };
}

/** The compose subcommand of a logged call, after its -f files. */
const subcommand = (call) => {
  let i = 1;
  while (call[i] === "-f") i += 2;
  return call[i];
};
const isCompose = (call, sub) => call[0] === "compose" && subcommand(call) === sub;
const did = (calls, sub, ...args) => calls.some((c) => isCompose(c, sub) && args.every((a) => c.includes(a)));
const rollback = (v) => `services:\n${["postgres", "node", "remote"].map((svc) => `  ${svc}:\n    image: "${REGISTRY}/stuga-${svc}:${v}"\n`).join("")}`;

describe("restore", () => {
  test("with no node container, it goes back on compose.yml's registry and pins the whole stack", () => {
    const s = stack({
      pin: "9.0.0",
      containers: { postgres: "9.0.0", remote: "9.0.0" },
      served: "9.0.0",
      manifests: { "2026-10-03T030000Z": manifest("8.0.0", "9.0.0") },
      present: images("8.0.0"),
    });
    const r = s.run("restore", "--yes", "2026-10-03T030000Z");
    assert.equal(r.code, 0, r.out);
    assert.equal(s.read("compose.rollback.yml"), rollback("8.0.0"));
    assert.match(s.read(".env"), /^COMPOSE_FILE=compose\.yml:compose\.rollback\.yml$/m);
    const [verify, restore] = ["verify", "restore"].map((c) => s.state().runs.find((x) => x.args[1] === c));
    // Checked by the release that served the data here, comparing extensions; put back by the backup's.
    assert.equal(verify.image, `${REGISTRY}/stuga-node:9.0.0`);
    assert.ok(verify.args.includes("--going-back"), verify.args.join(" "));
    assert.equal(restore.image, `${REGISTRY}/stuga-node:8.0.0`);
    assert.ok(did(s.calls(), "up", "-d"));
    assert.deepEqual(Object.values(s.state().containers).map((c) => c.image).sort(), images("8.0.0").sort());
    for (const f of readdirSync(s.dir)) {
      assert.ok(!f.startsWith(".stuga-pin"), `${f} was left behind`);
      if (f.endsWith(".yml")) assert.doesNotMatch(s.read(f), /image: ""/, f);
    }
  });

  test("a backup of a newer release's data is checked and put back by that release", () => {
    const s = stack({
      pin: "9.0.0",
      containers: { postgres: "9.0.0", node: "9.0.0", remote: "9.0.0" },
      served: "9.0.0",
      manifests: { "2026-10-03T030000Z": manifest("9.1.0", "9.1.0") },
      pullable: images("9.1.0"),
    });
    const r = s.run("restore", "--yes", "2026-10-03T030000Z");
    assert.equal(r.code, 0, r.out);
    const calls = s.calls();
    const pulls = calls.filter((c) => c[0] === "pull").map((c) => c[1]);
    assert.deepEqual(pulls.sort(), images("9.1.0").sort());
    const firstStop = calls.findIndex((c) => isCompose(c, "stop"));
    assert.ok(calls.findLastIndex((c) => c[0] === "pull") < firstStop, "pulled after the node stopped");
    const verify = s.state().runs.find((x) => x.args[1] === "verify");
    assert.equal(verify.image, `${REGISTRY}/stuga-node:9.1.0`);
    assert.ok(!verify.args.includes("--going-back"));
    assert.equal(s.read("compose.rollback.yml"), rollback("9.1.0"));
    assert.match(r.out, /compose\.yml names stuga 9\.0\.0; get matching files with: \.\/stuga upgrade 9\.1\.0/);
  });

  test("an image that cannot be pulled stops nothing", () => {
    const s = stack({
      pin: "9.0.0",
      containers: { postgres: "9.0.0", node: "9.0.0", remote: "9.0.0" },
      served: "9.0.0",
      manifests: { "2026-10-03T030000Z": manifest("8.0.0", "9.0.0") },
    });
    const r = s.run("restore", "--yes", "2026-10-03T030000Z");
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /could not pull ghcr\.io\/stuga-dev\/stuga-node:8\.0\.0/);
    assert.ok(!did(s.calls(), "stop"));
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
    assert.equal(s.state().containers.node.running, true);
  });

  test("a backup of the release compose.yml names takes the rollback out", () => {
    const s = stack({
      pin: "9.0.0",
      containers: { postgres: "8.0.0", node: "8.0.0", remote: "8.0.0" },
      served: "8.0.0",
      manifests: { "2026-10-03T030000Z": manifest("9.0.0", "9.0.0") },
    });
    writeFileSync(join(s.dir, "compose.rollback.yml"), rollback("8.0.0"));
    writeFileSync(join(s.dir, ".env"), "POSTGRES_PASSWORD=x\nCOMPOSE_FILE=compose.yml:compose.rollback.yml\n");
    const r = s.run("restore", "--yes", "2026-10-03T030000Z");
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
    assert.doesNotMatch(s.read(".env"), /COMPOSE_FILE/);
    assert.deepEqual(Object.values(s.state().containers).map((c) => c.image).sort(), images("9.0.0").sort());
  });
});

describe("upgrade", () => {
  for (const running of [true, false]) {
    test(`refuses a compose.yml older than the data's release, the node ${running ? "running" : "stopped"}`, () => {
      const s = stack({ pin: "8.0.0", containers: { postgres: "9.0.0", node: { version: "9.0.0", running }, remote: "9.0.0" }, served: "9.0.0" });
      const r = s.run("upgrade");
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /compose\.yml names stuga 8\.0\.0, older than stuga 9\.0\.0, which last served this data\. Nothing was changed\./);
      assert.match(r.out, /\.\/stuga upgrade 9\.0\.0/);
      for (const sub of ["stop", "up", "pull"]) assert.ok(!did(s.calls(), sub), `ran compose ${sub}`);
    });

    test(`refuses to download an older release, the node ${running ? "running" : "stopped"}`, () => {
      const s = stack({ pin: "9.0.0", containers: { postgres: "9.0.0", node: { version: "9.0.0", running }, remote: "9.0.0" }, served: "9.0.0" });
      const r = s.run("upgrade", "8.0.0");
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /stuga 8\.0\.0 is older than stuga 9\.0\.0, which last served this data/);
      assert.equal(s.read("compose.yml"), composeFor("9.0.0"));
      for (const sub of ["stop", "up", "pull"]) assert.ok(!did(s.calls(), sub), `ran compose ${sub}`);
    });
  }

  test("naming the release that served the data puts its files back", () => {
    const s = stack({
      pin: "8.0.0",
      containers: { postgres: "8.0.0", node: "8.0.0", remote: "8.0.0" },
      served: "9.0.0",
      ready: "refused",
    });
    const r = s.run("upgrade", "9.0.0");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /compose\.yml names stuga 9\.0\.0 again; it serves\./);
    assert.equal(s.read("compose.yml"), composeFor("9.0.0"));
    assert.deepEqual(Object.values(s.state().containers).map((c) => c.image).sort(), images("9.0.0").sort());
  });

  // compose.yml names the release that served the data, and compose.rollback.yml keeps an older one on
  // it: a failed upgrade's new node that backed up and upgraded the data after the rollback was written.
  const rolledBack = () => {
    const s = stack({
      pin: "9.0.0",
      containers: { postgres: "8.0.0", node: "8.0.0", remote: "8.0.0" },
      served: "9.0.0",
      ready: "refused",
      latest: "9.0.0",
    });
    writeFileSync(join(s.dir, "compose.rollback.yml"), rollback("8.0.0"));
    writeFileSync(join(s.dir, ".env"), "POSTGRES_PASSWORD=x\nCOMPOSE_FILE=compose.yml:compose.rollback.yml\n");
    return s;
  };

  for (const args of [["9.0.0"], [], ["--fetched"]]) {
    test(`upgrade ${args.join(" ") || "to the latest"} takes out a rollback that keeps an older release on the data`, () => {
      const s = rolledBack();
      const r = s.run("upgrade", ...args);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /compose\.yml names stuga 9\.0\.0 again; it serves\./);
      assert.doesNotMatch(r.out, /Nothing to do|nothing to upgrade to/);
      assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
      assert.doesNotMatch(s.read(".env"), /COMPOSE_FILE/);
      assert.deepEqual(Object.values(s.state().containers).map((c) => c.image).sort(), images("9.0.0").sort());
    });
  }

  test("with no rollback, the release that served the data is nothing to do", () => {
    const s = stack({ pin: "9.0.0", containers: { postgres: "9.0.0", node: "9.0.0", remote: "9.0.0" }, served: "9.0.0", latest: "9.0.0" });
    let r = s.run("upgrade");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /stuga 9\.0\.0 is running, and it is the newest release\. Nothing to do\./);
    r = s.run("upgrade", "--fetched");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /nothing to upgrade to; nothing was changed/);
    for (const sub of ["stop", "up", "pull"]) assert.ok(!did(s.calls(), sub), `ran compose ${sub}`);
  });

  test("a rollback that cannot be taken out starts nothing, and says how", { skip: process.getuid?.() === 0 && "root writes anywhere" }, () => {
    const s = rolledBack();
    chmodSync(s.dir, 0o555);
    try {
      const r = s.run("upgrade", "--fetched");
      assert.equal(r.code, 3, r.out);
      assert.match(r.out, /could not take compose\.rollback\.yml out of COMPOSE_FILE in \.env, so the stack stays on another release than stuga 9\.0\.0/);
      assert.match(r.out, /delete compose\.rollback\.yml, then run: docker compose up -d/);
      assert.ok(!did(s.calls(), "up"));
    } finally {
      chmodSync(s.dir, 0o755);
    }
    assert.equal(s.read("compose.rollback.yml"), rollback("8.0.0"));
    assert.match(s.read(".env"), /^COMPOSE_FILE=compose\.yml:compose\.rollback\.yml$/m);
  });

  const failed = (list, extra = {}) =>
    stack({
      pin: "9.0.0",
      containers: { postgres: "8.0.0", node: "8.0.0", remote: "8.0.0" },
      served: "8.0.0",
      list,
      nodeFails: true,
      ...extra,
    });
  const own = entry("2026-10-04T030000Z", { stuga_version: "8.0.0", runtime_version: "8.0.0" });
  const before = entry("2026-10-03T030000Z", { stuga_version: "8.0.0", runtime_version: "9.0.0", before_upgrade: true });

  test("a failed upgrade offers the backup the new release took first", () => {
    const s = failed(listing(own, before));
    const r = s.run("upgrade");
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /To go back: +\.\/stuga restore .*\/backups\/2026-10-03T030000Z/);
    assert.doesNotMatch(r.out, /2026-10-04T030000Z/);
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
    // A node that took its backup may still be upgrading: it is left alone.
    assert.ok(!did(s.calls(), "stop"), "stopped the new node");
  });

  test("a failed upgrade that took no backup stops the new node, then offers the stack as it was", () => {
    const s = failed(listing(own));
    const r = s.run("upgrade");
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /took no backup, so it changed nothing/);
    assert.match(r.out, /It is stopped now\. To go back to stuga 8\.0\.0, keep compose\.yml and run: docker compose up -d/);
    assert.doesNotMatch(r.out, /2026-10-04T030000Z/);
    assert.equal(s.read("compose.rollback.yml"), rollback("8.0.0"));
    assert.match(s.read(".env"), /^COMPOSE_FILE=compose\.yml:compose\.rollback\.yml$/m);
    // Restarting until it can back up, it would then upgrade the data under the old stack.
    const calls = s.calls();
    const up = calls.findIndex((c) => isCompose(c, "up"));
    assert.ok(calls.slice(up + 1).some((c) => isCompose(c, "stop") && c.includes("node")), "the new node was not stopped");
  });

  test("a failed upgrade whose node backed up as it was stopped offers that backup, not the rollback", () => {
    const s = failed(listing(own), { onNodeStop: { list: listing(own, before) } });
    const r = s.run("upgrade");
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /To go back: +\.\/stuga restore .*\/backups\/2026-10-03T030000Z/);
    assert.doesNotMatch(r.out, /changed nothing/);
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
  });

  test("a failed upgrade whose node upgraded the data as it was stopped offers no rollback", () => {
    const s = failed(listing(own), { onNodeStop: { served: "9.0.0" } });
    const r = s.run("upgrade");
    assert.equal(r.code, 4, r.out);
    assert.doesNotMatch(r.out, /changed nothing|To go back/);
    assert.match(r.out, /\.\/stuga list shows the backups there are/);
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
  });

  test("a failed upgrade whose node cannot be stopped offers no rollback", () => {
    const s = failed(listing(own), { stopFails: true });
    const r = s.run("upgrade");
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /took no backup, so it changed nothing/);
    assert.doesNotMatch(r.out, /To go back|stopped now/);
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
    assert.doesNotMatch(s.read(".env"), /COMPOSE_FILE/);
  });

  test("a failed upgrade that wrote to the data offers no way back but the list", () => {
    const s = failed(listing(own), { servedAfterUp: "9.0.0" });
    const r = s.run("upgrade");
    assert.equal(r.code, 4, r.out);
    assert.doesNotMatch(r.out, /took no backup|To go back/);
    assert.match(r.out, /\.\/stuga list shows the backups there are/);
    assert.ok(!existsSync(join(s.dir, "compose.rollback.yml")));
  });
});

describe("status", () => {
  test("says why a node refuses its data", () => {
    const s = stack({
      pin: "8.0.0",
      containers: { postgres: "8.0.0", node: "8.0.0", remote: "8.0.0" },
      served: "9.0.0",
      ready: "refused",
      log: "[node] refusing this database: Stuga 9.0.0 served it last, and this is Stuga 8.0.0. Nothing was changed.\n",
    });
    const r = s.run("status");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^data {9}last served by stuga 9\.0\.0$/m);
    assert.match(r.out, /^ready {8}NO — refused: Stuga 9\.0\.0 served it last, and this is Stuga 8\.0\.0\. Nothing was changed\.$/m);
    assert.match(r.out, /the node refuses this data: stuga 9\.0\.0 served it last and the node is 8\.0\.0\. Start 9\.0\.0 again \(\.\/stuga upgrade 9\.0\.0\)/);
  });
});
