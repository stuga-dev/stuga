// node --test packaging/macos/test/restore.test.mjs (macOS: plutil, BSD stat, ps and df)
//
// runtime/bin/stuga against a temporary root, as root would run it, with its tools stubbed first on
// PATH (STUGA_TEST_PATH): id says root, stat says root owns what the test owns, sudo checks it runs
// things as _stuga, launchctl keeps each job's state in files and starts no node while the hold mark
// is held, curl serves packages and /ready, spctl, xar and pkgutil read a package's text, installer
// does what a package's scripts do (the runtime that ran bin/stuga included, which it removes), and
// sleep returns at once unless the test makes it sleep. Each runtime's stuga-node records how it was
// run, runs what the test gives it, and answers what the test says; its psql and pg_isready answer
// for the live database. xattr, run through sudo as _stuga, is recorded, not run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const bin = new URL("../runtime/bin/", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs macOS's plutil, stat, ps and df";
const TM_EXCLUDE_VALUE = /^TM_EXCLUDE_VALUE=(\S+)$/m.exec(readFileSync(join(bin, "timemachine.sh"), "utf8"))[1];
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const PINS = "PG_MAJOR=18\nPGVECTOR_VERSION=0.8.6\nPG_SEARCH_VERSION=0.25.9\n";
const NAME = "2026-10-04T030000Z";
const RELEASES = "https://releases.test/download";

const STUBS = {
  id: '#!/bin/bash\nif [ "$1" = -u ]; then cat "$STUB_DIR/uid" 2> /dev/null || echo 0; exit 0; fi\nexec /usr/bin/id "$@"\n',
  stat: String.raw`#!/bin/bash
# Root owns what the test owns.
case "$*" in *%u*) /usr/bin/stat "$@" | sed "s/^$(/usr/bin/id -u) /0 /" ;; *) exec /usr/bin/stat "$@" ;; esac
`,
  sudo: String.raw`#!/bin/bash
if [ "$1" != -u ] || [ "$2" != _stuga ]; then echo "sudo $*" >> "$STUB_DIR/misuse"; exit 1; fi
shift 2
# xattr is recorded, not run.
if [[ " $* " == *" /usr/bin/xattr "* ]]; then
  echo "xattr $(printf '%s' "$*" | sed 's|.* /usr/bin/xattr ||') [as _stuga]" >> "$STUB_DIR/calls"
  exit 0
fi
exec "$@"
`,
  launchctl: String.raw`#!/bin/bash
echo "launchctl $*" >> "$STUB_DIR/calls"
label() { basename "$1" .plist; }
case "$1" in
  print)
    job="$STUB_DIR/jobs/$(label "$2")"
    [ -f "$job/loaded" ] || { echo "Could not find service" >&2; exit 113; }
    echo "$2 = {"
    printf '\tstate = %s\n' "$([ -f "$job/pid" ] && echo running || echo 'not running')"
    if [ -f "$job/pid" ]; then printf '\tendpoints = {\n\t\tpid = 7\n\t}\n\tpid = %s\n' "$(cat "$job/pid")"; fi
    echo "}"
    ;;
  bootout) rm -f "$STUB_DIR/jobs/$(label "$2")/loaded" "$STUB_DIR/jobs/$(label "$2")/pid" ;;
  bootstrap)
    name="$(label "$3")"
    job="$STUB_DIR/jobs/$name"
    mkdir -p "$job"
    if [ -f "$job/disabled" ]; then echo "Bootstrap failed: 119: Service is disabled" >&2; exit 119; fi
    if [ -f "$job/loaded" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    touch "$job/loaded"
    # The node's wrapper exits at once while the hold mark holds.
    if [ "$name" = dev.stuga.node ] && (. "$STUB_DIR/hold.sh" && restore_under_way "$STUGA_ROOT"); then exit 0; fi
    echo $((RANDOM + 1000)) > "$job/pid"
    ;;
  enable) mkdir -p "$STUB_DIR/jobs/$(label "$2")"; rm -f "$STUB_DIR/jobs/$(label "$2")/disabled" ;;
  disable) mkdir -p "$STUB_DIR/jobs/$(label "$2")"; touch "$STUB_DIR/jobs/$(label "$2")/disabled" ;;
  kickstart) [ ! -f "$STUB_DIR/jobs/$(label "$2")/loaded" ] || echo $((RANDOM + 1000)) > "$STUB_DIR/jobs/$(label "$2")/pid" ;;
esac
`,
  curl: String.raw`#!/bin/bash
out="" url="" format=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) format="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://*/ready) printf '000'; exit 7 ;;
  */ready)
    code="$(cat "$STUB_DIR/ready-code" 2> /dev/null || echo 200)"
    printf '{"ok":%s,"status":"%s"}' "$([ "$code" = 200 ] && echo true || echo false)" "$(cat "$STUB_DIR/ready-status" 2> /dev/null || echo starting)" > "$out"
    printf '%s' "$code"
    exit 0
    ;;
esac
echo "curl $url" >> "$STUB_DIR/calls"
file="$STUB_DIR/serve/$(basename "$url")"
[ -f "$file" ] || exit 22
cp "$file" "$out"
`,
  spctl: String.raw`#!/bin/bash
echo "spctl $*" >> "$STUB_DIR/calls"
if [ -f "$STUB_DIR/spctl" ]; then cat "$STUB_DIR/spctl" >&2; else printf 'source=Notarized Developer ID\norigin=Developer ID Installer: Stuga AB (8W9F4LY7AP)\n' >&2; fi
exit "$(cat "$STUB_DIR/spctl-status" 2> /dev/null || echo 0)"
`,
  xar: String.raw`#!/bin/bash
echo "xar $*" >> "$STUB_DIR/calls"
printf '<product id="dev.stuga" version="%s"/>\n' "$(sed -n 's/^version=//p' "$2")" > Distribution
`,
  pkgutil: String.raw`#!/bin/bash
# pkgutil --expand-full <pkg> <dir>: the runtime's versions.env, as the package's text gives it.
echo "pkgutil $*" >> "$STUB_DIR/calls"
version="$(sed -n 's/^version=//p' "$2")"
conf="$3/stuga-node.pkg/Payload/Library/Application Support/Stuga/runtime/$version/conf"
mkdir -p "$conf"
grep -E '^(PG_MAJOR|PG_SEARCH_VERSION|PGVECTOR_VERSION)=' "$2" > "$conf/versions.env"
`,
  installer: String.raw`#!/bin/bash
# installer -pkg <pkg> -target /: what a package's preinstall and postinstall do to $STUGA_ROOT.
echo "installer $* (directory $(stat -f %Lp "$(dirname "$2")"))" >> "$STUB_DIR/calls"
version="$(sed -n 's/^version=//p' "$2")"
touch "$STUGA_ROOT/status/installing"
for label in dev.stuga.node dev.stuga.postgres; do launchctl bootout "system/$label"; done
# After its preinstall, before its postinstall.
if [ -f "$STUB_DIR/installer-fails" ]; then echo "installer: The install failed."; exit 1; fi
cp -R "$STUB_DIR/runtimes/$version" "$STUGA_ROOT/runtime/$version"
ln -sfn "runtime/$version" "$STUGA_ROOT/current"
for label in dev.stuga.postgres dev.stuga.node; do
  launchctl enable "system/$label"
  launchctl bootstrap system "$(dirname "$STUGA_NODE_PLIST")/$label.plist"
done
rm -f "$STUGA_ROOT/status/installing"
for dir in "$STUGA_ROOT"/runtime/*; do [ "$(basename "$dir")" = "$version" ] || rm -rf "$dir"; done
if [ -f "$STUB_DIR/installer-fails-after" ]; then echo "installer: The install failed late."; exit 1; fi
`,
  sleep: '#!/bin/bash\n[ ! -f "$STUB_DIR/sleep-real" ] || exec /bin/sleep "$@"\n',
};

