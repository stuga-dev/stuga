/**
 * What a database's store holds is pinned to DATABASE_STORE_VERSION: the SQL schema of its file as
 * the real host leaves it, its meta tables and how a user table and its columns are declared. The
 * names a table and its columns get, and the starter table a new database begins with, are left out:
 * they shape new data, not what an older store holds. A change to what is pinned raises the version,
 * with the step in the host that brings an older store forward.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_OPS_KEEP } from "@stuga/protocol/databases/limits";
import type { TableSchema } from "@stuga/protocol/databases/types";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { createActorNamespace, type ActorHandle } from "@stuga/runtime";
import { MemoryBlobStore, MemoryJobQueue, storeSchema } from "@stuga/runtime/testing";
import { DATABASE_STORE_UPGRADES, DATABASE_STORE_VERSION } from "./schema-ops.js";
import { DatabaseActor } from "./database-actor.js";
import { HUMAN } from "../test/harness.js";

/** The fingerprint of each version's store. A released version's entry never changes. */
const PINNED: Record<number, string> = {
  1: "20487a4d32855891",
  2: "8d9ed624efe89b80",
  3: "d3f3a5ba37b6da61",
  4: "dfdc1d1458cd3df0",
  5: "43c9bf9b78b7df2b",
  6: "cc4c37e98f09e188",
};

/** Take out of a fresh store what version 6 brought: the change a run belongs to and the run it waits behind. */
function withoutChanges(db: DatabaseSync): void {
  for (const column of ["stacked_on", "queued_behind", "change_id"]) db.exec(`ALTER TABLE _runs DROP COLUMN ${column}`);
}

/** Take out of a fresh store what versions 5 and 6 brought: the colleague level's columns and trigger, and changes. */
function withoutColleagueLevel(db: DatabaseSync): void {
  withoutChanges(db);
  db.exec(`DROP TRIGGER _run_ops_colleague_approves`);
  db.exec(`ALTER TABLE _run_ops DROP COLUMN decided_level`);
  db.exec(`ALTER TABLE _runs DROP COLUMN approver_group`);
}

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

