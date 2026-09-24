import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { MIGRATIONS, SCHEMA_VERSION, checkedIds, initSchema, migrationId, readSchemaVersion } from "./migrate.js";
import { runBootRepairs } from "./boot-repairs.js";
import { getNodeState, recordNodeBoot } from "../node.js";
import { closeClients, createClient, type Sql } from "../client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("the migration runner", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await initSchema(sql);
    await closeClients();
  });

  it("has a registry that is contiguous and correctly named", () => {
    expect(() => checkedIds()).not.toThrow();
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(migrationId("0007_add_thing.sql")).toBe(7);
    expect(() => migrationId("7_add_thing.sql")).toThrow(/NNNN_lower_snake_case/);
    expect(() => migrationId("0007-add-thing.sql")).toThrow();
  });

  it("records every migration it applied", async () => {
    const rows = await sql<{ id: number; filename: string }[]>`
      SELECT id, filename FROM schema_migrations ORDER BY id`;
    expect(rows.map((r) => r.filename)).toEqual([...MIGRATIONS]);
    expect(rows.at(-1)?.id).toBe(SCHEMA_VERSION);
  });

  it("reads the schema version, and 0 where no migration has run", async () => {
    expect(await readSchemaVersion(sql)).toBe(SCHEMA_VERSION);
    const rollback = new Error("rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`DROP TABLE schema_migrations`;
        expect(await readSchemaVersion(tx)).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readSchemaVersion(sql)).toBe(SCHEMA_VERSION);
  });

  it("is a no-op on a database that is already current", async () => {
    const before = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM schema_migrations`;
    const outcome = await initSchema(sql, { embeddingDims: 1024 });
    const after = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM schema_migrations`;
    expect(outcome.applied).toEqual([]);
    expect(outcome.from).toBe(SCHEMA_VERSION);
    expect(outcome.to).toBe(SCHEMA_VERSION);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("refuses a database written by a NEWER build rather than running against it", async () => {
    const future = SCHEMA_VERSION + 1;
    await sql`
      INSERT INTO schema_migrations (id, filename, checksum)
      VALUES (${future}, ${`${String(future).padStart(4, "0")}_from_the_future.sql`}, 'ffffffffffffffff')`;
    try {
      await expect(initSchema(sql, { embeddingDims: 1024 })).rejects.toThrow(/written by a NEWER version/);
    } finally {
      await sql`DELETE FROM schema_migrations WHERE id = ${future}`;
    }
    await expect(initSchema(sql, { embeddingDims: 1024 })).resolves.toMatchObject({ applied: [] });
  });

  it("refuses an applied migration whose file has been edited since it ran", async () => {
    const [row] = await sql<{ checksum: string }[]>`SELECT checksum FROM schema_migrations WHERE id = 1`;
    const original = row!.checksum;
    await sql`UPDATE schema_migrations SET checksum = '0000000000000000' WHERE id = 1`;
    try {
      await expect(initSchema(sql, { embeddingDims: 1024 })).rejects.toThrow(/frozen/);
    } finally {
      await sql`UPDATE schema_migrations SET checksum = ${original} WHERE id = 1`;
    }
    await expect(initSchema(sql, { embeddingDims: 1024 })).resolves.toMatchObject({ applied: [] });
  });

  it("refuses an embedding width the vector column or its index could not hold", async () => {
    await expect(initSchema(sql, { embeddingDims: 0 })).rejects.toThrow(/1\.\.2000/);
    await expect(initSchema(sql, { embeddingDims: 1.5 })).rejects.toThrow(/1\.\.2000/);
    await expect(initSchema(sql, { embeddingDims: MAX_EMBEDDING_DIMS + 1 })).rejects.toThrow(/1\.\.2000/);
  });

  it("caps the embedding width at the widest column the HNSW index accepts", async () => {
    const hnswOn = (dims: number) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`CREATE TEMP TABLE dims_probe (embedding vector(${dims})) ON COMMIT DROP`);
        await tx.unsafe("CREATE INDEX ON dims_probe USING hnsw (embedding vector_cosine_ops)");
      });
    await expect(hnswOn(MAX_EMBEDDING_DIMS)).resolves.not.toThrow();
    await expect(hnswOn(MAX_EMBEDDING_DIMS + 1)).rejects.toThrow(/2000 dimensions/);
  });

  it("stamps the boot version and reports the one before it", async () => {
    await sql`DELETE FROM node_state`;
    expect((await recordNodeBoot(sql, "9.9.9-test-a")).previousVersion).toBeNull();
    const { previousVersion } = await recordNodeBoot(sql, "9.9.9-test-b");
    expect(previousVersion).toBe("9.9.9-test-a");

    const state = await getNodeState(sql);
    expect(state?.app_version).toBe("9.9.9-test-b");
    expect(state!.last_boot_at.getTime()).toBeGreaterThanOrEqual(state!.first_boot_at.getTime());
  });

  it("picks the node's id on the first boot and keeps it on every later one", async () => {
    await sql`DELETE FROM node_state`;
    const first = await recordNodeBoot(sql, "9.9.9-test-a");
    expect(first.nodeId).toMatch(/^[a-z2-7]{16}$/);
    expect((await recordNodeBoot(sql, "9.9.9-test-b")).nodeId).toBe(first.nodeId);
    expect((await getNodeState(sql))?.node_id).toBe(first.nodeId);

    // A fresh database is a new node.
    await sql`DELETE FROM node_state`;
    expect((await recordNodeBoot(sql, "9.9.9-test-a")).nodeId).not.toBe(first.nodeId);
  });
});

describe.skipIf(!URL)("boot repairs", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });

  it("leaves no extension behind the installed extension files", async () => {
    await runBootRepairs(sql);

    const behind = await sql<{ extname: string }[]>`
      SELECT e.extname
      FROM pg_extension e
      JOIN pg_available_extensions a ON a.name = e.extname
      WHERE e.extversion IS DISTINCT FROM a.default_version`;
    expect(behind.map((r) => r.extname)).toEqual([]);
  });

  it("is a no-op the second time, and says so", async () => {
    await runBootRepairs(sql);
    const second = await runBootRepairs(sql);
    expect(second.updatedExtensions).toEqual([]);
    expect(second.searchIndexChanges).toEqual([]);
    expect(second.rebuiltSearchIndexes).toEqual([]);
  });
});
