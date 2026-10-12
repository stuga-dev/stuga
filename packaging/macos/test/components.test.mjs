// node --test packaging/macos/test/components.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const lib = new URL("../build/lib/components.sh", import.meta.url).pathname;
const versions = new URL("../../versions.env", import.meta.url).pathname;
const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Sources versions.env and components.sh, then runs `script`. */
function run(script, args = []) {
  return spawnSync("bash", ["-c", `set -euo pipefail; . "$0"; . "$1"; shift; ${script}`, versions, lib, ...args], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
}

/** A runtime whose libraries state their versions as Postgres.app's do, in strings inside each file. */
function runtime({ openssl = ["OpenSSL 3.5.7 9 Jun 2026"], xml = "21503" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stuga-components-"));
  roots.push(root);
  const pg = join(root, "postgres");
  for (const dir of ["bin", "lib/postgresql", "share/postgresql/extension"]) mkdirSync(join(pg, dir), { recursive: true });
  writeFileSync(join(pg, "bin/postgres"), "#!/bin/sh\necho 'postgres (PostgreSQL) 18.6 (Postgres.app)'\n");
  chmodSync(join(pg, "bin/postgres"), 0o755);
  const binary = (...strings) => Buffer.concat(strings.flatMap((s) => [Buffer.from([0, 1, 2]), Buffer.from(s), Buffer.from([0])]));
  writeFileSync(join(pg, "lib/libcrypto.3.dylib"), binary("_EVP_DigestInit", ...openssl));
  writeFileSync(join(pg, "lib/libxml2.16.dylib"), binary("xmlParseFile", xml));
  writeFileSync(join(pg, "lib/libxslt.1.dylib"), binary("xsltApplyStylesheet", "10145"));
  for (const name of ["libicuuc.77.1.dylib", "libicuuc.77.dylib", "liblz4.1.10.0.dylib", "liblz4.1.dylib", "libzstd.1.5.7.dylib"]) {
    writeFileSync(join(pg, "lib", name), "");
  }
  writeFileSync(join(pg, "lib/postgresql/wal2json.dylib"), "");
  writeFileSync(join(pg, "lib/postgresql/plugin_debugger.dylib"), "");
  writeFileSync(join(pg, "share/postgresql/extension/vector.control"), "default_version = '0.8.6'\n");
  writeFileSync(join(pg, "share/postgresql/extension/pg_search.control"), "default_version = '0.25.9'\n");
  return root;
}

test("every library in postgres/lib names its component; an unknown one names none", () => {
  const component = (name) => run('dylib_component "$1" || echo none', [name]).stdout.trim();
  assert.equal(component("libpq.5.dylib"), "postgresql");
  assert.equal(component("libecpg_compat.3.dylib"), "postgresql");
  assert.equal(component("libcrypto.3.dylib"), "openssl");
  assert.equal(component("libicudata.77.1.dylib"), "icu");
  assert.equal(component("libexslt.0.dylib"), "libxslt");
  assert.equal(component("libzstd.dylib"), "zstd");
  assert.equal(component("libcurl.4.dylib"), "none");
});

test("the component list carries the versions the files state, as CycloneDX", () => {
  const result = run('write_components "$1" 1.2.3 "$2"', [runtime(), "a".repeat(64)]);
  assert.equal(result.status, 0, result.stderr);
  const bom = JSON.parse(result.stdout);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.metadata.component.version, "1.2.3");
  const version = Object.fromEntries(bom.components.map((c) => [c.name, c.version ?? null]));
  assert.deepEqual(version, {
    node: version.node,
    "postgres.app": version["postgres.app"],
    postgresql: "18.6",
    pgvector: "0.8.6",
    pg_search: "0.25.9",
    wal2json: null,
    pldbgapi: null,
    openssl: "3.5.7",
    icu: "77.1",
    libxml2: "2.15.3",
    libxslt: "1.1.45",
    lz4: "1.10.0",
    zstd: "1.5.7",
    frpc: version.frpc,
  });
  assert.match(version.node, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(bom.properties, [{ name: "stuga:connector-sha256", value: "a".repeat(64) }]);
});

test("a version that cannot be read, or reads two ways, fails the list", () => {
  const unread = run('write_components "$1" 1.2.3', [runtime({ xml: "xml" })]);
  assert.equal(unread.status, 1);
  assert.match(unread.stderr, /cannot read the version of libxml2/);
  const twice = run('write_components "$1" 1.2.3', [runtime({ openssl: ["OpenSSL 3.5.7 9 Jun 2026", "OpenSSL 3.0.2 15 Mar 2022"] })]);
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /cannot read the version of OpenSSL/);
});