async function post<T>(actor: ActorHandle, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await actor.fetch(`http://actor${path}?dbId=db_test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops_keep: DATABASE_OPS_KEEP, actor: HUMAN, ...body }),
  });
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

describe("a database's store", () => {
  it("holds what DATABASE_STORE_VERSION pins", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-db-store-"));
    const ns = createActorNamespace(
      DatabaseActor,
      { snapshots: new MemoryBlobStore(), jobs: new MemoryJobQueue<IndexMessage>() },
      { name: "databases", heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG }, dir, storeVersion: DATABASE_STORE_VERSION },
    );
    let starter = "";
    try {
      const actor = ns.get("db_test");
      const { schema } = await post<{ schema: { tables: TableSchema[] } }>(actor, "/schema/init", {});
      starter = schema.tables[0]!.name;
      await post(actor, "/tables/create", { display: "Second", columns: [{ display: "Title", type: "text" }] });
      const { schema: after } = await post<{ schema: { tables: TableSchema[] } }>(actor, "/schema/init", {});
      await post(actor, "/columns/add", { table_id: after.tables.find((t) => t.name !== starter)!.table_id, display: "Due", type: "date" });
    } finally {
      await ns.close();
    }

    const file = join(dir, "db_test.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    const rename: Record<string, string> = {};
    try {
      for (const t of db.prepare("SELECT name FROM _tables WHERE name <> ?").all(starter) as { name: string }[]) rename[t.name] = "<table>";
      for (const c of db.prepare("SELECT c.name FROM _columns c JOIN _tables t USING (table_id) WHERE t.name <> ?").all(starter) as {
        name: string;
      }[]) {
        rename[c.name] = "<column>";
      }
    } finally {
      db.close();
    }
    expect(Object.values(rename)).toEqual(["<table>", "<column>", "<column>"]);
    const { schema, fingerprint } = storeSchema(file, { leaveOut: [starter], rename });
    expect(
      fingerprint,
      `what a database's store holds changed:\n${schema}\n` +
        `If that is meant, raise DATABASE_STORE_VERSION (packages/database-actor/src/schema-ops.ts), add the step in ` +
        `claimStoreVersion (packages/runtime/src/actor-host.ts) that brings an older store forward, and pin ${fingerprint} ` +
        `under the new version here.`,
    ).toBe(PINNED[DATABASE_STORE_VERSION]);
  });

  it("brings a version 1 store forward to what a new one holds, keeping its runs", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-db-store-"));
    const file = join(dir, "db_test.sqlite");
    const open = () =>
      createActorNamespace(
        DatabaseActor,
        { snapshots: new MemoryBlobStore(), jobs: new MemoryJobQueue<IndexMessage>() },
        {
          name: "databases",
          heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG },
          dir,
          storeVersion: DATABASE_STORE_VERSION,
          storeUpgrades: DATABASE_STORE_UPGRADES,
        },
      );
    const runOpsSql = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare(`SELECT sql FROM sqlite_master WHERE name = '_run_ops'`).get() as { sql: string }).sql.replace(/\s+/g, " ");
      } finally {
        db.close();
      }
    };

    const fresh = open();
    try {
      await post(fresh.get("db_test"), "/schema/init", {});
    } finally {
      await fresh.close();
    }
    const current = runOpsSql();

    // The ledger as version 1 left it, with one decided op in it.
    const v1 = new DatabaseSync(file);
    try {
      v1.exec(
        `INSERT INTO _run_ops (run_id, op_id, position, kind, table_id, summary, status, bytes, decided_by, review)
         VALUES ('run_1', 'o1', 1, 'rows.insert', 't1', 'Insert 1 row', 'rejected', 2, 'alice', 'review')`,
      );
      withoutColleagueLevel(v1);
      v1.exec(`ALTER TABLE _run_ops DROP COLUMN detail`);
      v1.exec(`ALTER TABLE _run_ops DROP COLUMN feedback`);
      v1.exec(`PRAGMA user_version = 1`);
    } finally {
      v1.close();
    }

    const upgraded = open();
    try {
      await post(upgraded.get("db_test"), "/schema/init", {});
    } finally {
      await upgraded.close();
    }
    expect(runOpsSql()).toBe(current);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(DATABASE_STORE_VERSION);
      expect(db.prepare(`SELECT op_id, status, decided_by, feedback FROM _run_ops`).all()).toEqual([
        { op_id: "o1", status: "rejected", decided_by: "alice", feedback: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("brings a version 2 store forward, keeping each op's summary, with no detail on ops it already held", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-db-store-"));
    const file = join(dir, "db_test.sqlite");
    const open = () =>
      createActorNamespace(
        DatabaseActor,
        { snapshots: new MemoryBlobStore(), jobs: new MemoryJobQueue<IndexMessage>() },
        {
          name: "databases",
          heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG },
          dir,
          storeVersion: DATABASE_STORE_VERSION,
          storeUpgrades: DATABASE_STORE_UPGRADES,
        },
      );
    const opsSql = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare(`SELECT sql FROM sqlite_master WHERE name = '_ops'`).get() as { sql: string }).sql.replace(/\s+/g, " ");
      } finally {
        db.close();
      }
    };

    const fresh = open();
    try {
      await post(fresh.get("db_test"), "/schema/init", {});
    } finally {
      await fresh.close();
    }
    const current = opsSql();

    // The ledger as version 2 left it: the op init recorded, without its detail.
    const v2 = new DatabaseSync(file);
    try {
      withoutColleagueLevel(v2);
      v2.exec(`ALTER TABLE _ops DROP COLUMN detail`);
      v2.exec(`ALTER TABLE _run_ops DROP COLUMN detail`);
      v2.exec(`PRAGMA user_version = 2`);
    } finally {
      v2.close();
    }

    const upgraded = open();
    let listed: Array<{ kind: string; summary: string; detail: unknown }> = [];
    try {
      const actor = upgraded.get("db_test");
      const { schema } = await post<{ schema: { tables: TableSchema[] } }>(actor, "/schema/init", {});
      await post(actor, "/tables/rename", { table_id: schema.tables[0]!.table_id, display: "Renamed" });
      const res = await actor.fetch(`http://actor/ops?dbId=db_test`);
      listed = ((await res.json()) as { ops: typeof listed }).ops;
    } finally {
      await upgraded.close();
    }
    expect(opsSql()).toBe(current);
    expect(listed.map((o) => [o.kind, o.detail === null])).toEqual([
      ["tables.rename", false],
      ["tables.create", true],
    ]);
    expect(listed[1]!.summary).toMatch(/^Created table /);
  });
  it("brings a version 4 store forward with the colleague level, refusing a run's reviewer who accepts it there", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-db-store-"));
    const file = join(dir, "db_test.sqlite");
    const open = () =>
      createActorNamespace(
        DatabaseActor,
        { snapshots: new MemoryBlobStore(), jobs: new MemoryJobQueue<IndexMessage>() },
        {
          name: "databases",
          heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG },
          dir,
          storeVersion: DATABASE_STORE_VERSION,
          storeUpgrades: DATABASE_STORE_UPGRADES,
        },
      );
    const ledgerSql = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare(`SELECT name, sql FROM sqlite_master WHERE name IN ('_runs', '_run_ops', '_run_ops_colleague_approves') ORDER BY name`).all() as Array<{ sql: string }>)
          .map((r) => r.sql.replace(/\s+/g, " "));
      } finally {
        db.close();
      }
    };
    const fresh = open();
    try {
      await post(fresh.get("db_test"), "/schema/init", {});
    } finally {
      await fresh.close();
    }
    const current = ledgerSql();

    // The ledger as version 4 left it: a run with one op waiting, no level decided on anything.
    const v4 = new DatabaseSync(file);
    try {
      withoutColleagueLevel(v4);
      v4.exec(
        `INSERT INTO _runs (run_id, source, agent, agent_alias, reviewer, status, acknowledged, auto_applied, reverted,
           workspace_id, doc_title, review_mode, client, model, created_at, updated_at)
         VALUES ('run_1', 'stdio', 'Agent', 'agent-1', 'alice', 'open', 0, 0, 0, 'ws', 'Tasks', 'colleague', NULL, NULL, 1, 1)`,
      );
      v4.exec(
        `INSERT INTO _run_ops (run_id, op_id, position, kind, table_id, summary, status, bytes, review)
         VALUES ('run_1', 'o1', 1, 'rows.insert', 't1', 'Insert 1 row', 'pending', 2, 'colleague')`,
      );
      v4.exec(`PRAGMA user_version = 4`);
    } finally {
      v4.close();
    }

    const upgraded = open();
    try {
      await post(upgraded.get("db_test"), "/schema/init", {});
    } finally {
      await upgraded.close();
    }
    expect(ledgerSql()).toEqual(current);
    const db = new DatabaseSync(file);
    try {
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(DATABASE_STORE_VERSION);
      expect(db.prepare(`SELECT approver_group FROM _runs`).all()).toEqual([{ approver_group: null }]);
      // The store refuses it whatever the code does: the run is at `colleague` and alice asked for it.
      expect(() => db.exec(`UPDATE _run_ops SET status = 'accepted', decided_by = 'alice' WHERE op_id = 'o1'`)).toThrow(
        /a colleague approves this change/,
      );
      db.exec(`UPDATE _run_ops SET status = 'accepted', decided_by = 'bo', decided_level = 'colleague' WHERE op_id = 'o1'`);
    } finally {
      db.close();
    }
  });

  it("brings a version 5 store forward with the change a run belongs to, its runs in none", async () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-db-store-"));
    const file = join(dir, "db_test.sqlite");
    const open = () =>
      createActorNamespace(
        DatabaseActor,
        { snapshots: new MemoryBlobStore(), jobs: new MemoryJobQueue<IndexMessage>() },
        {
          name: "databases",
          heartbeat: { request: Heartbeat.PING, response: Heartbeat.PONG },
          dir,
          storeVersion: DATABASE_STORE_VERSION,
          storeUpgrades: DATABASE_STORE_UPGRADES,
        },
      );
    const runsSql = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare(`SELECT sql FROM sqlite_master WHERE name = '_runs'`).get() as { sql: string }).sql.replace(/\s+/g, " ");
      } finally {
        db.close();
      }
    };
    const fresh = open();
    try {
      await post(fresh.get("db_test"), "/schema/init", {});
    } finally {
      await fresh.close();
    }
    const current = runsSql();
    const v5 = new DatabaseSync(file);
    try {
      withoutChanges(v5);
      v5.exec(
        `INSERT INTO _runs (run_id, source, agent, agent_alias, reviewer, status, acknowledged, auto_applied, reverted,
           workspace_id, doc_title, review_mode, client, model, created_at, updated_at, approver_group)
         VALUES ('run_1', 'stdio', 'Agent', 'agent-1', 'alice', 'open', 0, 0, 0, 'ws', 'Tasks', 'review', NULL, NULL, 1, 1, NULL)`,
      );
      v5.exec(`PRAGMA user_version = 5`);
    } finally {
      v5.close();
    }
    const upgraded = open();
    try {
      await post(upgraded.get("db_test"), "/schema/init", {});
    } finally {
      await upgraded.close();
    }
    expect(runsSql()).toBe(current);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare(`SELECT run_id, change_id, queued_behind, stacked_on FROM _runs`).all()).toEqual([
        { run_id: "run_1", change_id: null, queued_behind: null, stacked_on: null },
      ]);
    } finally {
      db.close();
    }
  });
});
