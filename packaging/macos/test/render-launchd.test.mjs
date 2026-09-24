// node --test packaging/macos/test/render-launchd.test.mjs (macOS: plutil)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const render = new URL("../build/render-launchd.sh", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs plutil";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Renders the agent plists; what the script printed on stderr. */
function renderAgent(out, ...flags) {
  const run = spawnSync(
    render,
    ["--mode", "agent", "--out", out, "--root", "/tmp/stuga root", "--logs", "/tmp/stuga logs", ...flags],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stderr;
}

const environment = (plist) =>
  JSON.parse(execFileSync("plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", plist], { encoding: "utf8" }));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "stuga-render-launchd-"));
  roots.push(dir);
  return join(dir, "launch d");
}

test("--keep-env carries variables the script does not set and renders the ones it does", { skip }, () => {
  const out = scratch();
  const node = join(out, "dev.stuga.local.node.plist");
  renderAgent(out, "--public-origin", "http://127.0.0.1:8787");
  execFileSync("plutil", ["-insert", "EnvironmentVariables.MEDIA_COOKIE_SAMESITE", "-string", "strict", node]);
  execFileSync("plutil", ["-insert", "EnvironmentVariables.STUGA_STDIO_ENTRY", "-string", "/opt/R&D <mcp>/stuga-mcp.js\n", node]);
  execFileSync("plutil", ["-replace", "EnvironmentVariables.PORT", "-string", "1111", node]);
  execFileSync("plutil", ["-replace", "EnvironmentVariables.EXTRA_ORIGINS", "-string", "http://nas.local:8787", node]);

  const printed = renderAgent(out, "--public-origin", "http://127.0.0.1:9000", "--port", "9000", "--keep-env");

  const env = environment(node);
  assert.equal(env.MEDIA_COOKIE_SAMESITE, "strict");
  assert.equal(env.STUGA_STDIO_ENTRY, "/opt/R&D <mcp>/stuga-mcp.js\n");
  assert.equal(env.PORT, "9000");
  assert.equal(env.PUBLIC_ORIGIN, "http://127.0.0.1:9000");
  assert.equal(env.EXTRA_ORIGINS, "");
  execFileSync("plutil", ["-lint", "-s", node]);
  assert.match(printed, /^kept MEDIA_COOKIE_SAMESITE from the previous dev\.stuga\.local\.node\.plist$/m);
  assert.match(printed, /^replaced EXTRA_ORIGINS from the previous dev\.stuga\.local\.node\.plist/m);
  assert.match(printed, /^replaced PORT from the previous/m);
  assert.doesNotMatch(printed, /http:\/\/nas\.local/, "a replaced value is not printed");
});

test("--keep-env names no variable whose value stays the same", { skip }, () => {
  const out = scratch();
  renderAgent(out, "--public-origin", "http://127.0.0.1:8787");

  const printed = renderAgent(out, "--public-origin", "http://127.0.0.1:8787", "--keep-env");

  assert.doesNotMatch(printed, /replaced|kept/);
});

test("without --keep-env a render starts from the template", { skip }, () => {
  const out = scratch();
  const node = join(out, "dev.stuga.local.node.plist");
  renderAgent(out, "--public-origin", "http://127.0.0.1:8787");
  execFileSync("plutil", ["-insert", "EnvironmentVariables.MEDIA_COOKIE_SAMESITE", "-string", "strict", node]);

  renderAgent(out, "--public-origin", "http://127.0.0.1:8787");

  assert.equal(environment(node).MEDIA_COOKIE_SAMESITE, undefined);
});

test("the agent restart hint names what a rebuild sets, the rebuild flags and the plist to edit", { skip }, () => {
  const out = scratch();
  renderAgent(out, "--public-origin", "http://127.0.0.1:8787");
  const hint = environment(join(out, "dev.stuga.local.node.plist")).STUGA_RESTART_HINT;
  assert.match(hint, /address, port, extra origins, data directory and database again/);
  assert.match(hint, /local-trial\/build\.sh \(--origin, --port, --local-only\)/);
  assert.ok(hint.includes(join(out, "dev.stuga.local.node.plist")), hint);
});

test("the upgrade hint says how this packaging moves to a newer version", { skip }, () => {
  const out = scratch();
  renderAgent(out, "--public-origin", "http://127.0.0.1:8787");
  const hint = environment(join(out, "dev.stuga.local.node.plist")).STUGA_UPGRADE_HINT;
  assert.match(hint, /Take a backup, update the checkout, and run packaging\/macos\/local-trial\/build\.sh again/);
});
