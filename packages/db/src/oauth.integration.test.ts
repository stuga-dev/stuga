import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { consumeOauthCode, insertOauthClient, insertOauthCode } from "./agents.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("OAuth authorization codes", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE oauth_codes, oauth_clients CASCADE`;
    await seedWorkspaces(sql, "ws-1");
    await insertOauthClient(sql, {
      clientId: "client-1",
      clientSecretHash: null,
      redirectUris: ["https://client.example.test/callback"],
      clientName: "Test client",
    });
    await insertOauthCode(sql, {
      codeHash: "code-hash",
      clientId: "client-1",
      userAlias: "alice",
      workspaceId: "ws-1",
      redirectUri: "https://client.example.test/callback",
      codeChallenge: "challenge",
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it("does not consume a code when a binding is wrong, then consumes it once", async () => {
    const base = {
      codeHash: "code-hash",
      clientId: "client-1",
      redirectUri: "https://client.example.test/callback",
    };
    expect(await consumeOauthCode(sql, { ...base, codeChallenge: "wrong" })).toBeNull();

    const consumed = await consumeOauthCode(sql, { ...base, codeChallenge: "challenge" });
    expect(consumed).toMatchObject({ client_id: "client-1", user_alias: "alice", workspace_id: "ws-1" });
    expect(await consumeOauthCode(sql, { ...base, codeChallenge: "challenge" })).toBeNull();
  });

  it("does not exchange an expired code", async () => {
    await sql`UPDATE oauth_codes SET expires_at = now() - interval '1 second'`;
    expect(
      await consumeOauthCode(sql, {
        codeHash: "code-hash",
        clientId: "client-1",
        redirectUri: "https://client.example.test/callback",
        codeChallenge: "challenge",
      }),
    ).toBeNull();
    const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM oauth_codes`;
    expect(rows[0]?.count).toBe("0");
  });
});
