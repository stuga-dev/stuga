// postinstall's prune_runtimes, run as the package runs it (set -euo pipefail) against a temporary
// root: only the runtime the package installed stays. Its jobs are enabled before they start, and
// what _stuga can change, root changes only as _stuga.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync(new URL("../pkg/scripts/postinstall", import.meta.url), "utf8");
const prune = /^prune_runtimes\(\) \{\n[\s\S]*?^\}\n/m.exec(script);
assert.ok(prune, "postinstall defines prune_runtimes");
assert.match(script, /^  prune_runtimes "\$root" "\$version"$/m, "postinstall prunes with the version it installed");

function run(runtimes, version) {
  const root = mkdtempSync(join(tmpdir(), "stuga-runtimes-"));
  try {
    mkdirSync(join(root, "runtime"));
    for (const name of runtimes) {
      mkdirSync(join(root, "runtime", name, "bin"), { recursive: true });
      writeFileSync(join(root, "runtime", name, "bin", "uninstall.sh"), "");
    }
    execFileSync("bash", ["-c", `set -euo pipefail\n${prune[0]}\nprune_runtimes "$1" "$2"`, "bash", root, version]);
    return readdirSync(join(root, "runtime"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an upgrade keeps only the new runtime", () => {
  assert.deepEqual(run(["0.1.10", "0.1.11", "0.1.12"], "0.1.12"), ["0.1.12"]);
});

test("a reinstall of the same version keeps it", () => {
  assert.deepEqual(run(["0.1.12"], "0.1.12"), ["0.1.12"]);
});

test("an older package opened over a newer one keeps only its own", () => {
  assert.deepEqual(run(["0.1.11", "0.1.12"], "0.1.11"), ["0.1.11"]);
});

test("an empty runtime directory is not an error", () => {
  assert.deepEqual(run([], "0.1.12"), []);
});

test("each job is enabled before it is started: a go-back that stopped short leaves the node disabled", () => {
  const loop = /^  for label in dev\.stuga\.postgres dev\.stuga\.node; do\n([\s\S]*?)^  done$/m.exec(script);
  assert.ok(loop, "postinstall starts both jobs in one loop");
  const lines = loop[1].split("\n").map((line) => line.trim());
  const enable = lines.indexOf('launchctl enable "system/$label"');
  const bootstrap = lines.indexOf('launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"');
  assert.ok(enable >= 0 && bootstrap > enable, loop[1]);
});

test("what _stuga can change, root changes only as _stuga: Time Machine's exclusions and the old setup code", () => {
  const code = script.replace(/^\s*#.*$/gm, "");
  const tmutil = code.split("\n").filter((line) => /\btmutil\b/.test(line));
  assert.deepEqual(tmutil.map((line) => line.trim().split(" ").slice(0, 3).join(" ")), ["as_stuga /usr/bin/tmutil addexclusion"]);
  assert.match(tmutil[0], /addexclusion "\$root\/data\/pgdata" "\$root\/data\/node"/);

  const asStuga = /^as_stuga\(\) \{.*\}$/m.exec(script);
  const move = /^  if \[ -f "\$root\/data\/node\/setup-code" \]; then\n[\s\S]*?^  fi$/m.exec(script);
  assert.ok(asStuga && move, "postinstall defines as_stuga and moves the setup code");
  const root = mkdtempSync(join(tmpdir(), "stuga-setup-code-"));
  try {
    // sudo that runs only as _stuga, and says so.
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "sudo"), `#!/bin/bash\n[ "$1 $2" = "-u _stuga" ] || exit 1\necho "$PWD" > "${root}/sudo-cwd"\nshift 2\nexec "$@"\n`);
    chmodSync(join(root, "bin", "sudo"), 0o755);
    mkdirSync(join(root, "data", "node"), { recursive: true });
    mkdirSync(join(root, "setup"));
    writeFileSync(join(root, "data", "node", "setup-code"), "123456\n", { mode: 0o600 });
    execFileSync("bash", ["-c", `set -euo pipefail\n${asStuga[0]}\nroot="$1"\n${move[0]}`, "bash", root], {
      env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` },
    });
    assert.equal(readFileSync(join(root, "setup", "setup-code"), "utf8"), "123456\n");
    assert.equal(statSync(join(root, "setup", "setup-code")).mode & 0o777, 0o640);
    assert.ok(!existsSync(join(root, "data", "node", "setup-code")));
    assert.equal(readFileSync(join(root, "sudo-cwd"), "utf8"), "/\n", "from a directory _stuga can enter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
