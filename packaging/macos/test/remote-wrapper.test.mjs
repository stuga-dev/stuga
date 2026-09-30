// node --test packaging/macos/test/remote-wrapper.test.mjs (macOS: /bin/bash 3.2)
//
// remote-wrapper.sh under macOS's own bash, with a stub connector that records how it was started.
// The config it accepts is the node's documented one, taken from services/node's golden test, so a
// change to what the node renders fails here until the wrapper follows it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

const wrapper = new URL("../runtime/bin/remote-wrapper.sh", import.meta.url).pathname;
const rotate = new URL("../runtime/bin/rotate-log.mjs", import.meta.url).pathname;
const checkToml = new URL("../../shared/connector/check-toml.sh", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "runs under macOS's /bin/bash";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const golden = readFileSync(new URL("../../../services/node/src/remote/frpc-config.test.ts", import.meta.url), "utf8");
const GOLDEN = /const GOLDEN = `([^`]*)`;/.exec(golden)[1];
const GOLDEN_DIR = "/Users/liv/.stuga-remote";

// Records its arguments and the config it was given, then runs until TERM, or exits as told.
const FRPC = String.raw`#!/bin/bash
here="$(cd "$(dirname "$0")" && pwd)"
# Before it says it started: a TERM right after that is its to handle.
trap 'echo "frpc got TERM"; exit 0' TERM
{ printf '%s\n' "$@"; } > "$here/../../started.$$"
cp "$2" "$here/../../config.$$"
echo "frpc says hello"
[ ! -f "$here/../../exit-now" ] || exit 3
while :; do sleep 0.1; done
`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), "stuga-remote-wrapper-"));
  roots.push(base);
  const root = join(base, "Application Support", "Stuga");
  const logs = join(base, "logs");
  for (const dir of ["remote", "connector/current", "current/node/bin", "current/bin"]) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(logs);
  symlinkSync(process.execPath, join(root, "current/node/bin/node"));
  symlinkSync(rotate, join(root, "current/bin/rotate-log.mjs"));
  // As the runtime lays them out: check-toml.sh beside the wrapper.
  symlinkSync(wrapper, join(root, "current/bin/remote-wrapper.sh"));
  symlinkSync(checkToml, join(root, "current/bin/check-toml.sh"));
  writeFileSync(join(root, "connector/current/frpc"), FRPC);
  chmodSync(join(root, "connector/current/frpc"), 0o755);
  const dir = join(root, "remote");
  return {
    root,
    logs,
    wrapper: join(root, "current/bin/remote-wrapper.sh"),
    dir,
    /** The node's config for `relay`, as the golden test has it, in this root. */
    config: (relay = "relay-1") => GOLDEN.replaceAll(GOLDEN_DIR, dir).replaceAll("relay-1.jwt", `${relay}.jwt`).replaceAll("relay-1.ca.pem", `${relay}.ca.pem`),
    write(text, relay = "relay-1") {
      writeFileSync(join(dir, `${relay}.toml`), text);
    },
    started: () => readdirSync(root).filter((n) => n.startsWith("started.")).map((n) => readFileSync(join(root, n), "utf8").trim().split("\n")),
    given: () => readdirSync(root).filter((n) => n.startsWith("config.")).map((n) => readFileSync(join(root, n), "utf8")),
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: base, TMPDIR: base, STUGA_ROOT: root, STUGA_LOG_DIR: logs },
  };
}

/** Runs the wrapper to its end: for configs it refuses, or nothing to run. */
function runToEnd(h) {
  return spawnSync("/bin/bash", [h.wrapper], { env: h.env, encoding: "utf8", timeout: 20_000 });
}

/** Starts the wrapper; resolves once `count` connectors are running. */
async function start(h, count = 1) {
  const child = spawn("/bin/bash", [h.wrapper], { env: h.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr: () => stderr })));
  for (let i = 0; i < 100 && h.started().length < count; i++) await delay(50);
  assert.equal(h.started().length, count, stderr);
  return { child, exited };
}

test("starts one connector per relay from a private copy, with --strict-config, and stops on TERM", { skip }, async () => {
  const h = setup();
  h.write(h.config("relay-1"), "relay-1");
  h.write(h.config("relay-2").replace('log.level = "info"', 'log.level = "warn"'), "relay-2");

  const { child, exited } = await start(h, 2);
  const started = h.started();
  for (const args of started) {
    assert.equal(args.length, 3, args.join(" "));
    assert.equal(args[0], "-c");
    assert.equal(args[2], "--strict-config");
    assert.ok(!args[1].startsWith(h.root), `the copy is not in the shared directory: ${args[1]}`);
    assert.match(args[1], /\/stuga-remote\.[^/]+\/relay-[12]\.toml$/);
  }
  assert.deepEqual(h.given().sort(), [h.config("relay-1"), h.config("relay-2").replace('"info"', '"warn"')].sort());
  const copies = started.map((args) => args[1]);

  child.kill("SIGTERM");
  const { code, stderr } = await exited;
  assert.equal(code, 0, stderr());
  assert.match(stderr(), /stop requested/);
  for (const copy of copies) assert.ok(!existsSync(copy), "the private copy goes");
  const log = readdirSync(h.logs).filter((n) => /^frpc-\w{3}\.log$/.test(n));
  assert.equal(log.length, 1);
  const text = readFileSync(join(h.logs, log[0]), "utf8");
  assert.match(text, /frpc says hello/);
  assert.match(text, /frpc got TERM/, "the connectors' last lines reach the log");
});

test("a stop that comes while the connectors start leaves none of them running", { skip }, async () => {
  for (let round = 0; round < 3; round++) {
    const h = setup();
    // Twenty relays, and the TERM the moment the first connector is up: the others are still starting.
    for (let r = 1; r <= 20; r++) h.write(h.config(`relay-${r}`), `relay-${r}`);
    const child = spawn("/bin/bash", [h.wrapper], { env: h.env, stdio: ["ignore", "ignore", "ignore"] });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const started = () => readdirSync(h.root).filter((n) => n.startsWith("started."));
    for (let i = 0; i < 5000 && started().length === 0; i++) await delay(1);
    child.kill("SIGTERM");
    await exited;
    await delay(500);
    const alive = started()
      .map((n) => Number(n.slice("started.".length)))
      .filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    for (const pid of alive) process.kill(pid, "SIGKILL");
    assert.deepEqual(alive, [], "connectors outlived the wrapper");
  }
});

test("a connector that exits stops the others, and the wrapper exits 1", { skip }, async () => {
  const h = setup();
  h.write(h.config());
  writeFileSync(join(h.root, "exit-now"), "");
  const child = spawn("/bin/bash", [h.wrapper], { env: h.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1, stderr);
  assert.match(stderr, /exited with status 3/);
});

test("with no config it runs nothing and exits 0", { skip }, () => {
  const h = setup();
  const run = runToEnd(h);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(h.started(), []);
});

/** [what, config]: each is refused with 78 and nothing starts. */
const BYPASSES = [
  ["a webServer inline table", (c) => c.replace("loginFailExit = false\n", 'loginFailExit = false\nwebServer = { addr = "127.0.0.1", port = 7400 }\n')],
  ["a webServer key", (c) => c.replace("loginFailExit = false\n", "loginFailExit = false\nwebServer.port = 7400\n")],
  ["a [[visitors]] table", (c) => `${c}\n[[visitors]]\nname = "v"\ntype = "stcp"\nserverName = "x"\nbindPort = 6000\n`],
  ["another plugin", (c) => c.replace('type = "unix_domain_socket"', 'type = "http_proxy"')],
  ["a second plugin key", (c) => `${c}localPath = "/"\n`],
  ["a template", (c) => c.replace('serverAddr = "relay-1.mystuga.com"', 'serverAddr = "{{ .Envs.HOME }}"')],
  ["a template in the hostname", (c) => c.replace('customDomains = ["k7f3q2.mystuga.com"]', 'customDomains = ["k7f3q2.{{ .Envs.X }}"]')],
  ["log.to a path", (c) => c.replace('log.to = "console"', 'log.to = "/tmp/frpc.log"')],
  ["another log level", (c) => c.replace('log.level = "info"', 'log.level = "trace"')],
  ["transport.proxyURL", (c) => c.replace("transport.poolCount = 2\n", 'transport.poolCount = 2\ntransport.proxyURL = "socks5://127.0.0.1:1080"\n')],
  ["tls.certFile", (c) => c.replace("transport.tls.enable = true\n", 'transport.tls.enable = true\ntransport.tls.certFile = "/etc/ssl/cert.pem"\n')],
  ["a path that climbs out", (c, h) => c.replace(`"${h.dir}/relay-1.jwt"`, `"${h.dir}/../relay-1.jwt"`)],
  ["a path outside the directory", (c, h) => c.replace(`"${h.dir}/relay-1.ca.pem"`, `"/etc/ssl/cert.pem"`)],
  ["another relay's credential", (c, h) => c.replace(`"${h.dir}/relay-1.jwt"`, `"${h.dir}/relay-2.jwt"`)],
  ["another socket", (c, h) => c.replace(`"${h.dir}/https.sock"`, `"/var/run/docker.sock"`)],
  ["an extra line", (c) => `${c}user = "liv"\n`],
  ["an extra blank line", (c) => `${c}\n`],
  ["a comment", (c) => `${c}# nothing\n`],
  ["a missing line", (c) => c.replace("transport.poolCount = 2\n", "")],
  ["a missing final newline", (c) => c.slice(0, -1)],
  ["lines out of order", (c) => c.replace("serverPort = 7000\nloginFailExit = false\n", "loginFailExit = false\nserverPort = 7000\n")],
  ["a duplicated key", (c) => c.replace("serverPort = 7000\n", "serverPort = 7000\nserverPort = 7001\n")],
  ["CRLF line ends", (c) => c.replaceAll("\n", "\r\n")],
  ["a quote that closes early", (c) => c.replace('serverAddr = "relay-1.mystuga.com"', 'serverAddr = "relay-1.mystuga.com" # "')],
  ["an escaped quote", (c) => c.replace('name = "k7f3q2"', 'name = "k7f3q2\\"x"')],
  ["a host name with a port", (c) => c.replace('serverAddr = "relay-1.mystuga.com"', 'serverAddr = "relay-1.mystuga.com:7000"')],
  ["a port past 65535", (c) => c.replace("serverPort = 7000", "serverPort = 70000")],
  ["a port as a string", (c) => c.replace("serverPort = 7000", 'serverPort = "7000"')],
  ["a proxy name that is not a node id", (c) => c.replace('name = "k7f3q2"', 'name = "admin"')],
  ["another node's host name", (c) => c.replace('customDomains = ["k7f3q2.mystuga.com"]', 'customDomains = ["b7f3q2.mystuga.com"]')],
  ["two host names", (c) => c.replace('customDomains = ["k7f3q2.mystuga.com"]', 'customDomains = ["k7f3q2.mystuga.com", "k7f3q2.example.com"]')],
  ["another proxy type", (c) => c.replace('type = "https"', 'type = "tcp"')],
  ["no TLS", (c) => c.replace("transport.tls.enable = true", "transport.tls.enable = false")],
  ["an exec token source", (c) => c.replace('auth.oidc.tokenSource.type = "file"', 'auth.oidc.tokenSource.type = "exec"')],
];
for (const [what, change] of BYPASSES) {
  test(`refuses ${what}`, { skip }, () => {
    const h = setup();
    const config = h.config();
    const changed = change(config, h);
    assert.notEqual(changed, config, "the case changes the config");
    h.write(changed);
    const run = runToEnd(h);
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /refusing to start: .*relay-1\.toml/);
    assert.deepEqual(h.started(), []);
  });
}

