// node --test packaging/macos/test/uninstall.test.mjs
//
// uninstall.sh with a PATH that holds only stubs, so every command it runs is one of them and
// nothing reaches the real system: an unstubbed command is not found and fails the run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const uninstall = new URL("../runtime/bin/uninstall.sh", import.meta.url).pathname;
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const LABELS = ["dev.stuga.helper", "dev.stuga.remote", "dev.stuga.node", "dev.stuga.postgres"];

// Builtins only: there is no PATH to find anything else on. While the helper is still loaded it may
// be starting the connector, so a connector booted out before it is marked started again.
const STUBS = {
  id: "#!/bin/bash\necho 0\n",
  launchctl: [
    "#!/bin/bash",
    'echo "launchctl $*" >> "$STUB_DIR/calls"',
    '[ "$1" = bootout ] || exit 0',
    'label="${2#system/}"',
    'echo "$label" >> "$STUB_DIR/booted-out"',
    ': > "$STUB_DIR/out-$label"',
    'if [ "$label" = dev.stuga.remote ] && [ ! -f "$STUB_DIR/out-dev.stuga.helper" ]; then : > "$STUB_DIR/restarted"; fi',
    "",
  ].join("\n"),
  rm: String.raw`#!/bin/bash
echo "rm $*" >> "$STUB_DIR/calls"
`,
  pkgutil: String.raw`#!/bin/bash
echo "pkgutil $*" >> "$STUB_DIR/calls"
`,
  dscl: String.raw`#!/bin/bash
echo "dscl $*" >> "$STUB_DIR/calls"
`,
  osascript: String.raw`#!/bin/bash
echo "osascript $*" >> "$STUB_DIR/calls"
`,
};

function run(...args) {
  const stub = mkdtempSync(join(tmpdir(), "stuga-uninstall-"));
  roots.push(stub);
  const bin = join(stub, "bin");
  mkdirSync(bin);
  writeFileSync(join(stub, "calls"), "");
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const result = spawnSync("/bin/bash", [uninstall, ...args], { env: { PATH: bin, STUB_DIR: stub }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = (file) => (existsSync(join(stub, file)) ? readFileSync(join(stub, file), "utf8").split("\n").filter(Boolean) : []);
  return { calls: lines("calls"), bootedOut: lines("booted-out"), restarted: existsSync(join(stub, "restarted")) };
}

test("the helper goes first, so it cannot start the connector again; the node before Postgres", () => {
  const { bootedOut, restarted } = run();
  assert.deepEqual(bootedOut, LABELS);
  assert.ok(!restarted, "the connector was booted out while the helper could still start it");
});

test("each job's plist is removed after it is booted out", () => {
  const { calls } = run();
  for (const label of LABELS) {
    const out = calls.indexOf(`launchctl bootout system/${label}`);
    const plist = calls.indexOf(`rm -f /Library/LaunchDaemons/${label}.plist`);
    assert.ok(out >= 0 && plist > out, `${label}: ${calls.join("\n")}`);
  }
});

test("--delete-data also removes both accounts", () => {
  const { calls } = run("--delete-data");
  for (const account of ["_stuga", "_stugaremote"]) {
    assert.ok(calls.includes(`dscl . -delete /Users/${account}`), calls.join("\n"));
    assert.ok(calls.includes(`dscl . -delete /Groups/${account}`), calls.join("\n"));
  }
});

test("sends the menu-bar app nothing: the app is what waits for this script, and it quits itself", () => {
  const { calls } = run();
  assert.ok(!calls.some((call) => call.startsWith("osascript")), calls.join("\n"));
});