/**
 * stuga-node: records how it was run, runs node/<command>.sh, then answers with
 * node/<command>.{json,code}, after node/<command>.delay ms.
 */
const STUGA_NODE = String.raw`const fs = require("node:fs");
const path = require("node:path");
const stub = process.env.STUB_DIR;
const [command, ...rest] = process.argv.slice(2);
const runtime = path.basename(path.resolve(__dirname, "../../../.."));
const mark = fs.existsSync(path.join(process.env.STUGA_ROOT, "status/restoring")) ? "held" : "none";
fs.appendFileSync(path.join(stub, "calls"), ["stuga-node", command, ...rest].join(" ") + " [runtime " + runtime + "] [mark " + mark + "] [cwd " + process.cwd() + "] [DATA_DIR " + process.env.DATA_DIR + "] [PG_BIN " + process.env.PG_BIN + "]\n");
const hook = path.join(stub, "node", command + ".sh");
if (fs.existsSync(hook)) require("node:child_process").execFileSync("/bin/bash", [hook], { stdio: "ignore" });
const canned = (ext) => { try { return fs.readFileSync(path.join(stub, "node", command + "." + ext), "utf8"); } catch { return null; } };
const finish = () => {
  process.stdout.write((canned("json") ?? JSON.stringify({ ok: true })).trim() + "\n");
  process.exitCode = Number(canned("code") ?? 0);
};
const delay = Number(canned("delay") ?? 0);
if (delay) {
  fs.writeFileSync(path.join(stub, "node", command + ".started"), "");
  setTimeout(finish, delay);
} else finish();
`;

/** The stuga-node --json answer of a restore that kept what it replaced. */
const RESTORED = (root) =>
  JSON.stringify({ ok: true, path: `${root}/data/backups/${NAME}`, replacedDatabase: "stuga_replaced_20261004t120000z", replacedDataDir: `${root}/data/node.replaced-20261004t120000z`, notes: [] });

/**
 * A root running Stuga `installed` on data `served` last wrote, a backup NAME of `backup`'s data, the
 * node and Postgres running, and the release `older` published.
 */
