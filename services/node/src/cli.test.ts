import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("stuga-node", () => {
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

  it("checks an unzipped workspace archive without any node configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-archive-"));
    try {
      const manifest = { format: "stuga-workspace", version: 1, generator: "test", exported_at: "2026-09-25T10:00:00Z", workspace: { name: "Empty", agent_instructions: "" }, items: [] };
      writeFileSync(join(dir, "stuga.json"), JSON.stringify(manifest));
      const passes = stugaNode(["archive", "check", dir]);
      expect(passes.stdout).toBe(`${dir} passes: 0 items, 0 bodies, 0 rows, 0 images, 0 sample steps\n`);
      expect(passes.status).toBe(0);

      writeFileSync(join(dir, "stray.md"), "# Stray\n");
      const fails = stugaNode(["archive", "check", dir, "--json"]);
      expect(JSON.parse(fails.stdout)).toMatchObject({ ok: false, issues: [{ at: "stray.md" }] });
      expect(fails.status).toBe(2);

      const usage = stugaNode(["archive", "fix", dir]);
      expect(usage.stderr).toContain("usage: stuga-node archive check <directory> [--json]");
      expect(usage.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints no warning that SQLite is experimental, and every other warning", () => {
    // Emits a warning through whichever emitWarning the entry installs, as soon as it installs one.
    const preload = `data:text/javascript,${encodeURIComponent(`
      let emit = process.emitWarning;
      Object.defineProperty(process, "emitWarning", {
        get: () => emit,
        set: (next) => {
          emit = next;
          process.emitWarning("Another feature is experimental", "ExperimentalWarning");
        },
      });`)}`;
    const run = stugaNode(["frobnicate"], {}, ["--import", preload]);
    expect(run.status).toBe(2);
    expect(run.stderr).not.toContain("SQLite");
    expect(run.stderr).toContain("ExperimentalWarning: Another feature is experimental");
  });
});
