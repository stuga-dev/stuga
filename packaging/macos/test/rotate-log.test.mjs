// node --test packaging/macos/test/rotate-log.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createLogWriter } from "../runtime/bin/rotate-log.mjs";

const roots = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "stuga-rotate-log-"));
  roots.push(dir);
  return dir;
};
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const read = (dir, file) => readFileSync(join(dir, file), "utf8");

test("writes to the UTC weekday's file and moves on when the day changes", () => {
  const dir = scratch();
  let clock = new Date("2026-09-13T23:59:59Z"); // a Sunday
  const writer = createLogWriter({ dir, name: "node", now: () => clock });
  writer.write(Buffer.from("sunday line\n"));
  clock = new Date("2026-09-14T00:00:01Z"); // Monday
  writer.write(Buffer.from("monday line\n"));
  writer.close();
  assert.deepEqual(readdirSync(dir).sort(), ["node-Mon.log", "node-Sun.log"]);
  assert.equal(read(dir, "node-Sun.log"), "sunday line\n");
  assert.equal(read(dir, "node-Mon.log"), "monday line\n");
});

test("appends to today's file after a restart, and starts last week's over", () => {
  const dir = scratch();
  const monday = new Date("2026-09-14T10:00:00Z");
  writeFileSync(join(dir, "node-Mon.log"), "earlier today\n");
  utimesSync(join(dir, "node-Mon.log"), monday, new Date("2026-09-14T08:00:00Z"));
  const restarted = createLogWriter({ dir, name: "node", now: () => monday });
  restarted.write(Buffer.from("after restart\n"));
  restarted.close();
  assert.equal(read(dir, "node-Mon.log"), "earlier today\nafter restart\n");

  writeFileSync(join(dir, "node-Tue.log"), "a week ago\n");
  utimesSync(join(dir, "node-Tue.log"), new Date("2026-09-08T08:00:00Z"), new Date("2026-09-08T08:00:00Z"));
  const nextDay = createLogWriter({ dir, name: "node", now: () => new Date("2026-09-15T00:00:05Z") });
  nextDay.write(Buffer.from("this tuesday\n"));
  nextDay.close();
  assert.equal(read(dir, "node-Tue.log"), "this tuesday\n");
});

test("stops a day's file at maxBytes with one line saying so, and starts fresh the next day", () => {
  const dir = scratch();
  let clock = new Date("2026-09-14T12:00:00Z");
  const writer = createLogWriter({ dir, name: "node", maxBytes: 100, now: () => clock });
  for (let i = 0; i < 20; i++) writer.write(Buffer.from(`line ${String(i).padStart(2, "0")}\n`));
  const monday = read(dir, "node-Mon.log");
  assert.equal(monday.match(/reached 100 bytes/g)?.length, 1);
  assert.ok(monday.startsWith("line 00\nline 01\n"));
  assert.ok(!monday.includes("line 19"));
  clock = new Date("2026-09-15T00:00:00Z");
  writer.write(Buffer.from("tuesday\n"));
  writer.close();
  assert.equal(read(dir, "node-Tue.log"), "tuesday\n");
});

test("hands what it cannot write to the fallback instead of throwing", () => {
  const dir = join(scratch(), "missing", "dir");
  const lost = [];
  const writer = createLogWriter({ dir, name: "node", onError: (chunk) => lost.push(chunk.toString()) });
  writer.write(Buffer.from("nowhere to go\n"));
  assert.deepEqual(lost, ["nowhere to go\n"]);
});

test("as a program started through a symlink, copies everything written before its input closes, SIGTERM included", async () => {
  const dir = scratch();
  const link = join(scratch(), "bin");
  symlinkSync(join(import.meta.dirname, "..", "runtime", "bin"), link);
  const child = spawn(process.execPath, [join(link, "rotate-log.mjs"), dir, "node"], { stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.write("line 0\n");
  // Started: it has copied its first line, so its signal handlers are in place.
  for (let i = 0; i < 200 && readdirSync(dir).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  child.kill("SIGTERM"); // what a process-group stop would send while the node is still writing
  child.stdin.write(Array.from({ length: 4999 }, (_, i) => `line ${i + 1}\n`).join(""));
  child.stdin.end("[node] SIGTERM: shutting down\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  const [file] = readdirSync(dir);
  const text = read(dir, file);
  assert.ok(text.startsWith("line 0\n"));
  assert.ok(text.includes("line 4999\n"));
  assert.ok(text.endsWith("[node] SIGTERM: shutting down\n"));
});