function setup({ installed = "0.1.14", served = installed, backup = installed, older = "0.1.13", olderPins = PINS } = {}) {
  // Real, as `pwd -P` and the runtime's own paths give it: the temporary directory is behind /var.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "stuga-restore-")));
  roots.push(base);
  const root = join(base, "Application Support", "Stuga");
  const stub = join(base, "stub");
  const plists = join(base, "LaunchDaemons");
  for (const dir of [join(stub, "bin"), join(stub, "serve"), join(stub, "node"), join(stub, "runtimes"), plists, join(root, "runtime"), join(root, "status"), join(root, "data", "node"), join(root, "data", "backups", NAME), join(base, "logs")]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stub, "bin", name), body);
    chmodSync(join(stub, "bin", name), 0o755);
  }
  copyFileSync(join(bin, "hold.sh"), join(stub, "hold.sh"));
  writeFileSync(join(stub, "calls"), "");

  const runtime = (dir, version, pins = PINS) => {
    for (const sub of ["app/services/node/bin", "node/bin", "postgres/bin", "bin", "conf"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, "app/VERSION"), `${version}\n`);
    writeFileSync(join(dir, "app/services/node/bin/stuga-node.js"), STUGA_NODE);
    symlinkSync(process.execPath, join(dir, "node/bin/node"));
    for (const file of ["stuga", "release.sh", "hold.sh", "timemachine.sh"]) copyFileSync(join(bin, file), join(dir, "bin", file));
    writeFileSync(join(dir, "conf/versions.env"), `# pins\n${pins}`);
    const tool = (name, body) => {
      writeFileSync(join(dir, "postgres/bin", name), `#!/bin/bash\n${body}`);
      chmodSync(join(dir, "postgres/bin", name), 0o755);
    };
    tool("pg_isready", `echo "pg_isready [runtime ${version}]" >> "${stub}/calls"\n[ ! -f "${stub}/postgres-down" ]\n`);
    tool(
      "psql",
      `[ ! -f "${stub}/psql-fails" ] || { echo 'psql: error: connection to server failed' >&2; exit 2; }\n` +
        `case "$*" in *to_regclass*) if [ -f "${stub}/served" ]; then echo t; else echo f; fi ;; *app_version*) cat "${stub}/served" ;; esac\n`,
    );
  };
  runtime(join(root, "runtime", installed), installed);
  symlinkSync(`runtime/${installed}`, join(root, "current"));
  runtime(join(stub, "runtimes", older), older, olderPins);
  writeFileSync(join(stub, "serve", `Stuga-${older}.pkg`), `version=${older}\n${olderPins}`);
  writeFileSync(join(stub, "served"), `${served}\n`);
  writeFileSync(join(root, "data", "backups", NAME, "MANIFEST.json"), JSON.stringify({ format: 1, stuga_version: backup, runtime_version: backup, database_bytes: 1000, data_dir_bytes: 1000 }));
  writeFileSync(join(root, "status", "upgrade.json"), "{}\n");
  writeFileSync(join(stub, "node", "restore.json"), RESTORED(root));

  const env = {
    STUGA_ROOT: root,
    DATA_DIR: join(root, "data", "node"),
    DATABASE_URL: `postgres:///stuga?host=${encodeURIComponent(join(root, "data", "run"))}&user=stuga`,
    PG_BIN: join(root, "current", "postgres", "bin"),
    PORT: "8787",
    STUGA_LOG_DIR: join(base, "logs"),
    STUB_DIR: stub,
  };
  const nodePlist = join(plists, "dev.stuga.node.plist");
  writeFileSync(join(base, "node.json"), JSON.stringify({ Label: "dev.stuga.node", EnvironmentVariables: env }));
  spawnSync("plutil", ["-convert", "xml1", "-o", nodePlist, join(base, "node.json")]);
  writeFileSync(join(plists, "dev.stuga.postgres.plist"), "");
  for (const [label, pid] of [["dev.stuga.node", 4100], ["dev.stuga.postgres", 4000], ["dev.stuga.helper", null]]) {
    mkdirSync(join(stub, "jobs", label), { recursive: true });
    writeFileSync(join(stub, "jobs", label, "loaded"), "");
    if (pid) writeFileSync(join(stub, "jobs", label, "pid"), String(pid));
  }

  const h = {
    base,
    root,
    stub,
    nodePlist,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: base,
      STUGA_TEST_PATH: join(stub, "bin"),
      STUGA_ROOT: root,
      STUGA_NODE_PLIST: nodePlist,
      STUGA_RELEASES_URL: RELEASES,
      STUB_DIR: stub,
    },
    /** bin/stuga as an administrator runs it, through `current`. */
    stuga(args, { cwd = base, input = "", env = {} } = {}) {
      return spawnSync("/bin/bash", [join(root, "current", "bin", "stuga"), ...args], { cwd, env: { ...h.env, ...env }, input, encoding: "utf8", timeout: 60_000 });
    },
    /**
     * bin/stuga in a process group of its own, as a terminal runs it, and Ctrl-C there: SIGINT to the
     * whole group a moment after `ready(stdout)`, sleep sleeping.
     */
    async interrupt(args, ready) {
      h.touch("sleep-real");
      const child = spawn("/bin/bash", [join(root, "current", "bin", "stuga"), ...args], { cwd: base, env: h.env, detached: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise((resolve) => child.on("exit", resolve));
      for (let i = 0; i < 300 && !ready(stdout); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(ready(stdout), stderr);
      await new Promise((r) => setTimeout(r, 300));
      process.kill(-child.pid, "SIGINT");
      return { status: await exited, stdout, stderr };
    },
    answer(command, code, json) {
      writeFileSync(join(stub, "node", `${command}.code`), String(code));
      if (json !== undefined) writeFileSync(join(stub, "node", `${command}.json`), typeof json === "string" ? json : JSON.stringify(json));
    },
    calls: () => readFileSync(join(stub, "calls"), "utf8").split("\n").filter(Boolean),
    clearCalls: () => writeFileSync(join(stub, "calls"), ""),
    node: (command) => h.calls().filter((c) => c.startsWith(`stuga-node ${command} `)),
    /** Each call that starts so, one after the other, or the first that is not there. */
    inOrder(prefixes) {
      const calls = h.calls();
      let at = -1;
      for (const prefix of prefixes) {
        at = calls.findIndex((c, i) => i > at && c.startsWith(prefix));
        if (at < 0) return `no ${prefix} after the ones before it in:\n${calls.join("\n")}`;
      }
      return "in order";
    },
    marked: () => existsSync(join(root, "status", "restoring")),
    job: (label) => ({
      loaded: existsSync(join(stub, "jobs", label, "loaded")),
      running: existsSync(join(stub, "jobs", label, "pid")),
      disabled: existsSync(join(stub, "jobs", label, "disabled")),
    }),
    touch: (file, text = "") => writeFileSync(join(stub, file), text),
  };
  return h;
}

/** Whatever happened, nothing was stopped and nothing was replaced. */
function nothingChanged(h, installed = "0.1.14") {
  const calls = h.calls();
  assert.ok(!calls.some((c) => c.startsWith("launchctl bootout") || c.startsWith("installer")), calls.join("\n"));
  assert.deepEqual(h.node("restore"), []);
  assert.ok(!h.marked(), "the mark is gone");
  assert.ok(h.job("dev.stuga.node").running, "the node runs on");
  assert.equal(readlinkSync(join(h.root, "current")), `runtime/${installed}`);
}

const started = (pid) => spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { LC_ALL: "C", TZ: "UTC0" }, encoding: "utf8" }).stdout.trim();

