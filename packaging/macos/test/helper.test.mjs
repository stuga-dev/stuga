// node --test packaging/macos/test/helper.test.mjs (macOS: BSD stat and mv, ditto, zipinfo)
//
// helper.sh against a temporary root, with launchctl, curl, codesign and sleep stubbed on PATH:
// launchctl keeps one job's state in files, curl serves files from a directory, codesign passes
// unless told not to, and sleep returns at once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";

const helper = new URL("../runtime/bin/helper.sh", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs macOS's stat, mv, ditto and zipinfo";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const REQUIREMENT =
  '=anchor apple generic and certificate leaf[subject.OU] = "8W9F4LY7AP" and identifier "dev.stuga.remote" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]';
const CONFIG_SHA = "c".repeat(64);
const OTHER_CONFIG_SHA = "d".repeat(64);
const ZIP_NAME = "stuga-connector-darwin-arm64.zip";

const STUBS = {
  launchctl: String.raw`#!/bin/bash
# launchd for one job, its state in $STUB_DIR: loaded, pid, exit, enabled.
echo "launchctl $*" >> "$STUB_DIR/calls"
case "$1" in
  print)
    [ -f "$STUB_DIR/loaded" ] || { echo "Could not find service" >&2; exit 113; }
    echo "$2 = {"
    printf '\tactive count = 1\n'
    if [ -f "$STUB_DIR/pid" ]; then
      printf '\tstate = running\n\tpid = %s\n' "$(cat "$STUB_DIR/pid")"
    else
      printf '\tstate = not running\n'
    fi
    printf '\tlast exit code = %s\n' "$(cat "$STUB_DIR/exit" 2> /dev/null || echo '(never exited)')"
    echo "}"
    ;;
  bootout) rm -f "$STUB_DIR/loaded" "$STUB_DIR/pid" "$STUB_DIR/exit" ;;
  bootstrap)
    if [ -f "$STUB_DIR/bootstrap-fails" ]; then
      if [ -s "$STUB_DIR/bootstrap-fails" ]; then cat "$STUB_DIR/bootstrap-fails" >&2; else echo "Bootstrap failed: 5: Input/output error" >&2; fi
      exit 5
    fi
    touch "$STUB_DIR/loaded"
    case "$(cat "$STUB_DIR/job" 2> /dev/null || echo runs)" in
      runs) echo $((RANDOM + 1000)) > "$STUB_DIR/pid" ;;
      refuses) echo "78: EX_CONFIG" > "$STUB_DIR/exit" ;;
      fails) echo "1: Operation not permitted" > "$STUB_DIR/exit" ;;
    esac
    ;;
  enable | disable) echo "$1d" > "$STUB_DIR/enabled" ;;
esac
`,
  curl: String.raw`#!/bin/bash
# Serves $STUB_DIR/serve/<the URL's last segment>; runs $STUB_DIR/on-download first, if there is one.
echo "curl $*" >> "$STUB_DIR/calls"
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o | --max-time) [ "$1" != -o ] || out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ ! -x "$STUB_DIR/on-download" ] || "$STUB_DIR/on-download"
file="$STUB_DIR/serve/$(basename "$url")"
[ -f "$file" ] || exit 22
cp "$file" "$out"
`,
  codesign: String.raw`#!/bin/bash
printf 'codesign' >> "$STUB_DIR/calls"
printf ' [%s]' "$@" >> "$STUB_DIR/calls"
echo >> "$STUB_DIR/calls"
[ ! -f "$STUB_DIR/unsigned" ]
`,
  sleep: "#!/bin/bash\nexit 0\n",
};

/** A zip with stored entries: `{ name, data, mode }`, mode as st_mode (a directory or symlink too). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = "", mode = 0o100644 } of entries) {
    const body = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const FRPC = { name: "frpc", data: "#!/bin/sh\necho frpc\n", mode: 0o100755 };
const LICENSE = { name: "LICENSE", data: "Apache License 2.0\n" };
const NOTICES = { name: "THIRD-PARTY-NOTICES.txt", data: "notices\n" };
const CONNECTOR = [FRPC, LICENSE, NOTICES];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * A root whose runtime is Stuga `version` naming the connector `archive` (or no connector), the
 * release serving `archive`, and the stubs.
 */
function setup({ version = "1.2.3", archive = zip(CONNECTOR), names = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "stuga-helper-"));
  roots.push(base);
  const root = join(base, "Application Support", "Stuga");
  const stub = join(base, "stub");
  const bin = join(stub, "bin");
  mkdirSync(join(stub, "serve"), { recursive: true });
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(stub, "calls"), "");
  const runtime = join(root, "runtime", version);
  mkdirSync(join(runtime, "app"), { recursive: true });
  mkdirSync(join(runtime, "conf"));
  writeFileSync(join(runtime, "app", "VERSION"), `${version}\n`);
  if (names) writeFileSync(join(runtime, "conf", "connector.sha256"), `${sha256(archive)}\n`);
  symlinkSync(`runtime/${version}`, join(root, "current"));
  for (const dir of ["requests", "status", "connector", "remote"]) mkdirSync(join(root, dir));
  writeFileSync(join(stub, "serve", ZIP_NAME), archive);

  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    STUB_DIR: stub,
    STUGA_ROOT: root,
    STUGA_RELEASES_URL: "https://releases.test/download",
  };
  const h = {
    root,
    stub,
    connectorSha: sha256(archive),
    run() {
      const run = spawnSync("/bin/bash", [helper], { env, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return run;
    },
    request(line) {
      writeFileSync(join(root, "requests", ".remote.tmp"), line);
      rmSync(join(root, "requests", "remote"), { force: true });
      writeFileSync(join(root, "requests", "remote"), line);
    },
    status(file = "remote.json") {
      const path = join(root, "status", file);
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    },
    calls() {
      return readFileSync(join(stub, "calls"), "utf8").split("\n").filter(Boolean);
    },
    clearCalls() {
      writeFileSync(join(stub, "calls"), "");
    },
    job(mode) {
      writeFileSync(join(stub, "job"), mode);
    },
    loaded: () => existsSync(join(stub, "loaded")),
    running: () => existsSync(join(stub, "pid")),
    enabled: () => (existsSync(join(stub, "enabled")) ? readFileSync(join(stub, "enabled"), "utf8").trim() : null),
    /** A later Stuga in place, naming another connector. */
    upgradeTo(version, next) {
      const runtime = join(root, "runtime", version);
      mkdirSync(join(runtime, "app"), { recursive: true });
      mkdirSync(join(runtime, "conf"));
      writeFileSync(join(runtime, "app", "VERSION"), `${version}\n`);
      writeFileSync(join(runtime, "conf", "connector.sha256"), `${sha256(next)}\n`);
      rmSync(join(root, "current"));
      symlinkSync(`runtime/${version}`, join(root, "current"));
      writeFileSync(join(stub, "serve", ZIP_NAME), next);
      return sha256(next);
    },
  };
  return h;
}

const on = (sha = CONFIG_SHA) => `on ${sha}\n`;

function assertStatus(status, state, connector, config) {
  assert.deepEqual(Object.keys(status).sort(), ["at", "config_sha", "connector_sha", "message", "state"]);
  assert.equal(status.state, state, status.message);
  assert.equal(status.connector_sha, connector);
  assert.equal(status.config_sha, config);
  assert.match(status.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(typeof status.message, "string");
}

const bootstraps = (h) => h.calls().filter((c) => c.startsWith("launchctl bootstrap")).length;
const downloads = (h) => h.calls().filter((c) => c.startsWith("curl")).length;

test("without a request it touches nothing", { skip }, () => {
  const h = setup();
  h.run();
  assert.deepEqual(h.calls(), []);
  assert.equal(h.status(), null);
});

test("on: downloads, checks and installs the connector this runtime names, then starts the job", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();

  assertStatus(h.status(), "running", h.connectorSha, CONFIG_SHA);
  const calls = h.calls();
  const curl = calls.find((c) => c.startsWith("curl"));
  assert.match(curl, / --max-time 300 /);
  assert.ok(curl.endsWith(` https://releases.test/download/v1.2.3/${ZIP_NAME}`), curl);
  const codesign = calls.find((c) => c.startsWith("codesign"));
  assert.ok(codesign.startsWith(`codesign [--verify] [--strict] [-R] [${REQUIREMENT}] [`), codesign);
  assert.ok(calls.indexOf("launchctl enable system/dev.stuga.remote") < calls.indexOf("launchctl bootstrap system /Library/LaunchDaemons/dev.stuga.remote.plist"));

  const dir = join(h.root, "connector", h.connectorSha);
  assert.deepEqual(readdirSync(dir).sort(), ["LICENSE", "THIRD-PARTY-NOTICES.txt", "frpc"]);
  assert.equal(lstatSync(dir).mode & 0o777, 0o750);
  assert.equal(lstatSync(join(dir, "frpc")).mode & 0o777, 0o750);
  assert.equal(lstatSync(join(dir, "LICENSE")).mode & 0o777, 0o640);
  assert.equal(readlinkSync(join(h.root, "connector", "current")), h.connectorSha);
  assert.deepEqual(readdirSync(join(h.root, "connector")).filter((n) => n.startsWith(".install")), []);
  assert.ok(h.running());
  assert.equal(h.enabled(), "enabled");
});

test("on again, with nothing changed: no download and no restart", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();
  h.clearCalls();

  h.request(on());
  h.run();

  assertStatus(h.status(), "running", h.connectorSha, CONFIG_SHA);
  assert.equal(downloads(h), 0);
  assert.equal(bootstraps(h), 0);
  assert.ok(!h.calls().some((c) => c.startsWith("launchctl bootout")));
});

