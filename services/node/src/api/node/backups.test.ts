/** /api/node/backups: each backup carries the command that restores it on the node's machine, never run from here. */
import { describe, expect, it, vi } from "vitest";
import type { BackupSummary } from "../../ops/node-backups.js";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(async () => true),
  getNodeState: vi.fn(async () => ({ backup_attempted_at: null, backup_error: null })),
}));

const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
import type { Ctx } from "../../auth/context.js";

const MAC = 'sudo "/Library/Application Support/Stuga/current/bin/stuga" restore {backup}';

function backup(name: string, stugaVersion = "1.0.0"): BackupSummary {
  return { name, createdAt: "2026-10-04T03:00:00Z", bytes: 1024, stugaVersion, runtimeVersion: "1.1.0", beforeUpgrade: true };
}

function ctx(restoreCommand: string | null, names: string[], stugaVersion?: string): Ctx {
  return {
    sql: {},
    alias: "admin-1",
    isAgent: false,
    principals: ["user:admin-1"],
    env: {
      restoreCommand,
      settings: { current: () => ({ backups: { keep: 3 } }) },
      backups: {
        schedule: () => ({ auto: true, hour: 3, weekday: null, timeZone: "UTC" }),
        nextAt: () => null,
        running: () => false,
        waiting: () => null,
        dir: () => "/backups",
        list: async () => names.map((name) => backup(name, stugaVersion)),
      },
    },
  } as unknown as Ctx;
}

async function listed(c: Ctx): Promise<{ name: string; restore_command: string | null; before_upgrade: boolean }[]> {
  const res = (await routeWorkspaceRequest(c, new Request("https://node.test/api/node/backups")))!;
  expect(res.status).toBe(200);
  return ((await res.json()) as { backups: { name: string; restore_command: string | null; before_upgrade: boolean }[] }).backups;
}

describe("GET /api/node/backups", () => {
  it("gives each backup the packaging's restore command with its name in place", async () => {
    const [b] = await listed(ctx(MAC, ["2026-10-04T030000Z"]));
    expect(b).toMatchObject({ name: "2026-10-04T030000Z", before_upgrade: true });
    expect(b!.restore_command).toBe('sudo "/Library/Application Support/Stuga/current/bin/stuga" restore 2026-10-04T030000Z');
  });

  it("gives none for a name a shell would not take as one word, or when the packaging names no command", async () => {
    const names = ["2026-10-04T030000Z; rm -rf ~", "with space", "-flag", "2026-10-04T030000Z"];
    expect((await listed(ctx(MAC, names))).map((b) => b.restore_command)).toEqual([
      null,
      null,
      null,
      'sudo "/Library/Application Support/Stuga/current/bin/stuga" restore 2026-10-04T030000Z',
    ]);
    expect((await listed(ctx(null, ["2026-10-04T030000Z"])))[0]!.restore_command).toBeNull();
  });

  it("leaves which versions it can go back to to the command: Docker restores a newer release's backup forward", async () => {
    for (const version of ["99.0.0", "0.0.1"]) {
      const [b] = await listed(ctx(MAC, ["2026-10-04T030000Z"], version));
      expect(b!.restore_command, version).toContain("restore 2026-10-04T030000Z");
    }
  });
});