test("the same version: checked under the mark, then the node stopped, restored and started", { skip }, () => {
  const h = setup();
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 0, run.stderr);

  const backup = join(h.root, "data", "backups", NAME);
  const [verify] = h.node("verify");
  assert.ok(verify.startsWith(`stuga-node verify ${backup} --json [runtime 0.1.14] [mark held] [cwd ${join(h.root, "data")}]`), verify);
  assert.doesNotMatch(verify, /--going-back/);
  const [restore] = h.node("restore");
  assert.equal(
    restore,
    `stuga-node restore ${backup} --yes --json [runtime 0.1.14] [mark held] [cwd ${join(h.root, "data")}] [DATA_DIR ${join(h.root, "data", "node")}] [PG_BIN ${join(h.root, "runtime", "0.1.14", "postgres", "bin")}]`,
  );
  assert.equal(
    h.inOrder([
      "stuga-node verify",
      "launchctl bootout system/dev.stuga.node",
      "stuga-node restore",
      "xattr -wx",
      "launchctl enable system/dev.stuga.node",
      `launchctl bootstrap system ${h.nodePlist}`,
    ]),
    "in order",
  );
  // By its owner: root follows no link _stuga put there.
  const exclude = h.calls().filter((c) => c.startsWith("xattr "));
  assert.deepEqual(exclude, [`xattr -wx com.apple.metadata:com_apple_backup_excludeItem ${TM_EXCLUDE_VALUE} ${join(h.root, "data", "node")} [as _stuga]`]);
  assert.ok(!h.marked(), "the mark is gone");
  assert.ok(h.job("dev.stuga.node").running);
  assert.ok(existsSync(join(h.root, "status", "upgrade.json")), "a same-version restore keeps the upgrade status");
  assert.match(run.stdout, new RegExp(`^Restored ${NAME}\\. What it replaced is kept: database "stuga_replaced_20261004t120000z", .*/node\\.replaced-20261004t120000z\\.$`, "m"));
  assert.ok(run.stdout.includes(`-c 'DROP DATABASE "stuga_replaced_20261004t120000z"'`), run.stdout);
  assert.ok(run.stdout.includes(`sudo rm -rf "${h.root}/data/node.replaced-20261004t120000z"`), run.stdout);
  assert.deepEqual(existsSync(join(h.stub, "misuse")) ? readFileSync(join(h.stub, "misuse"), "utf8") : "", "", "everything ran as _stuga");
});