test("new settings restart the job once, without a download", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();
  h.clearCalls();

  h.request(on(OTHER_CONFIG_SHA));
  h.run();

  assertStatus(h.status(), "running", h.connectorSha, OTHER_CONFIG_SHA);
  assert.equal(downloads(h), 0);
  assert.equal(bootstraps(h), 1);
  const calls = h.calls();
  assert.ok(calls.indexOf("launchctl bootout system/dev.stuga.remote") < calls.findIndex((c) => c.startsWith("launchctl bootstrap")));
});

test("a job that stopped is started again", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();
  rmSync(join(h.stub, "pid"));
  h.clearCalls();

  h.request(on());
  h.run();

  assertStatus(h.status(), "running", h.connectorSha, CONFIG_SHA);
  assert.equal(downloads(h), 0);
  assert.equal(bootstraps(h), 1);
});

test("after an upgrade: the new connector, `current` moved, the job restarted once, one old connector kept", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();
  const first = h.connectorSha;
  const second = h.upgradeTo("1.2.4", zip([{ ...FRPC, data: "#!/bin/sh\necho frpc 2\n" }, LICENSE, NOTICES]));
  h.request(on());
  h.run();
  h.clearCalls();
  const third = h.upgradeTo("1.2.5", zip([{ ...FRPC, data: "#!/bin/sh\necho frpc 3\n" }, LICENSE, NOTICES]));

  h.request(on());
  h.run();

  assertStatus(h.status(), "running", third, CONFIG_SHA);
  assert.ok(h.calls().some((c) => c.includes(`/v1.2.5/${ZIP_NAME}`)));
  assert.equal(bootstraps(h), 1);
  assert.equal(readlinkSync(join(h.root, "connector", "current")), third);
  const kept = readdirSync(join(h.root, "connector")).filter((n) => /^[0-9a-f]{64}$/.test(n));
  assert.deepEqual(kept.sort(), [second, third].sort());
  assert.ok(!kept.includes(first));
});

