import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { resolveHumanAuth, upsertGroup } from "./workspaces.js";
import { seedUser } from "./testing/fixtures.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const WS_A = "ws-auth-a";
const WS_B = "ws-auth-b";
const ALICE = "alice-sub";

describe.skipIf(!URL)("resolveHumanAuth", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE workspace_members CASCADE`;
    await sql`TRUNCATE workspaces CASCADE`;
    await sql`TRUNCATE groups CASCADE`;
    await sql`TRUNCATE users CASCADE`;
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS_A}, 'A'), (${WS_B}, 'B')`;
  });

  async function join(workspaceId: string, alias: string, role: string, joinedAt: string) {
    await sql`INSERT INTO workspace_members ${sql({
      workspace_id: workspaceId,
      alias,
      role,
      joined_at: joinedAt,
    })}`;
  }

  it("returns the directory row, the earliest membership and that workspace's groups", async () => {
    await seedUser(sql, ALICE, "Alice", "alice@x.test", "alice");
    await join(WS_A, ALICE, "member", "2026-01-01");
    await upsertGroup(sql, "group:eng", [`user:${ALICE}`], WS_A);

    const auth = await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, null);
    expect(auth.user).toMatchObject({ display_name: "Alice", username: "alice", email: "alice@x.test" });
    expect(auth.membership).toEqual({ workspace_id: WS_A, role: "member" });
    expect(auth.groupIds).toEqual(["group:eng"]);
  });

  it("picks the EARLIEST membership when no workspace is requested", async () => {
    await join(WS_B, ALICE, "admin", "2026-02-01");
    await join(WS_A, ALICE, "member", "2026-01-01");
    const auth = await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, null);
    expect(auth.membership).toEqual({ workspace_id: WS_A, role: "member" });
  });

  it("honors a requested workspace the caller is a member of, with THAT role", async () => {
    await join(WS_A, ALICE, "member", "2026-01-01");
    await join(WS_B, ALICE, "owner", "2026-02-01");
    const auth = await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, WS_B);
    expect(auth.membership).toEqual({ workspace_id: WS_B, role: "owner" });
  });

  it("IGNORES a requested workspace the caller does not belong to", async () => {
    await join(WS_A, ALICE, "member", "2026-01-01");
    const auth = await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, WS_B);
    expect(auth.membership).toEqual({ workspace_id: WS_A, role: "member" });
  });

  it("returns only the RESOLVED workspace's groups, never another tenant's", async () => {
    await join(WS_A, ALICE, "member", "2026-01-01");
    await join(WS_B, ALICE, "member", "2026-02-01");
    await upsertGroup(sql, "group:eng", [`user:${ALICE}`], WS_A);
    await upsertGroup(sql, "group:sales", [`user:${ALICE}`], WS_B);

    expect((await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, WS_A)).groupIds).toEqual(["group:eng"]);
    expect((await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, WS_B)).groupIds).toEqual(["group:sales"]);
  });

  it("does not leak a group the caller is not a member of", async () => {
    await join(WS_A, ALICE, "member", "2026-01-01");
    await upsertGroup(sql, "group:execs", ["user:someone-else"], WS_A);
    expect((await resolveHumanAuth(sql, ALICE, `user:${ALICE}`, WS_A)).groupIds).toEqual([]);
  });

  it("answers totally for a caller with no directory row and no membership", async () => {
    const auth = await resolveHumanAuth(sql, "nobody-sub", "user:nobody-sub", null);
    expect(auth.user).toBeNull();
    expect(auth.membership).toBeNull();
    expect(auth.groupIds).toEqual([]);
  });
});