test("a backup named by a path is taken from where the command was run", { skip }, () => {
  const h = setup();
  const run = h.stuga(["restore", "--yes", `backups/${NAME}/`], { cwd: join(h.root, "data") });
  assert.equal(run.status, 0, run.stderr);
  assert.match(h.node("restore")[0], new RegExp(`^stuga-node restore ${join(h.root, "data", "backups", NAME)} --yes`));
});

for (const code of [2, 3]) {
  test(`a verify that ends with ${code} stops nothing`, { skip }, () => {
    const h = setup();
    h.answer("verify", code, { ok: false, exit_code: code, error: "the backup is damaged. Nothing was changed." });
    const run = h.stuga(["restore", "--yes", NAME]);
    assert.equal(run.status, code);
    assert.match(run.stderr, /^error: the backup is damaged\. Nothing was changed\.$/m);
    nothingChanged(h);
  });
}

test("not root: refused before anything", { skip }, () => {
  const h = setup();
  h.touch("uid", "501\n");
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^error: run this with sudo$/m);
  assert.deepEqual(h.calls(), []);
});

for (const [backup, why] of [
  ["0.1.15", /holds Stuga 0\.1\.15's data, newer than this Stuga 0\.1\.14\. Update first, then run this again\. Nothing was changed\./],
  ["0.1.11", /going back is possible to Stuga 0\.1\.12 and later; .* holds Stuga 0\.1\.11's data\. Nothing was changed\./],
  ["0.0.0-dev", /holds Stuga 0\.0\.0-dev's data and this is Stuga 0\.1\.14: only a release goes back to another/],
]) {
  test(`a backup of Stuga ${backup}'s data is refused before anything stops`, { skip }, () => {
    const h = setup({ backup });
    const run = h.stuga(["restore", "--yes", NAME]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, why);
    assert.deepEqual(h.node("verify"), []);
    assert.ok(!h.calls().some((c) => c.startsWith("curl")));
    nothingChanged(h);
  });
}

test("going back: the older release is downloaded, checked and installed, and its runtime restores", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 0, run.stderr);

  const calls = h.calls();
  assert.equal(
    h.inOrder([
      "stuga-node verify",
      `curl ${RELEASES}/v0.1.13/Stuga-0.1.13.pkg`,
      "spctl --assess --type install",
      "xar -xf",
      "pkgutil --expand-full",
      "installer -pkg",
      "stuga-node restore",
      "launchctl enable system/dev.stuga.node",
      `launchctl bootstrap system ${h.nodePlist}`,
    ]),
    "in order",
  );
  assert.match(h.node("verify")[0], /--json --going-back \[runtime 0\.1\.14\] \[mark held\]/);
  assert.match(h.node("restore")[0], /\[runtime 0\.1\.13\] \[mark held\]/);
  const installer = calls.find((c) => c.startsWith("installer"));
  assert.match(installer, /^installer -pkg \/private\/var\/tmp\/stuga-restore\.[A-Za-z0-9]+\/Stuga-0\.1\.13\.pkg -target \/ \(directory 700\)$/);
  assert.ok(!existsSync(installer.split(" ")[2]), "the working directory goes");
  // The installer started the older node under the mark: no process, until the restore was done.
  const bootstraps = calls.filter((c) => c === `launchctl bootstrap system ${h.nodePlist}`);
  assert.equal(bootstraps.length, 2, calls.join("\n"));

  assert.equal(readlinkSync(join(h.root, "current")), "runtime/0.1.13");
  assert.ok(!existsSync(join(h.root, "runtime", "0.1.14")), "the runtime that ran bin/stuga is gone, and it finished");
  assert.ok(!existsSync(join(h.root, "status", "upgrade.json")), "the newer release's upgrade status goes");
  assert.ok(!h.marked());
  assert.ok(h.job("dev.stuga.node").running);
  assert.match(run.stdout, new RegExp(`^Restored ${NAME}; Stuga 0\\.1\\.13 runs\\. What it replaced is kept`, "m"));
});

test("going back with a package that fails its checks installs nothing and stops nothing", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  h.touch("spctl-status", "3");
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^error: the package is not notarized and signed by Stuga \(8W9F4LY7AP\)\. Nothing was changed\.$/m);
  nothingChanged(h);
});

test("going back across another pg_search is refused before anything changes", { skip }, () => {
  const h = setup({ backup: "0.1.13", olderPins: PINS.replace("PG_SEARCH_VERSION=0.25.9", "PG_SEARCH_VERSION=0.24.0") });
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Stuga 0\.1\.13 has PG_SEARCH_VERSION 0\.24\.0 and this Stuga 0\.25\.9: going back across it is not supported\. Nothing was changed\./);
  nothingChanged(h);
});

test("going back offline: --pkg gives the installer a copy, never the file given", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  const downloads = join(h.base, "Downloads");
  mkdirSync(downloads);
  copyFileSync(join(h.stub, "serve", "Stuga-0.1.13.pkg"), join(downloads, "Stuga-0.1.13.pkg"));
  rmSync(join(h.stub, "serve", "Stuga-0.1.13.pkg"));
  const run = h.stuga(["restore", "--yes", "--pkg", "Stuga-0.1.13.pkg", NAME], { cwd: downloads });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!h.calls().some((c) => c.startsWith("curl")), "nothing is downloaded");
  const installer = h.calls().find((c) => c.startsWith("installer"));
  assert.match(installer, /^installer -pkg \/private\/var\/tmp\/stuga-restore\.[A-Za-z0-9]+\/Stuga-0\.1\.13\.pkg /);
  assert.ok(existsSync(join(downloads, "Stuga-0.1.13.pkg")));
});