test("refuses when any one config is refused, starting none", { skip }, () => {
  const h = setup();
  h.write(h.config("relay-1"), "relay-1");
  h.write(`${h.config("relay-2")}webServer.port = 7400\n`, "relay-2");
  const run = runToEnd(h);
  assert.equal(run.status, 78, run.stderr);
  assert.deepEqual(h.started(), []);
});

test("refuses a config under a name that is not a relay's", { skip }, () => {
  const h = setup();
  h.write(h.config("Relay_1"), "Relay_1");
  const run = runToEnd(h);
  assert.equal(run.status, 78, run.stderr);
  assert.match(run.stderr, /does not name a relay/);
});

test("refuses a relay's name with lines of its own", { skip }, () => {
  const h = setup();
  // frpc would read the name's lines as settings, an admin API among them.
  const relay = 'x"\nmetadatas.z = \'\'\'\nwebServer.port = 7400\nuser = """\nok\n"""\nmetadatas.a = "';
  h.write(h.config(relay), relay);
  const run = runToEnd(h);
  assert.equal(run.status, 78, run.stderr);
  assert.match(run.stderr, /does not name a relay/);
  assert.deepEqual(h.started(), []);
});

test("refuses a config that is a symbolic link", { skip }, () => {
  const h = setup();
  writeFileSync(join(h.root, "elsewhere.toml"), h.config());
  symlinkSync(join(h.root, "elsewhere.toml"), join(h.dir, "relay-1.toml"));
  const run = runToEnd(h);
  assert.equal(run.status, 78, run.stderr);
  assert.match(run.stderr, /not a plain file/);
});

test("refuses a STUGA_ROOT its configs cannot name", { skip }, () => {
  const h = setup();
  h.write(h.config());
  for (const root of [`${h.root}/`, `${h.root}/../Stuga`, "Stuga", `${h.root}{x}`]) {
    const run = spawnSync("/bin/bash", [h.wrapper], { env: { ...h.env, STUGA_ROOT: root }, encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 78, root);
    assert.match(run.stderr, /STUGA_ROOT is not a path the node's configs can name/);
  }
  assert.deepEqual(h.started(), []);
});

test("never passes --allow-unsafe", { skip }, () => {
  assert.doesNotMatch(readFileSync(wrapper, "utf8").replace(/^#.*$/gm, ""), /allow-unsafe/);
});