test("off: stops and disables the job, and keeps the connector", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();

  h.request("off\n");
  h.run();

  assertStatus(h.status(), "stopped", null, null);
  assert.ok(!h.loaded());
  assert.equal(h.enabled(), "disabled");
  assert.ok(existsSync(join(h.root, "connector", h.connectorSha, "frpc")));

  h.clearCalls();
  h.request(on());
  h.run();
  assertStatus(h.status(), "running", h.connectorSha, CONFIG_SHA);
  assert.equal(downloads(h), 0, "turning it on again downloads nothing");
});

for (const [what, write] of [
  ["garbage", (h) => h.request("please\n")],
  ["a short sha", (h) => h.request(`on ${"c".repeat(63)}\n`)],
  ["an upper-case sha", (h) => h.request(`on ${"C".repeat(64)}\n`)],
  ["trailing space", (h) => h.request(`off \n`)],
  ["a line past 80 bytes", (h) => h.request(`on ${"c".repeat(64)}${"c".repeat(20)}\n`)],
  [
    "a symbolic link",
    (h) => {
      writeFileSync(join(h.stub, "target"), "off\n");
      rmSync(join(h.root, "requests", "remote"), { force: true });
      symlinkSync(join(h.stub, "target"), join(h.root, "requests", "remote"));
    },
  ],
  [
    "a directory",
    (h) => {
      rmSync(join(h.root, "requests", "remote"), { force: true });
      mkdirSync(join(h.root, "requests", "remote"));
    },
  ],
]) {
  test(`a request that is ${what} counts as off and is refused`, { skip }, () => {
    const h = setup();
    h.request(on());
    h.run();

    write(h);
    h.run();

    assertStatus(h.status(), "refused", null, null);
    assert.ok(!h.loaded());
    assert.equal(h.enabled(), "disabled");
    assert.ok(existsSync(join(h.root, "requests", "remote")), "the request stays");
  });
}

