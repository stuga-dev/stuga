import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "bin", "stuga-node.js");

function stugaNode(args: string[], env: Record<string, string> = {}, nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    cwd: "/",
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

// Each test starts stuga-node at least once, which takes seconds on a shared CI runner.
describe("stuga-node", { timeout: 30_000 }, () => {
  it("refuses an unknown command with its usage and exit 2", () => {
    const run = stugaNode(["frobnicate"]);
    expect(run.stderr).toContain("stuga-node reset-password <username>");
    expect(run.stderr).toContain("stuga-node serve");
    expect(run.stderr).toContain("stuga-node archive check <directory>");
    expect(run.status).toBe(2);
  });

  it("refuses reset-password with no username before touching any configuration", () => {
    const run = stugaNode(["reset-password"]);
    expect(run.stderr).toContain("usage: stuga-node reset-password <username>");
    expect(run.status).toBe(2);
  });

  it("refuses an operator command without the node's required configuration", () => {
    const run = stugaNode(["media-scan"], { DATABASE_URL: "postgres://stuga@127.0.0.1:1/stuga" });
    expect(run.stderr).toContain("DATA_DIR is required");
    expect(run.status).toBe(2);
  });

  it("lists backups newest first, marks the one taken before an upgrade, and keeps the JSON keys in order", () => {
    const root = mkdtempSync(join(tmpdir(), "stuga-list-"));
    try {
      const file = { sha256: "0".repeat(64), bytes: 10 };
      const manifest = (created_at: string, stuga_version: string, runtime_version: string) => ({
        format: 1,
        created_at,
        database: "stuga",
        stuga_version,
        runtime_version,
        schema_version: 2,
        postgres_version_num: 180001,
        extensions: { vector: "0.8.1" },
        embedding_dims: 1024,
        search_languages: [],
        public_origin: "http://localhost:8787",
        database_bytes: 100,
        data_dir_bytes: 100,
        files: { "postgres.dump": file, "data.tar.gz": file },
      });
      for (const [name, m] of [
        ["2026-10-01T030000Z", manifest("2026-10-01T03:00:00Z", "1.0.0", "1.1.0")],
        ["2026-10-02T030000Z", manifest("2026-10-02T03:00:00Z", "1.1.0", "1.1.0")],
      ] as const) {
        mkdirSync(join(root, "backups", name), { recursive: true });
        writeFileSync(join(root, "backups", name, "MANIFEST.json"), JSON.stringify(m));
      }
      // Nothing listens on port 1: the backups are read from disk, the server's leftovers are left out.
      const env = { DATABASE_URL: "postgres://stuga@127.0.0.1:1/stuga", DATA_DIR: join(root, "node"), BACKUP_DIR: join(root, "backups") };

      const text = stugaNode(["list"], env);
      expect(text.status).toBe(0);
      // Only the backups' lines: a Node runtime may print a warning of its own.
      const lines = text.stderr.split("\n").filter((l) => l.startsWith("2026-"));
      expect(lines).toEqual([
        "2026-10-02T030000Z  stuga 1.1.0, schema 2, 20 bytes",
        "2026-10-01T030000Z  stuga 1.0.0, schema 2, 20 bytes, taken before upgrading from 1.0.0 to 1.1.0",
      ]);

      const json = stugaNode(["list", "--json"], env);
      expect(json.status).toBe(0);
      const { backups } = JSON.parse(json.stdout) as { backups: Record<string, unknown>[] };
      expect(Object.keys(backups[0]!)).toEqual([
        "name",
        "path",
        "database",
        "created_at",
        "stuga_version",
        "schema_version",
        "bytes",
        "runtime_version",
        "before_upgrade",
      ]);
      expect(backups.map((b) => [b.name, b.runtime_version, b.before_upgrade])).toEqual([
        ["2026-10-02T030000Z", "1.1.0", false],
        ["2026-10-01T030000Z", "1.1.0", true],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks an unzipped workspace archive without any node configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-archive-"));
    try {
      const manifest = { format: "stuga-workspace", version: 1, generator: "test", exported_at: "2026-09-25T10:00:00Z", workspace: { name: "Empty", agent_instructions: "" }, items: [] };
      writeFileSync(join(dir, "stuga.json"), JSON.stringify(manifest));
      const passes = stugaNode(["archive", "check", dir]);
      expect(passes.stdout).toBe(`${dir} passes: 0 items, 0 bodies, 0 rows, 0 images, 0 files, 0 sample steps\n`);
      expect(passes.status).toBe(0);
      // A failing check, --json and a refused argument are archive/check.test.ts's, in process.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
