// node --test packaging/macos/test/hold.test.mjs (macOS: BSD ps)
//
// The hold mark bin/stuga keeps while it restores (runtime/bin/hold.sh), as node-wrapper.sh reads it
// in a runtime whose node and pg_isready are stubs: a mark naming a running process by its id and
// start time keeps the node from starting, and anything else is no mark.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const bin = new URL("../runtime/bin/", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs macOS's ps";
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** What `TZ=UTC0 LC_ALL=C /bin/ps -p <pid> -o lstart=` says, trimmed, as hold.sh and bin/stuga write it. */
const started = (pid) => spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { LC_ALL: "C", TZ: "UTC0" }, encoding: "utf8" }).stdout.trim();

/** A root whose runtime's node and pg_isready record their calls. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "stuga-hold-"));
  roots.push(root);
  const runtime = join(root, "runtime", "1.0.0");
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  for (const dir of ["node/bin", "postgres/bin", "app/services/node/bin", "bin", "status", "logs"]) {
    mkdirSync(join(dir === "status" || dir === "logs" ? root : runtime, dir), { recursive: true });
  }
  const stub = (path, name) => {
    writeFileSync(path, `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(calls)}\n`);
    chmodSync(path, 0o755);
  };
  stub(join(runtime, "node/bin/node"), "node");
  stub(join(runtime, "postgres/bin/pg_isready"), "pg_isready");
  writeFileSync(join(runtime, "app/services/node/bin/stuga-node.js"), "");
  writeFileSync(join(runtime, "bin/rotate-log.mjs"), "");
  for (const file of ["hold.sh", "node-wrapper.sh"]) copyFileSync(join(bin, file), join(runtime, "bin", file));
  symlinkSync("runtime/1.0.0", join(root, "current"));
  return {
    root,
    mark: (text) => writeFileSync(join(root, "status", "restoring"), text),
    calls: () => readFileSync(calls, "utf8").split("\n").filter(Boolean),
    wrapper(env = {}) {
      return spawnSync("/bin/bash", [join(root, "current/bin/node-wrapper.sh")], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", STUGA_ROOT: root, STUGA_LOG_DIR: join(root, "logs"), DATABASE_URL: "postgres:///stuga", ...env },
        encoding: "utf8",
        timeout: 20_000,
      });
    },
  };
}

/** The wrapper went past the mark: it asked Postgres, then became the node. */
function startedTheNode(h, run) {
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /a restore is under way/);
  const calls = h.calls();
  assert.ok(calls.some((c) => c.startsWith("pg_isready")), calls.join("\n"));
  assert.ok(calls.includes("node bin/stuga-node.js serve"), calls.join("\n"));
}

test("a mark naming a running process keeps the node from starting, without waiting for Postgres", { skip }, () => {
  const h = setup();
  h.mark(`${process.pid}\n${started(process.pid)}\n`);
  const run = h.wrapper();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /\[node-wrapper\] a restore is under way; not starting$/m);
  assert.deepEqual(h.calls(), []);
});

test("a mark written under one time zone holds under another", { skip }, () => {
  const h = setup();
  // As root writes it under an administrator's TZ, and launchd's wrapper reads it under another.
  const written = spawnSync("/bin/bash", ["-c", `. ${JSON.stringify(join(bin, "hold.sh"))}; process_started ${process.pid}`], {
    env: { PATH: "/usr/bin:/bin", TZ: "Asia/Tokyo" },
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(written, started(process.pid));
  h.mark(`${process.pid}\n${written}\n`);
  const run = h.wrapper({ TZ: "America/New_York" });
  assert.match(run.stderr, /a restore is under way; not starting$/m);
  assert.deepEqual(h.calls(), []);
});

test("a mark whose process has exited is no mark", { skip }, async () => {
  const h = setup();
  const child = spawn("/bin/sleep", ["0.1"]);
  const pid = child.pid;
  const when = started(pid);
  await new Promise((resolve) => child.on("exit", resolve));
  h.mark(`${pid}\n${when}\n`);
  startedTheNode(h, h.wrapper());
});

test("a mark naming a running process that started at another time is no mark", { skip }, () => {
  const h = setup();
  h.mark(`${process.pid}\nThu Jan  1 00:00:00 1970\n`);
  startedTheNode(h, h.wrapper());
});

test("a mark that is not a plain file, or names no process, is no mark", { skip }, () => {
  const real = setup();
  real.mark(`${process.pid}\n${started(process.pid)}\n`);
  const h = setup();
  symlinkSync(join(real.root, "status", "restoring"), join(h.root, "status", "restoring"));
  startedTheNode(h, h.wrapper());

  for (const text of [`pid ${process.pid}\n${started(process.pid)}\n`, `${process.pid}\n`, ""]) {
    const other = setup();
    other.mark(text);
    startedTheNode(other, other.wrapper());
  }
});

test("with no mark the node starts as before", { skip }, () => {
  const h = setup();
  assert.ok(!existsSync(join(h.root, "status", "restoring")));
  startedTheNode(h, h.wrapper());
});