test("a runtime that names no connector is unavailable", { skip }, () => {
  const h = setup({ names: false });
  h.request(on());
  h.run();
  assertStatus(h.status(), "unavailable", null, CONFIG_SHA);
  assert.equal(downloads(h), 0);
  assert.equal(bootstraps(h), 0);
});

test("a failed download is failed, and the next run tries again", { skip }, () => {
  const h = setup();
  rmSync(join(h.stub, "serve", ZIP_NAME));
  h.request(on());
  h.run();
  assertStatus(h.status(), "failed", h.connectorSha, CONFIG_SHA);
  assert.equal(bootstraps(h), 0);
  assert.deepEqual(readdirSync(join(h.root, "connector")), []);

  writeFileSync(join(h.stub, "serve", ZIP_NAME), zip(CONNECTOR));
  h.request(on());
  h.run();
  assertStatus(h.status(), "running", h.connectorSha, CONFIG_SHA);
});

/** Each is refused, saying why, before anything is installed or started. */
const OTHER_FILES = /holds other files than its three/;
const TAMPERED = [
  ["a download with another sha-256", /not the one this Stuga names/, (h) => writeFileSync(join(h.stub, "serve", ZIP_NAME), zip([...CONNECTOR, { name: "x" }]))],
  ["a fourth file", OTHER_FILES, () => zip([...CONNECTOR, { name: "README", data: "hi\n" }])],
  ["a missing file", OTHER_FILES, () => zip([FRPC, LICENSE])],
  ["a directory", OTHER_FILES, () => zip([...CONNECTOR, { name: "lib/", mode: 0o40755 }])],
  ["a file in a directory", OTHER_FILES, () => zip([{ ...FRPC, name: "bin/frpc" }, LICENSE, NOTICES])],
  ["a path that climbs out", OTHER_FILES, () => zip([{ ...FRPC, name: "../frpc" }, LICENSE, NOTICES])],
  ["an absolute path", OTHER_FILES, () => zip([{ ...FRPC, name: "/tmp/frpc" }, LICENSE, NOTICES])],
  ["a symbolic link", OTHER_FILES, () => zip([{ name: "frpc", data: "/bin/sh", mode: 0o120777 }, LICENSE, NOTICES])],
  ["a corrupt archive", /could not be unpacked/, () => Buffer.from("not a zip")],
  ["a connector not signed as Stuga's", /not signed by Stuga \(8W9F4LY7AP\) as dev\.stuga\.remote/, (h) => writeFileSync(join(h.stub, "unsigned"), "")],
];
for (const [what, why, tamper] of TAMPERED) {
  test(`refuses ${what}`, { skip }, () => {
    const made = tamper.length === 0 ? tamper() : null;
    const h = setup(made ? { archive: made } : {});
    if (!made) tamper(h);
    h.request(on());
    h.run();

    const status = h.status();
    assertStatus(status, "refused", h.connectorSha, CONFIG_SHA);
    assert.match(status.message, why);
    assert.equal(bootstraps(h), 0);
    assert.ok(!existsSync(join(h.root, "connector", "current")));
    assert.deepEqual(readdirSync(join(h.root, "connector")), [], "nothing left behind");
  });
}

