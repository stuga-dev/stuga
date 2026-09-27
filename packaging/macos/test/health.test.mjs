// node --test packaging/macos/test/health.test.mjs (macOS: swiftc)
// The menu-bar apps' failure watch, the local trial's restart, and the mark a package's preinstall leaves while it stops Stuga.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const macos = new URL("..", import.meta.url).pathname;
const health = join(macos, "app/Health.swift");
const skip = process.platform !== "darwin" && "needs swiftc";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "stuga-health-"));
  roots.push(dir);
  return dir;
}

function swiftc(...args) {
  const run = spawnSync("swiftc", ["-swift-version", "5", ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

test("the failure watch tells a slow start from a failure", { skip }, () => {
  const binary = join(scratch(), "health-tests");
  swiftc("-parse-as-library", "-o", binary, health, join(macos, "test/HealthTests.swift"));
  const run = spawnSync(binary, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout.split("\n").filter((line) => line.startsWith("not ok")).join("\n"));
});

test("the local trial restarts a failed Stuga by stopping it first", { skip }, () => {
  const binary = join(scratch(), "trial-tests");
  swiftc("-parse-as-library", "-o", binary, health, join(macos, "local-trial/Lifecycle.swift"), join(macos, "test/TrialTests.swift"));
  const run = spawnSync(binary, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout.split("\n").filter((line) => line.startsWith("not ok")).join("\n"));
});

test("both menu-bar apps build with it, as their build scripts compile them", { skip }, () => {
  const apps = [
    { script: "pkg/build-pkg.sh", files: ["app/main.swift", "app/Health.swift"], flags: ["-target", "arm64-apple-macos13.0"] },
    { script: "local-trial/build.sh", files: ["local-trial/main.swift", "local-trial/Lifecycle.swift", "app/Health.swift"], flags: [] },
  ];
  for (const { script, files, flags } of apps) {
    const line = readFileSync(join(macos, script), "utf8").split("\n").find((l) => l.startsWith("swiftc "));
    assert.ok(line, `${script} compiles Swift`);
    for (const file of files) assert.match(line, new RegExp(`/${file.split("/").pop().replace(".", "\\.")}"`), `${script} compiles ${file}`);
    swiftc("-typecheck", ...flags, ...files.map((file) => join(macos, file)));
  }
});

/** A PATH whose launchctl answers `print` with FAKE_PRINT_STATUS and accepts `bootout`. */
function fakeLaunchctl() {
  const bin = join(scratch(), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "launchctl"), '#!/bin/sh\n[ "$1" = print ] && exit "${FAKE_PRINT_STATUS:-1}"\nexit 0\n');
  chmodSync(join(bin, "launchctl"), 0o755);
  return `${bin}:/usr/bin:/bin`;
}

const preinstall = join(macos, "pkg/scripts/preinstall");

test("preinstall marks an upgrade as stopping Stuga on purpose", () => {
  const root = join(scratch(), "Stuga");
  mkdirSync(root);
  const run = spawnSync("bash", [preinstall], { env: { STUGA_ROOT: root, PATH: fakeLaunchctl() }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(root, "status/installing")), "the mark is left for postinstall to clear");
});

test("preinstall marks nothing on a first install", () => {
  const root = join(scratch(), "Stuga");
  const run = spawnSync("bash", [preinstall], { env: { STUGA_ROOT: root, PATH: fakeLaunchctl() }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!existsSync(root), "nothing is created before the package installs");
});

test("preinstall stopped short takes its mark with it", async () => {
  const root = join(scratch(), "Stuga");
  mkdirSync(root);
  const mark = join(root, "status/installing");
  // The jobs stay loaded, so preinstall waits for them to go.
  const child = spawn("bash", [preinstall], { env: { STUGA_ROOT: root, PATH: fakeLaunchctl(), FAKE_PRINT_STATUS: "0" } });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 50 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(mark), "marked before it stops anything");
  child.kill("SIGTERM");
  await exited;
  assert.ok(!existsSync(mark), "the mark goes with it");
});
