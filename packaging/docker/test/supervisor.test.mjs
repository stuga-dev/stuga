// node --test packaging/docker/test/supervisor.test.mjs
//
// The stuga-remote image's supervisor.sh, with a stub connector that records how it was started. The
// config it accepts is the node's documented one, taken from services/node's golden test, and the
// request and status are the node's (services/node/src/remote/connector.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

const supervisor = new URL("../remote/supervisor.sh", import.meta.url).pathname;
const checkToml = new URL("../../shared/connector/check-toml.sh", import.meta.url).pathname;
const roots = [];
const children = new Set();
after(() => {
  for (const child of children) child.kill("SIGKILL");
  roots.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const golden = readFileSync(new URL("../../../services/node/src/remote/frpc-config.test.ts", import.meta.url), "utf8");
const GOLDEN = /const GOLDEN = `([^`]*)`;/.exec(golden)[1];
const GOLDEN_DIR = "/Users/liv/.stuga-remote";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
// A relay whose file name carries lines of its own: frpc would read them as settings, an admin API among them.
const INJECTED = 'x"\nmetadatas.z = \'\'\'\nwebServer.port = 7400\nuser = """\nok\n"""\nmetadatas.a = "';

// Records its arguments and the config it was given, then runs until TERM, or exits as told.
const FRPC = String.raw`#!/bin/bash
here="$(cd "$(dirname "$0")" && pwd)"
{ printf '%s\n' "$@"; } > "$here/../started.$$"
cp "$2" "$here/../config.$$"
[ ! -f "$here/../exit-now" ] || exit 3
trap 'touch "$here/../stopped.$$"; exit 0' TERM
while :; do sleep 0.1; done
`;

function setup({ frpc = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "stuga-supervisor-"));
  roots.push(base);
  const dir = join(base, "remote");
  for (const sub of ["bin", "tmp", "remote/control", "remote/status"]) mkdirSync(join(base, sub), { recursive: true });
  // As the image lays them out: check-toml.sh beside the supervisor.
  symlinkSync(supervisor, join(base, "bin/supervisor.sh"));
  symlinkSync(checkToml, join(base, "bin/check-toml.sh"));
  if (frpc) {
    writeFileSync(join(base, "bin/frpc"), FRPC);
    chmodSync(join(base, "bin/frpc"), 0o755);
  }
  const files = (prefix) => readdirSync(base).filter((n) => n.startsWith(prefix));
  let writes = 0;
  return {
    base,
    dir,
    frpcSha: frpc ? createHash("sha256").update(FRPC).digest("hex") : null,
    env: {
      PATH: process.env.PATH,
      TMPDIR: join(base, "tmp"),
      STUGA_REMOTE_DIR: dir,
      STUGA_FRPC: join(base, "bin/frpc"),
      STUGA_REMOTE_POLL: "0.1",
      STUGA_REMOTE_SETTLE: "1",
      STUGA_REMOTE_PAUSE: "1",
    },
    /** The node's config for `relay`, as the golden test has it, in this directory. */
    config: (relay = "relay-1") =>
      GOLDEN.replaceAll(GOLDEN_DIR, dir).replaceAll("relay-1.jwt", `${relay}.jwt`).replaceAll("relay-1.ca.pem", `${relay}.ca.pem`),
    write(text, relay = "relay-1") {
      writeFileSync(join(dir, `${relay}.toml`), text);
    },
    /** As the node asks: a new file renamed into place, even for the same line. */
    ask(line) {
      const tmp = join(dir, "control", `.request.${++writes}.tmp`);
      writeFileSync(tmp, `${line}\n`);
      renameSync(tmp, join(dir, "control/request"));
    },
    status() {
      try {
        return JSON.parse(readFileSync(join(dir, "status/status.json"), "utf8"));
      } catch {
        return null;
      }
    },
    started: () => files("started.").map((n) => readFileSync(join(base, n), "utf8").trim().split("\n")),
    given: () => files("config.").map((n) => readFileSync(join(base, n), "utf8")),
    stopped: () => files("stopped.").length,
  };
}

/** Starts the supervisor; `exited` resolves with its exit and what it logged. */
function run(h) {
  const child = spawn("bash", [join(h.base, "bin/supervisor.sh")], { env: h.env, stdio: ["ignore", "ignore", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stderr });
    }),
  );
  return { child, exited, log: () => stderr };
}

/** Waits until `check` holds, for up to 10 s. */
async function until(check, what, log = () => "") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(50);
  }
  assert.fail(`timed out waiting for ${what}\n${log()}`);
}

async function stop(s) {
  s.child.kill("SIGTERM");
  const { code, stderr } = await s.exited;
  assert.equal(code, 0, stderr);
}

test("with no request it runs nothing, writes nothing and stays healthy", async () => {
  const h = setup();
  const health = () => spawnSync("bash", [join(h.base, "bin/supervisor.sh"), "health"], { env: h.env }).status;
  assert.notEqual(health(), 0, "no heartbeat before it runs");
  const s = run(h);
  await until(() => existsSync(join(h.base, "tmp/stuga-remote.alive")), "the heartbeat", s.log);
  await delay(500);
  assert.equal(health(), 0);
  assert.equal(h.status(), null);
  assert.deepEqual(h.started(), []);
  await stop(s);
  // A heartbeat 30 s old is not healthy.
  const old = new Date(Date.now() - 31_000);
  utimesSync(join(h.base, "tmp/stuga-remote.alive"), old, old);
  assert.notEqual(health(), 0);
});

test("off is reported stopped, with no shas", async () => {
  const h = setup();
  h.ask("off");
  const s = run(h);
  await until(() => h.status()?.state === "stopped", "stopped", s.log);
  const status = h.status();
  assert.equal(status.connector_sha, null);
  assert.equal(status.config_sha, null);
  assert.match(status.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(h.started(), []);
  await stop(s);
});

test("on starts one connector per relay from checked private copies, then off stops them", async () => {
  const h = setup();
  h.write(h.config("relay-1"), "relay-1");
  h.write(h.config("relay-2").replace('log.level = "info"', 'log.level = "warn"'), "relay-2");
  h.ask(`on ${SHA_A}`);
  const s = run(h);
  await until(() => h.status()?.state === "running", "running", s.log);
  assert.deepEqual(h.status(), { ...h.status(), config_sha: SHA_A, connector_sha: h.frpcSha });
  const started = h.started();
  assert.equal(started.length, 2);
  for (const args of started) {
    assert.equal(args.length, 3, args.join(" "));
    assert.equal(args[0], "-c");
    assert.equal(args[2], "--strict-config");
    assert.ok(args[1].startsWith(join(h.base, "tmp")), `the copy is private: ${args[1]}`);
    assert.match(args[1], /\/relay-[12]\.toml$/);
  }
  assert.deepEqual(h.given().sort(), [h.config("relay-1"), h.config("relay-2").replace('"info"', '"warn"')].sort());

  h.ask("off");
  await until(() => h.status()?.state === "stopped", "stopped", s.log);
  assert.equal(h.stopped(), 2, "each connector was sent TERM");
  for (const args of started) assert.ok(!existsSync(args[1]), "the private copy goes");
  await stop(s);
});

test("restarts only when the config sha changes", async () => {
  const h = setup();
  h.write(h.config());
  h.ask(`on ${SHA_A}`);
  const s = run(h);
  await until(() => h.status()?.state === "running", "running", s.log);
  const first = h.status();

  // The same line again, as the node writes it while it waits for an answer: answered, not restarted.
  await delay(1100);
  h.ask(`on ${SHA_A}`);
  await until(() => h.status().at !== first.at, "a fresh status", s.log);
  assert.equal(h.status().state, "running");
  // A new credential is not in the sha.
  writeFileSync(join(h.dir, "relay-1.jwt"), "new");
  await delay(500);
  assert.equal(h.started().length, 1);
  assert.equal(h.stopped(), 0);

  h.ask(`on ${SHA_B}`);
  await until(() => h.status()?.config_sha === SHA_B && h.status().state === "running", "running the new settings", s.log);
  assert.equal(h.started().length, 2);
  assert.equal(h.stopped(), 1);
  await stop(s);
  assert.equal(h.stopped(), 2, "TERM stops the connectors");
});

test("a refused config starts nothing, and waits for the node to ask again", async () => {
  const h = setup();
  h.write(`${h.config()}webServer.port = 7400\n`);
  h.ask(`on ${SHA_A}`);
  const s = run(h);
  await until(() => h.status()?.state === "refused", "refused", s.log);
  assert.match(h.status().message, /relay-1\.toml is not the config the node writes/);
  assert.equal(h.status().config_sha, SHA_A);
  const at = h.status().at;
  await delay(1500);
  assert.equal(h.status().at, at, "not tried again unasked");
  assert.deepEqual(h.started(), []);

  h.write(h.config());
  h.ask(`on ${SHA_A}`);
  await until(() => h.status()?.state === "running", "running once asked again", s.log);
  await stop(s);
});

for (const [what, prepare] of [
  ["a request that is neither on nor off", (h) => h.ask("on please")],
  ["a request with a short sha", (h) => h.ask("on abc")],
  ["a request that is a symbolic link", (h) => {
    writeFileSync(join(h.base, "elsewhere"), "off\n");
    symlinkSync(join(h.base, "elsewhere"), join(h.dir, "control/request"));
  }],
  ["a config under a name that is not a relay's", (h) => {
    h.write(h.config("Relay_1"), "Relay_1");
    h.ask(`on ${SHA_A}`);
  }],
  ["a config under a relay's name with lines of its own", (h) => {
    h.write(h.config(INJECTED), INJECTED);
    h.ask(`on ${SHA_A}`);
  }],
  ["a config that is a symbolic link", (h) => {
    writeFileSync(join(h.base, "elsewhere.toml"), h.config());
    symlinkSync(join(h.base, "elsewhere.toml"), join(h.dir, "relay-1.toml"));
    h.ask(`on ${SHA_A}`);
  }],
  ["a config naming a path outside the directory", (h) => {
    h.write(h.config().replace(`"${h.dir}/relay-1.ca.pem"`, `"/etc/ssl/cert.pem"`));
    h.ask(`on ${SHA_A}`);
  }],
]) {
  test(`refuses ${what}`, async () => {
    const h = setup();
    prepare(h);
    const s = run(h);
    await until(() => h.status()?.state === "refused", "refused", s.log);
    assert.deepEqual(h.started(), []);
    await stop(s);
  });
}

test("check_config refuses a relay's name with lines of its own", () => {
  const h = setup();
  const copy = join(h.base, "tmp/copy.toml");
  writeFileSync(copy, h.config(INJECTED));
  const result = spawnSync("bash", ["-c", '. "$1"; check_config "$2" "$3" "$4" || { echo "$reason"; exit 1; }', "-", checkToml, copy, INJECTED, h.dir], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /the relay's name is not a relay/);
});

test("a request it may not read is a failure, not a refusal", { skip: process.getuid?.() === 0 && "root reads anything" }, async () => {
  const h = setup();
  h.ask("off");
  chmodSync(join(h.dir, "control/request"), 0o200);
  const s = run(h);
  await until(() => h.status()?.state === "failed", "failed", s.log);
  assert.match(h.status().message, /not readable/);
  chmodSync(join(h.dir, "control/request"), 0o600);
  h.ask("off");
  await until(() => h.status()?.state === "stopped", "stopped once readable", s.log);
  await stop(s);
});

test("a connector that exits stops the others, and they start again after a pause", async () => {
  const h = setup();
  h.write(h.config("relay-1"), "relay-1");
  h.write(h.config("relay-2"), "relay-2");
  writeFileSync(join(h.base, "exit-now"), "");
  h.ask(`on ${SHA_A}`);
  const s = run(h);
  await until(() => h.status()?.state === "failed", "failed", s.log);
  assert.match(h.status().message, /exited with status 3/);
  assert.equal(h.status().config_sha, SHA_A);
  rmSync(join(h.base, "exit-now"));
  await until(() => h.status()?.state === "running", "running again", s.log);
  await stop(s);
});

test("with no relay settings it fails, and waits for the node to ask again", async () => {
  const h = setup();
  h.ask(`on ${SHA_A}`);
  const s = run(h);
  await until(() => h.status()?.state === "failed", "failed", s.log);
  assert.match(h.status().message, /no relay settings/);
  h.write(h.config());
  await delay(1500);
  assert.equal(h.status().state, "failed", "not tried again unasked");
  h.ask(`on ${SHA_A}`);
  await until(() => h.status()?.state === "running", "running once asked again", s.log);
  await stop(s);
});

test("an image without the connector reports it unavailable", async () => {
  const h = setup({ frpc: false });
  h.write(h.config());
  h.ask(`on ${SHA_A}`);
  const s = run(h);
  await until(() => h.status()?.state === "unavailable", "unavailable", s.log);
  await stop(s);
});

test("a status directory it cannot write yet is written once it can", async () => {
  const h = setup();
  rmSync(join(h.dir, "status"), { recursive: true });
  h.ask("off");
  const s = run(h);
  await until(() => /could not write/.test(s.log()), "the failure said", s.log);
  mkdirSync(join(h.dir, "status"));
  await until(() => h.status()?.state === "stopped", "stopped", s.log);
  await stop(s);
});

test("refuses to start on a directory its configs cannot name", () => {
  const h = setup();
  const result = spawnSync("bash", [join(h.base, "bin/supervisor.sh")], {
    env: { ...h.env, STUGA_REMOTE_DIR: `${h.dir}/` },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 78, result.stderr);
});

test("never passes --allow-unsafe", () => {
  assert.doesNotMatch(readFileSync(supervisor, "utf8").replace(/^#.*$/gm, ""), /allow-unsafe/);
});
