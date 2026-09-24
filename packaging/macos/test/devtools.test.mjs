// node --test packaging/macos/test/devtools.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const helper = new URL("../build/lib/devtools.sh", import.meta.url).pathname;
const CLT = "/Library/Developer/CommandLineTools";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Source the helper with a stub xcrun whose body is `script`; returns DEVELOPER_DIR afterwards. */
function select(script, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "stuga-devtools-"));
  roots.push(bin);
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "xcrun"), 0o755);
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; . "$1"; use_working_developer_tools; printf '%s' "\${DEVELOPER_DIR-unset}"`, "bash", helper],
    { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return { developerDir: result.stdout, stderr: result.stderr };
}

test("working tools leave DEVELOPER_DIR unset", () => {
  assert.equal(select("exit 0").developerDir, "unset");
});

test("an Xcode that refuses to run its tools falls back to the Command Line Tools", () => {
  const { developerDir, stderr } = select(`[ "\${DEVELOPER_DIR:-}" = ${CLT} ] && exit 0; exit 69`);
  assert.equal(developerDir, CLT);
  assert.match(stderr, /Command ?Line ?Tools/);
});

test("no fallback when the Command Line Tools refuse too", () => {
  assert.equal(select("exit 69").developerDir, "unset");
});

test("a DEVELOPER_DIR the caller set is kept", () => {
  const chosen = "/Applications/Xcode-beta.app/Contents/Developer";
  assert.equal(select("exit 69", { DEVELOPER_DIR: chosen }).developerDir, chosen);
});
