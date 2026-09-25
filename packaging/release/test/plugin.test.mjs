// node --test packaging/release/test/plugin.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SERVER_PACKAGE, stamp } from "../plugin.mjs";

const script = fileURLToPath(new URL("../plugin.mjs", import.meta.url));
const source = fileURLToPath(new URL("../../../integrations/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "stuga-plugin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
  .sort();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

test("stamps the version and the server pin, and changes nothing else", () => {
  const out = join(scratch, "stamped");
  stamp("1.2.3", out);
  assert.deepEqual(files(out), files(source));
  for (const file of files(source)) {
    if (file === ".claude-plugin/plugin.json" || file === ".mcp.json") continue;
    assert.equal(readFileSync(join(out, file), "utf8"), readFileSync(join(source, file), "utf8"), file);
  }
  const manifest = json(join(out, ".claude-plugin/plugin.json"));
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual({ ...manifest, version: undefined }, { ...json(join(source, ".claude-plugin/plugin.json")), version: undefined });
  const server = json(join(out, ".mcp.json")).mcpServers.stuga;
  assert.deepEqual(server.args, ["-y", `${SERVER_PACKAGE}@1.2.3`]);
  assert.deepEqual({ ...server, args: undefined }, { ...json(join(source, ".mcp.json")).mcpServers.stuga, args: undefined });
});

test("a stamp replaces what was in the output directory", () => {
  const out = join(scratch, "replaced");
  stamp("1.0.0", out);
  writeFileSync(join(out, "left-over.md"), "gone after the next stamp\n");
  stamp("1.0.1", out);
  assert.deepEqual(files(out), files(source));
});

test("refuses anything but a plain release version", () => {
  for (const version of ["1.2", "v1.2.3", "1.2.3-rc.1", "01.2.3", ""]) {
    assert.throws(() => stamp(version, join(scratch, "bad")), /not a release version/, version);
  }
});

test("refuses a source that already names a version or pins the server", () => {
  const versioned = join(scratch, "versioned");
  cpSync(source, versioned, { recursive: true });
  writeFileSync(join(versioned, ".claude-plugin/plugin.json"), JSON.stringify({ ...json(join(source, ".claude-plugin/plugin.json")), version: "0.1.0" }));
  assert.throws(() => stamp("1.0.0", join(scratch, "out-a"), versioned), /names a version/);

  const pinned = join(scratch, "pinned");
  cpSync(source, pinned, { recursive: true });
  const mcp = json(join(source, ".mcp.json"));
  mcp.mcpServers.stuga.args = ["-y", `${SERVER_PACKAGE}@0.1.0`];
  writeFileSync(join(pinned, ".mcp.json"), JSON.stringify(mcp));
  assert.throws(() => stamp("1.0.0", join(scratch, "out-b"), pinned), /pins @stuga\/mcp/);
});

test("the command line takes stamp <version> <outdir>", () => {
  const out = join(scratch, "cli");
  const ok = spawnSync(process.execPath, [script, "stamp", "2.0.0", out], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(json(join(out, ".claude-plugin/plugin.json")).version, "2.0.0");
  const bad = spawnSync(process.execPath, [script, "stamp"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage/);
});
