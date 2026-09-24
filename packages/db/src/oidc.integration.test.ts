import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients, type Sql } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createLocalAccount } from "./identity.js";
import {
  createOidcFlow,
  createOidcTicket,
  peekOidcTicket,
  purgeOidcSignIns,
  takeOidcFlow,
  takeOidcTicket,
} from "./oidc.js";

const URL = process.env.TEST_DATABASE_URL;
const ISSUER = "https://id.example";

describe.skipIf(!URL)("identity-provider sign-ins in flight", () => {
  let sql: Sql;
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, local_accounts, oidc_flows, oidc_tickets CASCADE`;
  });

  const flowInput = (state: string, expiresAt = inMinutes(10), linkAlias: string | null = null) => ({
    state,
    bindingHash: "b",
    nonce: "n",
    codeVerifier: "v",
    redirectUri: "http://localhost:8787/auth/oidc/callback",
    prompt: null,
    linkAlias,
    returnTo: "/",
    expiresAt,
  });
  const flow = (state: string, expiresAt: Date, linkAlias: string | null = null) => createOidcFlow(sql, flowInput(state, expiresAt, linkAlias));

  const firstVisit = (hash: string, expiresAt: Date) =>
    createOidcTicket(sql, { ticketHash: hash, kind: "first_visit", bindingHash: "b", sub: "sub-1", issuer: ISSUER, returnTo: "/", expiresAt });

  it("hands a flow out once", async () => {
    await flow("s1", inMinutes(10));
    expect(await takeOidcFlow(sql, "s1")).toMatchObject({ state: "s1", nonce: "n", code_verifier: "v", prompt: null });
    expect(await takeOidcFlow(sql, "s1")).toBeNull();
    expect(await takeOidcFlow(sql, "never")).toBeNull();
  });

  it("keeps what the provider was asked about its session: nothing, silence, or which account", async () => {
    for (const prompt of [null, "none", "select_account"] as const) {
      await createOidcFlow(sql, { ...flowInput(`p-${prompt}`), prompt });
      expect(await takeOidcFlow(sql, `p-${prompt}`)).toMatchObject({ prompt });
    }
    await expect(
      sql`INSERT INTO oidc_flows (state, binding_hash, nonce, code_verifier, redirect_uri, prompt, return_to, expires_at)
          VALUES ('p-login', 'b', 'n', 'v', 'http://localhost:8787/auth/oidc/callback', 'login', '/', now() + interval '1 minute')`,
    ).rejects.toThrow(/oidc_flows_prompt_check/);
  });

  it("spends an expired flow without handing it out", async () => {
    await flow("old", inMinutes(-1));
    expect(await takeOidcFlow(sql, "old")).toBeNull();
    expect(await sql`SELECT 1 FROM oidc_flows`).toHaveLength(0);
  });

  it("drops a linking flow with its account", async () => {
    await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "h", mayClaim: true });
    await flow("link", inMinutes(10), "u1");
    await sql`DELETE FROM users WHERE alias = 'u1'`;
    expect(await takeOidcFlow(sql, "link")).toBeNull();
  });

  it("peeks a ticket as often as asked, and spends it once", async () => {
    await firstVisit("t1", inMinutes(10));
    expect(await peekOidcTicket(sql, "t1", "first_visit")).toMatchObject({ sub: "sub-1", issuer: ISSUER, alias: null });
    expect(await peekOidcTicket(sql, "t1", "first_visit")).not.toBeNull();
    // A ticket of one kind never answers for the other.
    expect(await peekOidcTicket(sql, "t1", "session")).toBeNull();
    expect(await takeOidcTicket(sql, "t1", "session")).toBeNull();

    const results = await Promise.all([takeOidcTicket(sql, "t1", "first_visit"), takeOidcTicket(sql, "t1", "first_visit")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await peekOidcTicket(sql, "t1", "first_visit")).toBeNull();
  });

  it("neither shows nor spends an expired ticket", async () => {
    await firstVisit("stale", inMinutes(-1));
    expect(await peekOidcTicket(sql, "stale", "first_visit")).toBeNull();
    expect(await takeOidcTicket(sql, "stale", "first_visit")).toBeNull();
  });

  it("keeps a session handoff and a first-visit ticket from carrying each other's fields", async () => {
    await expect(
      createOidcTicket(sql, { ticketHash: "x", kind: "session", bindingHash: "b", sub: "sub-1", returnTo: "/", expiresAt: inMinutes(1) }),
    ).rejects.toThrow(/oidc_tickets_check/);
    await expect(
      createOidcTicket(sql, { ticketHash: "y", kind: "first_visit", bindingHash: "b", issuer: ISSUER, returnTo: "/", expiresAt: inMinutes(1) }),
    ).rejects.toThrow(/oidc_tickets_check/);
  });

  it("keeps a first visit's subject with the issuer that vouched for it", async () => {
    // Without it, a first visit could not tell a subject the node's provider vouched for from one its previous provider did.
    await expect(
      createOidcTicket(sql, { ticketHash: "z", kind: "first_visit", bindingHash: "b", sub: "sub-1", returnTo: "/", expiresAt: inMinutes(1) }),
    ).rejects.toThrow(/oidc_tickets_check/);
  });

  it("purges only what has expired", async () => {
    await flow("live", inMinutes(10));
    await flow("dead", inMinutes(-1));
    await firstVisit("live", inMinutes(10));
    await firstVisit("dead", inMinutes(-1));
    expect(await purgeOidcSignIns(sql)).toBe(2);
    expect((await sql<{ state: string }[]>`SELECT state FROM oidc_flows`).map((r) => r.state)).toEqual(["live"]);
    expect((await sql<{ ticket_hash: string }[]>`SELECT ticket_hash FROM oidc_tickets`).map((r) => r.ticket_hash)).toEqual(["live"]);
  });
});
