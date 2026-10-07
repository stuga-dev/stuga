/**
 * 0003 over a node that ran 0002: a search distance saved before becomes the level `custom`, so it
 * stays in force, an unset one stays unset, and the retrieval distance is kept.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { closeClients, createClient } from "../client.js";
import { getNodeAiSettings } from "../node.js";
import { initSchema, migrationChecksum } from "./migrate.js";

const DB_URL = process.env.TEST_DATABASE_URL;
const DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

describe.skipIf(!DB_URL)("migration 0003 on a node at schema 2", () => {
  const name = `stuga_upgrade_${process.pid}`;
  const admin = DB_URL ? createClient(DB_URL) : null;
  afterAll(async () => {
    await closeClients();
    const sql = createClient(DB_URL!);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await sql.end();
  });

  it.each([
    [0.75, 0.8, { search_strictness: "custom", search_max_distance: 0.75, retrieval_max_distance: 0.8 }],
    [null, null, { search_strictness: null, search_max_distance: null, retrieval_max_distance: null }],
  ])("turns a stored search distance of %s into its level and keeps the rest", async (search, retrieval, expected) => {
    await admin!.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin!.unsafe(`CREATE DATABASE ${name}`);
    const u = new URL(DB_URL!);
    u.pathname = `/${name}`;
    const sql = createClient(u.toString());

    // Schema 2, as the runner leaves it.
    await sql`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    for (const [id, file] of [
      [1, "0001_initial.sql"],
      [2, "0002_remote_sign_in.sql"],
    ] as const) {
      const raw = await readFile(`${DIR}${file}`, "utf8");
      await sql.unsafe(raw.replaceAll("@EMBEDDING_DIMS@", String(EMBEDDING_DIMS)));
      await sql`INSERT INTO schema_migrations (id, filename, checksum) VALUES (${id}, ${file}, ${migrationChecksum(raw)})`;
    }
    await sql`INSERT INTO node_ai_settings (id, search_max_distance, retrieval_max_distance) VALUES (TRUE, ${search}, ${retrieval})`;

    const outcome = await initSchema(sql);
    expect(outcome).toMatchObject({ from: 2, applied: ["0003_search_strictness.sql"] });
    expect(await getNodeAiSettings(sql)).toMatchObject(expected);
    await sql.end();
  });
});
