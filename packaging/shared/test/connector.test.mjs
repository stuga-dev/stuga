// node --test packaging/shared/test/connector.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const lib = new URL("../connector/lib.sh", import.meta.url).pathname;
const build = new URL("../connector/build.sh", import.meta.url).pathname;
const helper = new URL("../../macos/runtime/bin/helper.sh", import.meta.url).pathname;
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Sources lib.sh and runs `script` with its arguments; stdout. */
function run(script, args = [], env = {}) {
  const result = spawnSync("bash", ["-c", `set -euo pipefail; . "$0"; ${script}`, lib, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "stuga-connector-"));
  roots.push(dir);
  return dir;
}

test("each target builds natively, with its own platform's Go", () => {
  const go = (target, os, machine) => run('go_for_target "$1" "$2" "$3" || echo none', [target, os, machine]).trim();
  assert.equal(go("darwin/arm64", "Darwin", "arm64"), "darwin-arm64 GO_DARWIN_ARM64_SHA256");
  assert.equal(go("linux/amd64", "Linux", "x86_64"), "linux-amd64 GO_LINUX_AMD64_SHA256");
  assert.equal(go("linux/arm64", "Linux", "aarch64"), "linux-arm64 GO_LINUX_ARM64_SHA256");
  assert.equal(go("linux/arm64", "Linux", "arm64"), "linux-arm64 GO_LINUX_ARM64_SHA256");
  assert.equal(go("linux/amd64", "Darwin", "arm64"), "none");
  assert.equal(go("darwin/arm64", "Linux", "aarch64"), "none");
  assert.equal(go("linux/arm64", "Linux", "x86_64"), "none");
  assert.equal(go("linux/386", "Linux", "i686"), "none");
});

/** build.sh with these arguments, for the ones it refuses before it downloads anything. */
function refused(args) {
  const result = spawnSync("bash", [build, ...args], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stderr: result.stderr };
}

test("build.sh needs a target, one of three", () => {
  const out = scratch();
  assert.equal(refused(["--out", out]).status, 2);
  const other = refused(["--target", "windows/amd64", "--out", out]);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /--target is darwin\/arm64, linux\/amd64 or linux\/arm64/);
});

test("build.sh signs only the Mac's connector, and builds only natively", () => {
  const out = scratch();
  const signed = refused(["--target", "linux/amd64", "--out", out, "--identity", "Developer ID Application: Liv"]);
  assert.equal(signed.status, 2);
  assert.match(signed.stderr, /only the darwin\/arm64 connector is signed/);
  const native = `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;
  const foreign = native === "darwin/arm64" ? "linux/amd64" : "darwin/arm64";
  const cross = refused(["--target", foreign, "--out", out]);
  assert.equal(cross.status, 1);
  assert.match(cross.stderr, new RegExp(`build ${foreign} on ${foreign}, not on `));
});

test("the requirement is the helper's, of the team helper.sh pins", () => {
  const team = run('pinned_team "$1"', [helper]).trim();
  assert.equal(team, "8W9F4LY7AP");
  assert.equal(
    run('connector_requirement "$1"', [team]),
    '=anchor apple generic and certificate leaf[subject.OU] = "8W9F4LY7AP" and identifier "dev.stuga.remote" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]',
  );
});

test("a helper that pins no team gives none", () => {
  const file = join(scratch(), "helper.sh");
  writeFileSync(file, 'local team="${STUGA_TEAM:-X}"\n');
  assert.equal(run('pinned_team "$1"', [file]), "");
});

test("zip entries come in byte order whatever the locale", { skip: !hasZip() && "needs zip" }, () => {
  const dir = scratch();
  for (const name of ["frpc", "LICENSE", "THIRD-PARTY-NOTICES.txt"]) writeFileSync(join(dir, name), name);
  const made = spawnSync("zip", ["-X", "-q", "c.zip", "frpc", "LICENSE", "THIRD-PARTY-NOTICES.txt"], { cwd: dir });
  assert.equal(made.status, 0);
  for (const locale of ["C", "C.UTF-8", "en_US.UTF-8"]) {
    assert.equal(
      run('zip_members "$1"', [join(dir, "c.zip")], { LC_ALL: locale, LANG: locale }),
      "LICENSE THIRD-PARTY-NOTICES.txt frpc ",
      locale,
    );
  }
});

test("NOTICE files beside the license and at the module root", () => {
  const license = scratch();
  const root = scratch();
  writeFileSync(join(license, "LICENSE"), "");
  writeFileSync(join(license, "NOTICE"), "");
  writeFileSync(join(root, "NOTICE.txt"), "");
  mkdirSync(join(root, "NOTICES"));
  assert.equal(run('notice_files "$1" "$2"', [license, root]), `${license}/NOTICE\n${root}/NOTICE.txt\n`);
  assert.equal(run('notice_files "$1"', [scratch()]), "");
});

test("module paths and versions are case-escaped as the module cache spells them", () => {
  assert.equal(
    run('module_dir "$1" "$2"', ["github.com/Azure/go-ntlmssp", "v0.1.0-RC"], { GOMODCACHE: "/m" }),
    "/m/github.com/!azure/go-ntlmssp@v0.1.0-!r!c",
  );
});

function hasZip() {
  return spawnSync("zip", ["-v"]).status === 0 && spawnSync("unzip", ["-v"]).status === 0;
}
