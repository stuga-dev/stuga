import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { getOauthClient, insertOauthClient, purgeUnusedOauthClients } from "./agents.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("unused oauth client registrations", () => {
  let sql: Sql;

  const register = (clientId: string) =>
    insertOauthClient(sql, {
      clientId,
      clientSecretHash: null,
      redirectUris: ["https://client.example/callback"],
      clientName: "Some MCP client",
    });

  const backdate = async (clientId: string, days: number) => {
    await sql`
      UPDATE oauth_clients
      SET created_at = now() - ${`${days} days`}::interval,
          last_used_at = now() - ${`${days} days`}::interval
      WHERE client_id = ${clientId}`;
  };

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  beforeEach(async () => {
    await sql`DELETE FROM oauth_clients`;
  });
  afterAll(async () => {
    await closeClients();
  });

  it("drops a registration nothing has touched since", async () => {
    await register("cid_stale");
    await backdate("cid_stale", 120);
    expect(await purgeUnusedOauthClients(sql, 90)).toBe(1);
    expect(await getOauthClient(sql, "cid_stale")).toBeNull();
  });

  it("keeps one inside the window", async () => {
    await register("cid_recent");
    await backdate("cid_recent", 10);
    expect(await purgeUnusedOauthClients(sql, 90)).toBe(0);
    expect(await getOauthClient(sql, "cid_recent")).not.toBeNull();
  });

  it("keeps an old registration that is still in use", async () => {
    await register("cid_old_but_live");
    await backdate("cid_old_but_live", 400);
    expect(await getOauthClient(sql, "cid_old_but_live")).not.toBeNull();
    expect(await purgeUnusedOauthClients(sql, 90)).toBe(0);
    expect(await getOauthClient(sql, "cid_old_but_live")).not.toBeNull();
  });

  it("stamps last_used_at on every lookup", async () => {
    await register("cid_touch");
    await backdate("cid_touch", 400);
    const before = await sql<{ last_used_at: Date }[]>`SELECT last_used_at FROM oauth_clients WHERE client_id = 'cid_touch'`;
    await getOauthClient(sql, "cid_touch");
    const after = await sql<{ last_used_at: Date }[]>`SELECT last_used_at FROM oauth_clients WHERE client_id = 'cid_touch'`;
    expect(after[0]!.last_used_at.getTime()).toBeGreaterThan(before[0]!.last_used_at.getTime());
  });

  it("purges a registration that was never used", async () => {
    await register("cid_null");
    await backdate("cid_null", 200);
    await sql`UPDATE oauth_clients SET last_used_at = NULL WHERE client_id = 'cid_null'`;
    expect(await purgeUnusedOauthClients(sql, 90)).toBe(1);
  });

  it("leaves a client alone that a lookup found missing", async () => {
    expect(await getOauthClient(sql, "cid_nope")).toBeNull();
    expect(await purgeUnusedOauthClients(sql, 90)).toBe(0);
  });
});
