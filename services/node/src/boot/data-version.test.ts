import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBackupEnv } from "../ops/env.js";
import { dataRefusal, goBackTo, refusalText, restoreCommandFor, type DataRefusal } from "./data-version.js";

const MAC = 'sudo "/Library/Application Support/Stuga/current/bin/stuga" restore {backup}';
const BACKUP = "2026-10-04T030000Z";

describe("dataRefusal", () => {
  const release = { version: "0.1.12", schema: 2 };

  it("lets a build serve a new database, its own data, and data an older release served", () => {
    expect(dataRefusal(release, { schema: 0, servedBy: null })).toBeNull();
    expect(dataRefusal(release, { schema: 2, servedBy: "0.1.12" })).toBeNull();
    expect(dataRefusal(release, { schema: 1, servedBy: "0.1.11" })).toBeNull();
    expect(dataRefusal(release, { schema: 2, servedBy: "0.1.9" })).toBeNull();
  });

  it("lets a build from source on either side serve, while the schema is one it knows", () => {
    expect(dataRefusal(release, { schema: 2, servedBy: "0.0.0-dev" })).toBeNull();
    expect(dataRefusal({ version: "0.0.0-dev", schema: 2 }, { schema: 2, servedBy: "9.9.9" })).toBeNull();
    expect(dataRefusal({ version: "local-abc1234", schema: 2 }, { schema: 2, servedBy: "0.1.12" })).toBeNull();
  });

  it("refuses data a newer release served", () => {
    expect(dataRefusal(release, { schema: 2, servedBy: "0.1.13" })).toEqual({ kind: "newer-release", servedBy: "0.1.13", version: "0.1.12" });
    expect(dataRefusal({ version: "0.1.9", schema: 2 }, { schema: 2, servedBy: "0.1.10" })).toMatchObject({ kind: "newer-release" });
  });

  it("refuses a newer schema for every build, ahead of the release check", () => {
    expect(dataRefusal(release, { schema: 3, servedBy: "0.1.13" })).toEqual({
      kind: "newer-schema",
      schema: 3,
      known: 2,
      servedBy: "0.1.13",
      version: "0.1.12",
    });
    expect(dataRefusal({ version: "0.0.0-dev", schema: 2 }, { schema: 3, servedBy: "0.0.0-dev" })).toMatchObject({ kind: "newer-schema" });
    expect(dataRefusal(release, { schema: 3, servedBy: null })).toMatchObject({ kind: "newer-schema", servedBy: null });
  });
});