test("going back offline that stopped short: the same command with --pkg finishes it", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  const pkg = join(h.base, "Stuga-0.1.13.pkg");
  copyFileSync(join(h.stub, "serve", "Stuga-0.1.13.pkg"), pkg);
  rmSync(join(h.stub, "serve", "Stuga-0.1.13.pkg"));
  h.answer("restore", 3, { ok: false, exit_code: 3, error: "pg_restore failed; nothing was changed." });
  let run = h.stuga(["restore", "--yes", "--pkg", pkg, NAME]);
  assert.equal(run.status, 4, run.stderr);
  assert.match(run.stderr, /Fix that and run this again/);

  h.clearCalls();
  h.answer("restore", 0, RESTORED(h.root));
  run = h.stuga(["restore", "--yes", "--pkg", pkg, NAME]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^note: Stuga 0\.1\.13 is installed already; --pkg is not needed\.$/m);
  assert.ok(!h.calls().some((c) => c.startsWith("installer") || c.startsWith("curl")));
  assert.match(h.node("verify")[0], /--json --going-back \[runtime 0\.1\.13\]/);
  assert.match(h.node("restore")[0], /\[runtime 0\.1\.13\]/);
  assert.deepEqual(h.job("dev.stuga.node"), { loaded: true, running: true, disabled: false });
});

test("--pkg refuses a link, and a restore that goes back to nothing", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  symlinkSync(join(h.stub, "serve", "Stuga-0.1.13.pkg"), join(h.base, "Stuga-0.1.13.pkg"));
  let run = h.stuga(["restore", "--yes", "--pkg", join(h.base, "Stuga-0.1.13.pkg"), NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Stuga-0\.1\.13\.pkg is not a package file\. Nothing was changed\./);
  nothingChanged(h);

  const same = setup();
  run = same.stuga(["restore", "--yes", "--pkg", join(same.stub, "serve", "Stuga-0.1.13.pkg"), NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^error: --pkg is for going back\. Nothing was changed\.$/m);
  nothingChanged(same);
});

test("going back when the live data's version cannot be read is refused", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  h.touch("psql-fails");
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /could not read which Stuga served the data last\. Nothing was changed\./);
  nothingChanged(h);
});

test("a restore that fails after going back leaves the older release stopped, and running it again finishes", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  h.answer("restore", 3, { ok: false, exit_code: 3, error: "pg_restore failed; nothing was changed." });
  let run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 4);
  assert.ok(
    run.stderr.includes(
      `Stuga 0.1.13 is installed and stopped; your data is still Stuga 0.1.14's and was not changed: pg_restore failed; nothing was changed. Fix that and run this again, or open Stuga-0.1.14.pkg (${RELEASES}/v0.1.14/Stuga-0.1.14.pkg) to go forward.`,
    ),
    run.stderr,
  );
  assert.ok(h.calls().includes("launchctl disable system/dev.stuga.node"));
  assert.deepEqual(h.job("dev.stuga.node"), { loaded: false, running: false, disabled: true });
  assert.ok(!h.marked());

  // The older release is installed now, and the data is still the newer one's: still going back.
  h.clearCalls();
  h.answer("restore", 0, RESTORED(h.root));
  run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(h.node("verify")[0], /--json --going-back \[runtime 0\.1\.13\]/);
  assert.ok(!h.calls().some((c) => c.startsWith("installer") || c.startsWith("curl")));
  assert.match(h.node("restore")[0], /\[runtime 0\.1\.13\]/);
  assert.deepEqual(h.job("dev.stuga.node"), { loaded: true, running: true, disabled: false });
});

test("an installer that stops before it replaced anything starts Stuga again, and running it again finishes", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  h.touch("installer-fails");
  let run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /^error: the installer stopped: installer: The install failed\. Stuga 0\.1\.14 was started again; nothing was changed\.$/m);
  assert.deepEqual(h.node("restore"), []);
  assert.ok(!h.marked());
  assert.ok(h.job("dev.stuga.node").running && h.job("dev.stuga.postgres").running);
  assert.ok(!existsSync(join(h.root, "status", "installing")), "the mark its preinstall left goes");

  rmSync(join(h.stub, "installer-fails"));
  run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readlinkSync(join(h.root, "current")), "runtime/0.1.13");
});

test("an installer that stops after it replaced the runtime leaves the node stopped", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  h.touch("installer-fails-after");
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 4);
  assert.ok(run.stderr.includes(`Your data was not changed. Open Stuga-0.1.14.pkg (${RELEASES}/v0.1.14/Stuga-0.1.14.pkg) to go forward.`), run.stderr);
  assert.deepEqual(h.node("restore"), []);
  assert.equal(h.job("dev.stuga.node").disabled, true);
});

