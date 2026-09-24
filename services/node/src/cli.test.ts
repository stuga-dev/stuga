import { spawnSync } from "node:child_process";
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
