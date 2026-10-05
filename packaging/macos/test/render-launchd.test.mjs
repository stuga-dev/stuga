// node --test packaging/macos/test/render-launchd.test.mjs (macOS: plutil)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const render = new URL("../build/render-launchd.sh", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs plutil";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const SERVICE = "https://api.stuga.dev";

/** The script's environment: remote access is rendered only when STUGA_REMOTE_SERVICE is in it. */
const renderEnv = (remote) => {
  const { STUGA_REMOTE_SERVICE: _, ...rest } = process.env;
  return remote ? { ...rest, STUGA_REMOTE_SERVICE: SERVICE } : rest;
};

/** Renders the agent plists; what the script printed on stderr. */
function renderAgent(out, ...flags) {
  return renderAgentWith(false, out, ...flags);
}

function renderAgentWith(remote, out, ...flags) {
  const run = spawnSync(
    render,
    ["--mode", "agent", "--out", out, "--root", "/tmp/stuga root", "--logs", "/tmp/stuga logs", ...flags],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: renderEnv(remote) },
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

/** Renders the daemon plists into a scratch directory. */
function renderDaemon(out, remote = true) {
  const run = spawnSync(
    render,
    ["--mode", "daemon", "--out", out, "--root", "/tmp/stuga root", "--logs", "/tmp/stuga logs", "--public-origin", "http://livs-air.local:8787"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: renderEnv(remote) },
  );
  assert.equal(run.status, 0, run.stderr);
}

const plist = (path) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));

test("daemon mode renders the four jobs, the connector's as _stugaremote", { skip }, () => {
  const out = scratch();
  renderDaemon(out);
  assert.deepEqual(readdirSync(out).sort(), ["dev.stuga.helper.plist", "dev.stuga.node.plist", "dev.stuga.postgres.plist", "dev.stuga.remote.plist"]);
  const remote = plist(join(out, "dev.stuga.remote.plist"));
  assert.equal(remote.Label, "dev.stuga.remote");
  assert.equal(remote.UserName, "_stugaremote");
  assert.equal(remote.GroupName, "_stugaremote");
  assert.deepEqual(remote.ProgramArguments, ["/tmp/stuga root/current/bin/stuga-job", "/tmp/stuga root/current/bin/remote-wrapper.sh"]);
  assert.deepEqual(remote.EnvironmentVariables, { STUGA_ROOT: "/tmp/stuga root", STUGA_LOG_DIR: "/tmp/stuga logs/remote" });
  assert.deepEqual(remote.KeepAlive, { SuccessfulExit: false });
  assert.equal(remote.ThrottleInterval, 10);
  assert.equal(remote.ExitTimeOut, 5);
  assert.equal(remote.WorkingDirectory, "/var/empty");
  assert.equal(remote.AssociatedBundleIdentifiers, "dev.stuga.app");
  assert.equal(remote.StandardOutPath, "/tmp/stuga logs/remote/remote-wrapper.log");
  assert.equal(remote.StandardErrorPath, "/tmp/stuga logs/remote/remote-wrapper.log");
  assert.equal(remote.AbandonProcessGroup, undefined);
});

test("daemon mode points the node at the helper for upgrades and the connector", { skip }, () => {
  const out = scratch();
  renderDaemon(out);
  const node = plist(join(out, "dev.stuga.node.plist"));
  assert.equal(node.UserName, "_stuga");
  assert.equal(node.EnvironmentVariables.STUGA_REMOTE_SERVICE, "https://api.stuga.dev");
  assert.equal(node.EnvironmentVariables.STUGA_REMOTE_DIR, "/tmp/stuga root/remote");
  assert.equal(node.EnvironmentVariables.STUGA_CONNECTOR_REQUEST, "/tmp/stuga root/requests/remote");
  assert.equal(node.EnvironmentVariables.STUGA_CONNECTOR_STATUS, "/tmp/stuga root/status/remote.json");
  assert.equal(node.EnvironmentVariables.STUGA_UPGRADE_REQUESTS, "/tmp/stuga root/requests");
  assert.equal(node.EnvironmentVariables.STUGA_UPGRADE_STATUS, "/tmp/stuga root/status/upgrade.json");
  // Where the Mac's administrators read it, with no password.
  assert.equal(node.EnvironmentVariables.SETUP_CODE_FILE, "/tmp/stuga root/setup/setup-code");
  // So the Mac's .local name is published while the node runs.
  assert.equal(node.EnvironmentVariables.STUGA_BONJOUR_NAME, "Stuga");
  // The helper watches the directory both requests go into.
  assert.deepEqual(plist(join(out, "dev.stuga.helper.plist")).WatchPaths, ["/tmp/stuga root/requests"]);
});

test("daemon mode gives the web the command that restores a backup on this Mac", { skip }, () => {
  const out = scratch();
  renderDaemon(out);
  const command = plist(join(out, "dev.stuga.node.plist")).EnvironmentVariables.STUGA_RESTORE_COMMAND;
  assert.equal(command, 'sudo "/tmp/stuga root/current/bin/stuga" restore {backup}');
});

test("agent mode keeps remote access and the setup code in the data directory, and drops the helper's paths", { skip }, () => {
  const out = scratch();
  renderAgentWith(true, out, "--public-origin", "http://127.0.0.1:8787");
  assert.deepEqual(readdirSync(out).sort(), ["dev.stuga.local.node.plist", "dev.stuga.local.postgres.plist"]);
  const env = environment(join(out, "dev.stuga.local.node.plist"));
  assert.equal(env.STUGA_REMOTE_DIR, "/tmp/stuga root/remote");
  assert.equal(env.STUGA_REMOTE_SERVICE, "https://api.stuga.dev");
  for (const key of ["STUGA_CONNECTOR_REQUEST", "STUGA_CONNECTOR_STATUS", "STUGA_UPGRADE_REQUESTS", "STUGA_UPGRADE_STATUS", "SETUP_CODE_FILE", "STUGA_BONJOUR_NAME", "STUGA_RESTORE_COMMAND"]) {
    assert.equal(env[key], undefined, key);
  }
});

test("without STUGA_REMOTE_SERVICE the node's plist carries no remote access variables", { skip }, () => {
  for (const mode of ["daemon", "agent"]) {
    const out = scratch();
    if (mode === "daemon") renderDaemon(out, false);
    else renderAgent(out, "--public-origin", "http://127.0.0.1:8787");
    const env = environment(join(out, mode === "daemon" ? "dev.stuga.node.plist" : "dev.stuga.local.node.plist"));
    for (const key of ["STUGA_REMOTE_SERVICE", "STUGA_REMOTE_DIR", "STUGA_CONNECTOR_REQUEST", "STUGA_CONNECTOR_STATUS"]) {
      assert.equal(env[key], undefined, `${mode} ${key}`);
    }
  }
});