test("a restore that ends with 3 on the same version starts the node again", { skip }, () => {
  const h = setup();
  h.answer("restore", 3, { ok: false, exit_code: 3, error: "pg_restore failed; nothing was changed." });
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /^error: pg_restore failed; nothing was changed\. Stuga was started again\.$/m);
  assert.ok(h.job("dev.stuga.node").running);
  assert.ok(!h.marked());
});

test("a restore that ends with 4 leaves the node disabled, saying how to start it", { skip }, () => {
  const h = setup();
  h.answer("restore", 4, { ok: false, exit_code: 4, error: "the swap failed: the data directory is at /x." });
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 4);
  assert.ok(run.stderr.includes(`the swap failed: the data directory is at /x. The node was left stopped; once both halves are in place: sudo launchctl enable system/dev.stuga.node && sudo launchctl bootstrap system ${h.nodePlist}`), run.stderr);
  assert.deepEqual(h.job("dev.stuga.node"), { loaded: false, running: false, disabled: true });
  assert.ok(!h.marked());
});

test("a helper busy for a minute: refused, with the mark gone and the node running", { skip }, () => {
  const h = setup();
  writeFileSync(join(h.stub, "jobs", "dev.stuga.helper", "pid"), "999");
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^error: the helper is busy; try again in a minute\. Nothing was changed\.$/m);
  nothingChanged(h);
});

