// node --test packaging/macos/test/release.test.mjs (macOS: BSD stat)
//
// runtime/bin/release.sh, sourced as helper.sh and bin/stuga source it, with id, spctl and xar
// stubbed on PATH: what a release is, how two compare, and the checks a package passes before root
// installs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const release = new URL("../runtime/bin/release.sh", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs macOS's stat";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NOTARIZED = "pkg: accepted\nsource=Notarized Developer ID\norigin=Developer ID Installer: Stuga AB (8W9F4LY7AP)\n";

const STUBS = {
  id: '#!/bin/bash\n[ "$1" = -u ] && { echo "${STUB_UID:-501}"; exit 0; }\nexec /usr/bin/id "$@"\n',
  spctl: '#!/bin/bash\necho "spctl $*" >> "$STUB_DIR/calls"\nprintf "%s" "$STUB_SPCTL" >&2\nexit "${STUB_SPCTL_STATUS:-0}"\n',
  xar: `#!/bin/bash
echo "xar $*" >> "$STUB_DIR/calls"
[ -n "\${STUB_VERSION:-}" ] || exit 1
printf '<installer-gui-script>\\n  <product id="dev.stuga" version="%s"/>\\n</installer-gui-script>\\n' "$STUB_VERSION" > Distribution
`,
  curl: '#!/bin/bash\necho "curl $*" >> "$STUB_DIR/calls"\nexit 22\n',
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "stuga-release-"));
  roots.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, "calls"), "");
  return { dir, bin };
}

/** Sources release.sh under set -euo pipefail and runs `script`; its status, stdout and stderr. */
function sh(script, { env = {}, args = [] } = {}) {
  const { dir, bin } = scratch();
  const run = spawnSync("/bin/bash", ["-c", `set -euo pipefail; . "$0"; ${script}`, release, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_DIR: dir, ...env },
    encoding: "utf8",
  });
  return { ...run, dir, calls: () => spawnSync("cat", [join(dir, "calls")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean) };
}

const yes = (script, args) => sh(`if ${script}; then echo yes; else echo no; fi`, { args }).stdout.trim();

test("a release is three numbers without leading zeros", { skip }, () => {
  for (const v of ["0.0.0", "0.1.12", "1.2.3", "10.20.30", "0.1.100"]) assert.equal(yes('is_release "$1"', [v]), "yes", v);
  for (const v of ["01.2.3", "1.02.3", "1.2.03", "0.0.0-ci", "0.0.0-dev", "local-abc1234", "1.2", "1.2.3.4", "v1.2.3", " 1.2.3", ""]) {
    assert.equal(yes('is_release "$1"', [v]), "no", JSON.stringify(v));
  }
});

test("newer compares each number as a number", { skip }, () => {
  assert.equal(yes('newer "$1" "$2"', ["0.1.10", "0.1.9"]), "yes");
  assert.equal(yes('newer "$1" "$2"', ["0.1.9", "0.1.10"]), "no");
  assert.equal(yes('newer "$1" "$2"', ["1.0.0", "0.99.99"]), "yes");
  assert.equal(yes('newer "$1" "$2"', ["0.1.12", "0.1.12"]), "no");
  assert.equal(yes('newer "$1" "$2"', ["0.2.0", "0.1.12"]), "yes");
});

test("a package's address comes from its release", { skip }, () => {
  const run = sh('package_url "$1"', { args: ["0.1.13"], env: { STUGA_RELEASES_URL: "https://releases.test/download" } });
  assert.equal(run.stdout, "https://releases.test/download/v0.1.13/Stuga-0.1.13.pkg\n");
});

test("only a release is downloaded", { skip }, () => {
  const run = sh('fetch_package "$1" "$2" || echo refused', { args: ["0.0.0-ci", "/dev/null"] });
  assert.equal(run.stdout.trim(), "refused");
  assert.deepEqual(run.calls(), []);
});

test("a work directory is its creator's alone", { skip }, () => {
  const run = sh("package_workdir stuga-release-test");
  assert.equal(run.status, 0, run.stderr);
  const dir = run.stdout.trim();
  roots.push(dir);
  assert.match(dir, /^\/private\/var\/tmp\/stuga-release-test\.[A-Za-z0-9]+$/);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

/** check_package on a package in a fresh 0700 directory; package_problem, or "" when it passes. */
function check({ spctl = NOTARIZED, spctlStatus = 0, version = "0.1.13", uid = "501", mode = 0o700 } = {}) {
  const { dir } = scratch();
  const pkgDir = join(dir, "work");
  mkdirSync(pkgDir, { mode });
  chmodSync(pkgDir, mode);
  writeFileSync(join(pkgDir, "Stuga-0.1.13.pkg"), "a package\n");
  const run = sh('if check_package "$1" "$2"; then echo "ok"; else echo "refused: $package_problem"; fi', {
    args: [join(pkgDir, "Stuga-0.1.13.pkg"), "0.1.13"],
    env: { STUB_SPCTL: spctl, STUB_SPCTL_STATUS: String(spctlStatus), STUB_VERSION: version, STUB_UID: uid },
  });
  assert.equal(run.status, 0, run.stderr);
  return { answer: run.stdout.trim(), dir: pkgDir, calls: run.calls() };
}

test("a notarized package of Stuga's team and the asked version passes", { skip }, () => {
  const { answer, dir } = check();
  assert.equal(answer, "ok");
  assert.ok(existsSync(join(dir, "Distribution")), "the Distribution is read beside the package");
});

test("a package refused by Gatekeeper is refused, whatever it printed", { skip }, () => {
  assert.equal(check({ spctlStatus: 3 }).answer, "refused: the package is not notarized and signed by Stuga (8W9F4LY7AP)");
});

test("a package not notarized is refused", { skip }, () => {
  const spctl = "pkg: accepted\nsource=Developer ID\norigin=Developer ID Installer: Stuga AB (8W9F4LY7AP)\n";
  assert.equal(check({ spctl }).answer, "refused: the package is not notarized and signed by Stuga (8W9F4LY7AP)");
});

test("a package of another team is refused", { skip }, () => {
  const spctl = "pkg: accepted\nsource=Notarized Developer ID\norigin=Developer ID Installer: Someone (ABCDE12345)\n";
  const { answer, calls } = check({ spctl });
  assert.equal(answer, "refused: the package is not notarized and signed by Stuga (8W9F4LY7AP)");
  assert.ok(!calls.some((c) => c.startsWith("xar")), "nothing is read from it");
});

test("a package of another version is refused", { skip }, () => {
  assert.equal(check({ version: "0.1.14" }).answer, "refused: the package is Stuga 0.1.14, not 0.1.13");
  assert.equal(check({ version: "" }).answer, "refused: the package is Stuga of no version, not 0.1.13");
});

test("as root, a package in a directory root does not own alone is refused before it is read", { skip }, () => {
  for (const mode of [0o700, 0o755]) {
    const { answer, calls } = check({ uid: "0", mode });
    assert.equal(answer, "refused: the package is not in a directory only root can write", mode.toString(8));
    assert.deepEqual(calls, [], "neither spctl nor xar ran");
  }
});