test("a connector that refuses its settings is refused, stopped and disabled", { skip }, () => {
  const h = setup();
  h.job("refuses");
  h.request(on());
  h.run();
  assertStatus(h.status(), "refused", h.connectorSha, CONFIG_SHA);
  assert.ok(!h.loaded());
  assert.equal(h.enabled(), "disabled");
});

test("a connector that exits otherwise is failed and left to launchd", { skip }, () => {
  const h = setup();
  h.job("fails");
  h.request(on());
  h.run();
  const status = h.status();
  assertStatus(status, "failed", h.connectorSha, CONFIG_SHA);
  assert.match(status.message, /status 1/);
  assert.ok(h.loaded());
});

test("launchd refusing the job is failed, with what it said", { skip }, () => {
  const h = setup();
  writeFileSync(join(h.stub, "bootstrap-fails"), "");
  h.request(on());
  h.run();
  const status = h.status();
  assertStatus(status, "failed", h.connectorSha, CONFIG_SHA);
  assert.match(status.message, /Input\/output error/);
});

test("however much launchd says, the status stays small enough for the node to read", { skip }, () => {
  const h = setup();
  writeFileSync(join(h.stub, "bootstrap-fails"), "Bootstrap failed: é\"\\\n".repeat(2000));
  h.request(on());
  h.run();
  assert.ok(lstatSync(join(h.root, "status", "remote.json")).size <= 4096);
  const status = h.status();
  assertStatus(status, "failed", h.connectorSha, CONFIG_SHA);
  assert.match(status.message, /^launchd did not start the connector: Bootstrap failed/);
});

test("a request that changes during a run is taken in another round", { skip }, () => {
  const h = setup();
  const script = join(h.stub, "on-download");
  writeFileSync(script, `#!/bin/bash\nrm -f "$STUGA_ROOT/requests/remote"\necho off > "$STUGA_ROOT/requests/remote"\n`);
  chmodSync(script, 0o755);
  h.request(on());
  h.run();
  assertStatus(h.status(), "stopped", null, null);
  assert.ok(!h.loaded());
  assert.equal(h.enabled(), "disabled");
  assert.equal(bootstraps(h), 0, "an off that came during the download is never started");
  assert.ok(!h.calls().includes("launchctl enable system/dev.stuga.remote"));
});

test("upgrade: a pending off goes before the download", { skip }, () => {
  const h = setup();
  h.request(on());
  h.run();
  h.clearCalls();

  h.request("off\n");
  writeFileSync(join(h.root, "requests", "upgrade"), "1.3.0\n");
  h.run();

  const calls = h.calls();
  const bootout = calls.indexOf("launchctl bootout system/dev.stuga.remote");
  const pkg = calls.findIndex((c) => c.startsWith("curl") && c.includes("/v1.3.0/Stuga-1.3.0.pkg"));
  assert.ok(bootout >= 0 && pkg > bootout, calls.join("\n"));
  assert.equal(h.status("upgrade.json").state, "failed", "the stub serves no package");
  assert.ok(!existsSync(join(h.root, "requests", "upgrade")));
  assertStatus(h.status(), "stopped", null, null);
});

test("upgrade: a request that names no newer version is refused", { skip }, () => {
  const h = setup();
  writeFileSync(join(h.root, "requests", "upgrade"), "1.2.3\n");
  h.run();
  assert.equal(h.status("upgrade.json").state, "refused");
  writeFileSync(join(h.root, "requests", "upgrade"), "latest\n");
  h.run();
  assert.deepEqual(h.status("upgrade.json").version, "");
  assert.equal(h.status("upgrade.json").state, "refused");
  assert.equal(downloads(h), 0);
});