test("an interrupt during the restore waits for stuga-node, which finishes", { skip }, async () => {
  const h = setup();
  writeFileSync(join(h.stub, "node", "restore.delay"), "1500");
  const child = spawn("/bin/bash", [join(h.root, "current", "bin", "stuga"), "restore", "--yes", NAME], { cwd: h.base, env: h.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const startedFile = join(h.stub, "node", "restore.started");
  for (let i = 0; i < 200 && !existsSync(startedFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(startedFile), stderr);
  child.kill("SIGINT");
  const code = await exited;
  assert.equal(code, 0, stderr);
  assert.match(stdout, new RegExp(`^Restored ${NAME}\\.`, "m"));
  assert.ok(h.job("dev.stuga.node").running);
  assert.ok(!h.marked());
});

test("an upgrade the helper began before the mark, done during the checks: refused, and the new version starts", { skip }, () => {
  const h = setup();
  const newer = join(h.stub, "runtimes", "0.1.15");
  cpSync(join(h.root, "runtime", "0.1.14"), newer, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(newer, "app", "VERSION"), "0.1.15\n");
  writeFileSync(join(h.stub, "serve", "Stuga-0.1.15.pkg"), `version=0.1.15\n${PINS}`);
  // The helper's installer, run while bin/stuga verifies: it moves `current` and removes 0.1.14.
  writeFileSync(
    join(h.stub, "node", "verify.sh"),
    `PATH="$STUB_DIR/bin:/usr/bin:/bin" STUGA_NODE_PLIST=${JSON.stringify(h.nodePlist)} installer -pkg "$STUB_DIR/serve/Stuga-0.1.15.pkg" -target /\n`,
  );
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /^error: Stuga was updated meanwhile; run this again\. Nothing was changed\.$/m);
  assert.deepEqual(h.node("restore"), []);
  assert.deepEqual(h.calls().filter((c) => c.startsWith("pg_isready")), ["pg_isready [runtime 0.1.14]"], "no wait on a removed runtime");
  assert.equal(readlinkSync(join(h.root, "current")), "runtime/0.1.15");
  assert.ok(!h.marked());
  assert.ok(h.job("dev.stuga.node").running, "the node the mark held back is started");
});

test("Ctrl-C while the older release's database starts: the node stays stopped, saying how to finish", { skip }, async () => {
  const h = setup({ backup: "0.1.13" });
  const pgIsready = join(h.stub, "runtimes", "0.1.13", "postgres", "bin", "pg_isready");
  writeFileSync(pgIsready, `#!/bin/bash\necho "pg_isready [runtime 0.1.13]" >> "${h.stub}/calls"\nexit 1\n`);
  const run = await h.interrupt(["restore", "--yes", NAME], () => h.calls().includes("pg_isready [runtime 0.1.13]"));
  assert.equal(run.status, 4, run.stderr);
  assert.ok(
    run.stderr.includes(
      `Stuga 0.1.13 is installed and stopped; your data is still Stuga 0.1.14's and was not changed: interrupted. Fix that and run this again, or open Stuga-0.1.14.pkg (${RELEASES}/v0.1.14/Stuga-0.1.14.pkg) to go forward.`,
    ),
    run.stderr,
  );
  assert.deepEqual(h.node("restore"), []);
  assert.deepEqual(h.job("dev.stuga.node"), { loaded: false, running: false, disabled: true });
  assert.ok(!h.marked());
});

test("going back, ended before the restore by anything unforeseen: the older node stays stopped, saying how to finish", { skip }, async () => {
  const h = setup({ backup: "0.1.13" });
  // The older release's database answers once the test says so.
  const pgIsready = join(h.stub, "runtimes", "0.1.13", "postgres", "bin", "pg_isready");
  writeFileSync(pgIsready, `#!/bin/bash\necho "pg_isready [runtime 0.1.13]" >> "${h.stub}/calls"\n[ -f "${h.stub}/postgres-up" ]\n`);
  h.touch("sleep-real");
  // SIGPIPE ignored, as bash then leaves it: a write to the closed output fails, and set -e ends it.
  const stuga = join(h.root, "current", "bin", "stuga");
  const child = spawn("/bin/bash", ["-c", 'trap "" PIPE; exec /bin/bash "$0" "$@"', stuga, "restore", "--yes", NAME], { cwd: h.base, env: h.env });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 300 && !h.calls().includes("pg_isready [runtime 0.1.13]"); i++) await new Promise((r) => setTimeout(r, 50));
  child.stdout.destroy();
  h.touch("postgres-up");
  assert.equal(await exited, 4, stderr);
  // bash's unwritten output may land inside the address; the rest is whole.
  assert.match(stderr, /error: Stuga 0\.1\.13 is installed and stopped; your data is still Stuga 0\.1\.14's and was not changed\. Run this again, or open Stuga-0\.1\.14\.pkg \(/);
  assert.deepEqual(h.node("restore"), []);
  assert.deepEqual(h.job("dev.stuga.node"), { loaded: false, running: false, disabled: true });
  assert.ok(!h.marked());
});

test("Ctrl-C while Stuga starts after a restore: the restore is reported, with what it kept", { skip }, async () => {
  const h = setup();
  h.touch("ready-code", "503");
  const run = await h.interrupt(["restore", "--yes", NAME], (stdout) => stdout.includes("Starting Stuga…"));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^Restored ${NAME}\\. What it replaced is kept: database "stuga_replaced_20261004t120000z"`, "m"));
  assert.match(run.stdout, /^Stuga is still starting; the menu bar shows when it is ready\.$/m);
  assert.ok(run.stdout.includes(`-c 'DROP DATABASE "stuga_replaced_20261004t120000z"'`), run.stdout);
  assert.ok(h.job("dev.stuga.node").running);
});

test("another restore under way: refused, and its mark stays, whatever the time zone", { skip }, () => {
  const h = setup();
  const mark = `${process.pid}\n${started(process.pid)}\n`;
  writeFileSync(join(h.root, "status", "restoring"), mark);
  const run = h.stuga(["restore", "--yes", NAME], { env: { TZ: "Asia/Tokyo" } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^error: another restore is under way\. Nothing was changed\.$/m);
  assert.equal(readFileSync(join(h.root, "status", "restoring"), "utf8"), mark);
  assert.deepEqual(h.node("verify"), []);
});

test("a mark whose process has ended is taken over", { skip }, async () => {
  const h = setup();
  const child = spawn("/bin/sleep", ["0.1"]);
  const mark = `${child.pid}\n${started(child.pid)}\n`;
  await new Promise((resolve) => child.on("exit", resolve));
  writeFileSync(join(h.root, "status", "restoring"), mark);
  const run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(h.node("verify")[0], /\[mark held\]/);
  assert.ok(!h.marked());
});

test("refused while a package installs, or while the database is down", { skip }, () => {
  const h = setup();
  writeFileSync(join(h.root, "status", "installing"), "");
  let run = h.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /an install is under way; run this when it has finished\. Nothing was changed\./);
  nothingChanged(h);

  const down = setup();
  down.touch("postgres-down");
  run = down.stuga(["restore", "--yes", NAME]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Stuga's database is not running; restart Stuga, then run this again\. Nothing was changed\./);
  nothingChanged(down);
});

test("without --yes it asks for the backup's name", { skip }, () => {
  const h = setup({ backup: "0.1.13" });
  let run = h.stuga(["restore", NAME], { input: "yes\n" });
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes(`This replaces Stuga's data with ${NAME}, and goes back from Stuga 0.1.14 to Stuga 0.1.13. Type the backup name to confirm: `), run.stderr);
  assert.match(run.stderr, /error: not confirmed\. Nothing was changed\./);
  nothingChanged(h);

  const same = setup();
  run = same.stuga(["restore", NAME], { input: `${NAME}\n` });
  assert.equal(run.status, 0, run.stderr);
});

test("the other commands are stuga-node's, run as the node, with its exit status", { skip }, () => {
  const h = setup();
  h.answer("list", 3, { ok: false, exit_code: 3, error: "no" });
  const run = h.stuga(["list", "--json"]);
  assert.equal(run.status, 3);
  assert.match(h.calls()[0], new RegExp(`^stuga-node list --json \\[runtime 0\\.1\\.14\\] \\[mark none\\] \\[cwd ${join(h.root, "data").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  const verify = h.stuga(["verify", NAME]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.ok(h.node("verify")[0].startsWith(`stuga-node verify ${join(h.root, "data", "backups", NAME)} [runtime`));
  assert.equal(h.stuga(["backup"]).status, 2, "only the commands it names");
});