describe("refusalText", () => {
  const newerRelease: DataRefusal = { kind: "newer-release", servedBy: "0.1.13", version: "0.1.12" };
  const newerSchema: DataRefusal = { kind: "newer-schema", schema: 3, known: 2, servedBy: "0.1.13", version: "0.1.12" };

  it("names both versions, the backup and the packaging's command", () => {
    const text = refusalText(newerRelease, BACKUP, MAC);
    const command = `sudo "/Library/Application Support/Stuga/current/bin/stuga" restore ${BACKUP}`;
    expect(text.log).toBe(
      `refusing this database: Stuga 0.1.13 served it last, and this is Stuga 0.1.12. Nothing was changed. ` +
        `Start Stuga 0.1.13 again, or restore ${BACKUP} with this version: ${command}`,
    );
    expect(text.title).toBe("Stuga 0.1.13 last served this data");
    expect(text.body).toBe(
      "This is Stuga 0.1.12, so it changed nothing. Start 0.1.13 again, or restore the backup from before the update with this version.",
    );
    expect(text.command).toBe(command);
  });

  it("says to stop the node and run stuga-node restore when the packaging names no command", () => {
    const text = refusalText(newerRelease, BACKUP, null);
    expect(text.log).toMatch(new RegExp(`or restore ${BACKUP} with this version: stop this node first, then run stuga-node restore ${BACKUP}$`));
    expect(text.command).toBeNull();
  });

  it("asks for a backup of this version's data when none is known", () => {
    const text = refusalText(newerRelease, null, MAC);
    expect(text.log).toMatch(/Start Stuga 0\.1\.13 again, or restore a backup of Stuga 0\.1\.12's data with this version\.$/);
    expect(text.command).toBeNull();
  });

  it("names the schemas, and the version that served them when it is known, on the page too", () => {
    const known = refusalText(newerSchema, BACKUP, MAC);
    expect(known.log).toMatch(
      /^refusing this database: it is at schema 3, and this build knows schema 2; Stuga 0\.1\.13 served it last\. Nothing was changed\. Start Stuga 0\.1\.13 again, or restore /,
    );
    expect(known.title).toBe("Stuga 0.1.13 last served this data");
    expect(known.body).toBe(
      "This is Stuga 0.1.12, so it changed nothing. Start 0.1.13 again, or restore the backup from before the update with this version.",
    );
    expect(known.command).toBe(`sudo "/Library/Application Support/Stuga/current/bin/stuga" restore ${BACKUP}`);
    // A build from source on either side cannot be ordered, so it may be the newer one.
    expect(refusalText({ ...newerSchema, servedBy: "0.0.0-dev" }, null, null).title).toBe("Stuga 0.0.0-dev last served this data");
    const unknown = refusalText({ ...newerSchema, servedBy: null }, null, null);
    expect(unknown.log).toBe(
      "refusing this database: it is at schema 3, and this build knows schema 2; a newer Stuga changed it. Nothing was changed. " +
        "Start the newer version again, or restore a backup of Stuga 0.1.12's data with this version.",
    );
    expect(unknown.title).toBe("A newer Stuga changed this data");
    expect(unknown.body).toBe(
      "This build changed nothing. Start the newer version again, or restore the backup from before the update with this version.",
    );
    // Never one that cannot serve it: this version (a build from source), or an older release stopped
    // between its migrations and its stamp.
    for (const servedBy of ["0.1.12", "0.1.11"]) {
      const text = refusalText({ ...newerSchema, servedBy }, null, null);
      expect(text.log, servedBy).toContain("a newer Stuga changed it");
      expect(text.log, servedBy).not.toContain(`Start Stuga ${servedBy}`);
      expect(text.title, servedBy).toBe("A newer Stuga changed this data");
    }
  });

  it("keeps paths off the page, which anyone who reaches the node reads", () => {
    for (const r of [newerRelease, newerSchema]) {
      const { title, body } = refusalText(r, BACKUP, MAC);
      expect(`${title} ${body}`).not.toContain("/");
      expect(`${title} ${body}`).not.toContain(BACKUP);
    }
    expect(refusalText(newerRelease, BACKUP, MAC).title).toContain("0.1.13");
    expect(refusalText(newerRelease, BACKUP, MAC).body).toContain("0.1.12");
  });
});

describe("restoreCommandFor", () => {
  it("puts a backup's name in the template, everywhere it asks for it", () => {
    expect(restoreCommandFor("./stuga restore {backup} # {backup}", BACKUP)).toBe(`./stuga restore ${BACKUP} # ${BACKUP}`);
  });

  it("gives nothing for a name a shell would not take as one word, or without a template", () => {
    for (const name of ["a b", "a;b", "$(x)", "-rf", ".hidden", "", "a".repeat(129)]) {
      expect(restoreCommandFor("./stuga restore {backup}", name), name).toBeNull();
    }
    expect(restoreCommandFor(null, BACKUP)).toBeNull();
  });
});

describe("goBackTo", () => {
  it("picks the newest backup taken before an upgrade from that version, else the newest of its data", async () => {
    const root = mkdtempSync(join(tmpdir(), "stuga-go-back-"));
    try {
      const env = parseBackupEnv({ DATABASE_URL: "postgres://stuga@127.0.0.1:1/stuga", DATA_DIR: join(root, "node"), BACKUP_DIR: join(root, "backups") });
      const file = { sha256: "0".repeat(64), bytes: 1 };
      const write = (name: string, stuga_version: string, runtime_version: string, database = "stuga") => {
        mkdirSync(join(root, "backups", name), { recursive: true });
        const manifest = {
          format: 1,
          created_at: `${name.slice(0, 10)}T03:00:00Z`,
          database,
          stuga_version,
          runtime_version,
          schema_version: 2,
          postgres_version_num: 180001,
          extensions: {},
          embedding_dims: 1024,
          search_languages: [],
          public_origin: "http://localhost:8787",
          database_bytes: 1,
          data_dir_bytes: 1,
          files: { "postgres.dump": file, "data.tar.gz": file },
        };
        writeFileSync(join(root, "backups", name, "MANIFEST.json"), JSON.stringify(manifest));
      };
      write("2026-10-01T030000Z", "1.0.0", "1.1.0");
      write("2026-10-02T030000Z", "1.0.0", "1.1.0");
      write("2026-10-03T030000Z", "1.0.0", "1.0.0");
      write("2026-10-04T030000Z", "1.1.0", "1.1.0");
      write("2026-10-05T030000Z", "1.0.0", "1.1.0", "another_node");
      expect((await goBackTo(env, "1.0.0"))?.name).toBe("2026-10-02T030000Z");
      expect(await goBackTo(env, "0.9.0")).toBeNull();

      rmSync(join(root, "backups", "2026-10-01T030000Z"), { recursive: true });
      rmSync(join(root, "backups", "2026-10-02T030000Z"), { recursive: true });
      expect((await goBackTo(env, "1.0.0"))?.name).toBe("2026-10-03T030000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
