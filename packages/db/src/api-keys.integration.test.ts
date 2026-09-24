import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import {
  getApiKey,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  revokeWorkspaceApiKeysForOwner,
  purgeRevokedApiKeys,
} from "./agents.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("api key revocation scopes", () => {
  let sql: Sql;

  const key = (over: Partial<Parameters<typeof insertApiKey>[1]> = {}) => ({
    keyId: "k-a-alice",
    secretHash: "hash",
    agentId: "agent-a-alice",
    owner: "alice",
    workspaceId: "ws-a",
    name: "Claude (Connector)",
    ...over,
  });

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE api_keys CASCADE`;
    await seedWorkspaces(sql, "ws-a", "ws-b");
    await insertApiKey(sql, key());
    await insertApiKey(sql, key({ keyId: "k-a-bob", agentId: "agent-a-bob", owner: "bob" }));
    await insertApiKey(sql, key({ keyId: "k-b-alice", agentId: "agent-b-alice", workspaceId: "ws-b" }));
  });

  it("lists a person's keys across every workspace they belong to", async () => {
    expect((await listApiKeys(sql, "alice")).map((k) => k.key_id).sort()).toEqual(["k-a-alice", "k-b-alice"]);
    expect((await listApiKeys(sql, "bob")).map((k) => k.key_id)).toEqual(["k-a-bob"]);
  });

  it("refuses to revoke a key the caller does not own", async () => {
    expect(await revokeApiKey(sql, "k-a-bob", "alice")).toBe(false);
    expect(await getApiKey(sql, "k-a-bob")).not.toBeNull();
  });

  it("records the owner as the revoker on a self-revoke", async () => {
    expect(await revokeApiKey(sql, "k-a-alice", "alice")).toBe(true);
    const row = (await listApiKeys(sql, "alice")).find((k) => k.key_id === "k-a-alice");
    expect(row?.revoked_by).toBe("alice");
  });

  it("revokes all of one person's keys in the workspace they left, and only those", async () => {
    const gone = await revokeWorkspaceApiKeysForOwner(sql, "ws-a", "alice", "carol");
    expect(gone.map((k) => k.key_id)).toEqual(["k-a-alice"]);
    expect(gone[0]!.revoked_by).toBe("carol");
    expect(await getApiKey(sql, "k-b-alice")).not.toBeNull();
    expect(await getApiKey(sql, "k-a-bob")).not.toBeNull();
  });

  it("is inert for someone who holds no keys there", async () => {
    expect(await revokeWorkspaceApiKeysForOwner(sql, "ws-a", "nobody", "carol")).toEqual([]);
  });

  it("purges keys past the retention window, keeping recent ones and live ones", async () => {
    await revokeApiKey(sql, "k-a-alice", "alice");
    await revokeApiKey(sql, "k-a-bob", "bob");
    await sql`UPDATE api_keys SET revoked_at = now() - interval '31 days' WHERE key_id = 'k-a-bob'`;

    expect(await purgeRevokedApiKeys(sql, 30)).toBe(1);

    const remaining = (await listApiKeys(sql, "alice")).filter((k) => k.workspace_id === "ws-a");
    expect(remaining.map((k) => k.key_id)).toEqual(["k-a-alice"]);
    expect(await purgeRevokedApiKeys(sql, 30)).toBe(0);
  });

  it("never purges a live key, however old", async () => {
    await sql`UPDATE api_keys SET created_at = now() - interval '400 days'`;
    expect(await purgeRevokedApiKeys(sql, 30)).toBe(0);
    expect(await getApiKey(sql, "k-a-alice")).not.toBeNull();
  });
});
