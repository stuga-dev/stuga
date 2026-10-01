/**
 * Passkeys at the remote address (./passkey-routes.ts), driven end to end through the identity
 * routes by a software authenticator that makes real keys and real WebAuthn encodings, checked by the
 * real library: adding one from a confirmed session, signing in with it, confirming a session with
 * it, and every refusal. What the database keeps is tested against Postgres (packages/db
 * passkeys.integration.test.ts); the account API (list, rename, remove) in api/passkeys.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@stuga/auth";
import { SoftAuthenticator } from "@stuga/auth/webauthn-testing";
import { createPasskeyChallenges, type PasskeyChallenges } from "./passkey-challenges.js";
import { REMOTE_ORIGIN, harness, type Harness } from "./testing/harness.js";
import type { TokenPair } from "./routes.js";

const PASSWORD = "trumpet walnut ceiling";
const RP_ID = new URL(REMOTE_ORIGIN).hostname;
let hash: string;
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

/** Challenges a test can restart, as a node restart would: everything signed before is void. */
function restartable(): PasskeyChallenges & { restart(): void } {
  let inner = createPasskeyChallenges();
  return {
    issue: (...a) => inner.issue(...a),
    read: (...a) => inner.read(...a),
    claim: (...a) => inner.claim(...a),
    release: (...a) => inner.release(...a),
    held: () => inner.held(),
    restart: () => void (inner = createPasskeyChallenges()),
  };
}

let h: Harness;
let challenges: ReturnType<typeof restartable>;
let soft: SoftAuthenticator;
beforeEach(async () => {
  challenges = restartable();
  h = await harness({ passkeyChallenges: challenges });
  await h.account("liv", hash);
  await h.account("bo", hash);
  soft = new SoftAuthenticator({ origin: REMOTE_ORIGIN });
});
afterEach(() => h.close());

const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });
const post = (path: string, body: unknown, headers: Record<string, string> = {}, peer?: string) =>
  h.router.handle(h.remote(path, body, headers, peer));

async function createOptions(pair: TokenPair): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const res = await post("/auth/passkey/options", { purpose: "add" }, bearer(pair));
  expect(res.status).toBe(200);
  return ((await res.json()) as { publicKey: PublicKeyCredentialCreationOptionsJSON }).publicKey;
}

async function requestOptions(purpose: "sign-in" | "reauth" = "sign-in", pair?: TokenPair): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const res = await post("/auth/passkey/options", { purpose }, pair ? bearer(pair) : {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { publicKey: PublicKeyCredentialRequestOptionsJSON }).publicKey;
}

/** Bo signs in with his password at the remote address and adds a passkey; the session he did it from. */
async function boWithPasskey(): Promise<{ pair: TokenPair; id: string }> {
  const { pair } = await h.signIn("remote", "bo", PASSWORD);
  const res = await post("/auth/passkey/add", { credential: soft.create(await createOptions(pair)) }, bearer(pair));
  expect(res.status).toBe(201);
  return { pair, id: ((await res.json()) as { id: string }).id };
}

describe("where passkeys exist", () => {
  it("says so in /auth/config at the remote address only, and the node's own network sees no change", async () => {
    const remote = (await (await h.router.handle(new Request(`${REMOTE_ORIGIN}/auth/config`, { headers: { "x-stuga-arrival": "remote" } }))).json()) as Record<string, unknown>;
    expect(remote.passkey).toBe(true);
    const lan = (await (await h.router.handle(new Request("http://livs-air.local:8787/auth/config"))).json()) as Record<string, unknown>;
    expect(Object.keys(lan).sort()).toEqual(["branding", "node_label", "node_name", "origin", "provider", "unclaimed"]);
  });

  it("answers 404 on the node's own network, which is plain http", async () => {
    const { pair } = await h.signIn("lan", "bo", PASSWORD);
    for (const path of ["/auth/passkey/options", "/auth/passkey/sign-in", "/auth/passkey/add"]) {
      const res = await h.router.handle(h.lan(path, { purpose: "sign-in" }, bearer(pair)));
      expect(res.status).toBe(404);
    }
  });
});

describe("adding a passkey", () => {
  it("from a session confirmed in the last five minutes, named for where it lives, and the person is told", async () => {
    h.alerts.length = 0;
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const options = await createOptions(pair);
    expect(options.rp.id).toBe(RP_ID);
    expect(options.rp.name).toBe("North Office");
    expect(options.user.name).toBe("bo");
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    const res = await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(pair));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; synced: boolean };
    // Synced, from Safari on an iPhone: it lives in iCloud Keychain.
    expect(body).toMatchObject({ name: "iCloud Keychain", synced: true });
    const row = h.mem.passkeys.get(body.id)!;
    expect(row).toMatchObject({ alias: "u_bo", rp_id: RP_ID, backup_eligible: true, synced: true, sign_count: 0 });
    expect(h.alerts.find((a) => a.kind === "passkeyAdded")?.input).toMatchObject({
      alias: "u_bo",
      name: "iCloud Keychain",
      remoteHost: RP_ID,
      device: "Safari on iPhone",
      from: "203.0.113.7",
    });
    expect(h.events.find((e) => e.action === "node.passkey.add")).toMatchObject({ alias: "u_bo" });
  });

  it("lists the passkeys the person has here, so an authenticator holding one says so", async () => {
    const { pair } = await boWithPasskey();
    const options = await createOptions(pair);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([...h.mem.passkeys.keys()]);
  });

  it("asks a session older than five minutes to confirm first, naming a passkey among the ways once there is one", async () => {
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    h.age(6);
    const stale = await post("/auth/passkey/options", { purpose: "add" }, bearer(pair));
    expect(stale.status).toBe(401);
    expect(stale.headers.get("x-stuga-reauth")).toBe("1");
    expect(((await stale.json()) as { methods: string[] }).methods).toEqual(["password"]);

    const withKey = await boWithPasskey();
    h.age(6);
    const again = await post("/auth/passkey/options", { purpose: "add" }, bearer(withKey.pair));
    expect(((await again.json()) as { methods: string[] }).methods).toEqual(["passkey", "password"]);
  });

  it("takes only a creation for this session's own challenge, made at this address", async () => {
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const other = await h.signIn("remote", "liv", PASSWORD);
    const options = await createOptions(pair);
    // Liv cannot add a passkey to her account with Bo's challenge.
    expect((await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(other.pair))).status).toBe(400);
    // Nor Bo from another of his sessions.
    const second = await h.signIn("remote", "bo", PASSWORD);
    expect((await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(second.pair))).status).toBe(400);
    // Nor a creation made on another origin, or another host's RP ID.
    expect((await post("/auth/passkey/add", { credential: soft.create(options, { origin: "http://livs-air.local:8787" }) }, bearer(pair))).status).toBe(400);
    expect((await post("/auth/passkey/add", { credential: soft.create(options, { rpId: "stuga.test" }) }, bearer(pair))).status).toBe(400);
    // Each failure gave the challenge back: the real one still works.
    expect((await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(pair))).status).toBe(201);
    // And only once.
    expect((await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(pair))).status).toBe(400);
    // No session, no passkey.
    expect((await post("/auth/passkey/add", { credential: soft.create(await createOptions(pair)) })).status).toBe(401);
  });

  it("holds the five minutes at the add itself: a challenge asked for in time does not stretch them", async () => {
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const options = await createOptions(pair);
    h.age(6);
    const late = await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(pair));
    expect(late.status).toBe(401);
    expect(late.headers.get("x-stuga-reauth")).toBe("1");
    expect(h.mem.passkeys.size).toBe(0);
    // Confirmed again, the same challenge, never claimed, adds it.
    expect((await post("/auth/confirm", { password: PASSWORD }, bearer(pair))).status).toBe(204);
    expect((await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(pair))).status).toBe(201);
  });

  it("is not added when the session that asked ends while it is checked, as a Revoke everything does", async () => {
    h.alerts.length = 0;
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const options = await createOptions(pair);
    const insert = h.mem.db.insertPasskey.bind(h.mem.db);
    h.mem.db.insertPasskey = async (p, requires) => {
      // Lands after the add checked its session, before the passkey is written.
      for (const row of h.mem.sessions.values()) if (row.alias === "u_bo") row.revoked_at = new Date().toISOString();
      return insert(p, requires);
    };
    const res = await post("/auth/passkey/add", { credential: soft.create(options) }, bearer(pair));
    expect(res.status).toBe(401);
    expect(h.mem.passkeys.size).toBe(0);
    expect(h.alerts.find((a) => a.kind === "passkeyAdded")).toBeUndefined();
  });

  it("says a failed add is an add that failed, not a sign-in", async () => {
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const options = await createOptions(pair);
    const res = await post("/auth/passkey/add", { credential: soft.create(options, { origin: "http://livs-air.local:8787" }) }, bearer(pair));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("passkey_not_added");
  });

  it("never replaces a passkey another account holds", async () => {
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const credential = soft.create(await createOptions(pair));
    h.mem.passkeys.set(credential.id, { ...h.mem.passkeys.get(credential.id)!, credential_id: credential.id, alias: "u_liv", rp_id: RP_ID } as never);
    const res = await post("/auth/passkey/add", { credential }, bearer(pair));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("passkey_exists");
    expect(h.mem.passkeys.get(credential.id)!.alias).toBe("u_liv");
  });
});

describe("signing in with a passkey", () => {
  it("signs in without a username, a session of its own that the passkey made", async () => {
    const { id } = await boWithPasskey();
    const res = await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) });
    expect(res.status).toBe(200);
    const pair = (await res.json()) as TokenPair & { passkey_offer?: boolean };
    expect(Object.keys(pair).sort()).toEqual(["access_token", "expires_in", "refresh_token", "token_type"]);
    const row = [...h.mem.sessions.values()].find((r) => r.passkey_id === id)!;
    expect(row).toMatchObject({ alias: "u_bo", arrival: "remote", signed_in_with: "passkey" });
    expect(row.absolute_expires_at).not.toBeNull();
    expect(h.mem.passkeys.get(id)!.last_used_at).not.toBeNull();
    expect(h.mem.passkeys.get(id)!.sign_count).toBe(1);
  });

  it("counts no sign-in whose counter another sign-in with the passkey has passed meanwhile", async () => {
    const { id } = await boWithPasskey();
    // Two responses checked against the same stored counter: the higher lands first.
    const lower = soft.get(await requestOptions());
    const higher = soft.get(await requestOptions());
    expect((await post("/auth/passkey/sign-in", { credential: higher })).status).toBe(200);
    h.mem.passkeys.get(id)!.sign_count = 0;
    const stored = h.mem.passkeys.get(id)!;
    const record = h.mem.db.recordPasskeyUse.bind(h.mem.db);
    h.mem.db.recordPasskeyUse = async (input) => {
      stored.sign_count = 2;
      return record(input);
    };
    expect((await post("/auth/passkey/sign-in", { credential: lower })).status).toBe(401);
    expect(stored.sign_count).toBe(2);
  });

  it("signs in once with one response, however many requests carry it at once", async () => {
    await boWithPasskey();
    const credential = soft.get(await requestOptions());
    const answers = await Promise.all([1, 2, 3].map(() => post("/auth/passkey/sign-in", { credential })));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    expect((await post("/auth/passkey/sign-in", { credential })).status).toBe(401);
  });

  it("gives the challenge back after a response that fails, so the right one still signs in", async () => {
    await boWithPasskey();
    const options = await requestOptions();
    for (const wrong of [{ origin: "http://livs-air.local:8787" }, { rpId: "stuga.test" }, { flags: { uv: false } }, { userHandle: null }]) {
      const res = await post("/auth/passkey/sign-in", { credential: soft.get(options, wrong) });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("passkey_invalid");
    }
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(options) })).status).toBe(200);
  });

  it("refuses a challenge from before a restart, and takes one made after it", async () => {
    await boWithPasskey();
    const before = await requestOptions();
    challenges.restart();
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(before) })).status).toBe(401);
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) })).status).toBe(200);
  });

  it("refuses an unknown passkey, one of another host, and a challenge for another purpose, all alike", async () => {
    const { pair } = await boWithPasskey();
    const stranger = new SoftAuthenticator({ origin: REMOTE_ORIGIN });
    stranger.create(await createOptions(pair));
    const unknown = await post("/auth/passkey/sign-in", { credential: stranger.get(await requestOptions()) });
    expect(unknown.status).toBe(401);
    for (const row of h.mem.passkeys.values()) row.rp_id = "old.stuga.test";
    const elsewhere = await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) });
    expect(elsewhere.status).toBe(401);
    for (const row of h.mem.passkeys.values()) row.rp_id = RP_ID;
    // A creation's challenge never signs in.
    const add = await createOptions(pair);
    const asSignIn = soft.get({ challenge: add.challenge, rpId: RP_ID, allowCredentials: [] } as never);
    expect((await post("/auth/passkey/sign-in", { credential: asSignIn })).status).toBe(401);
    expect(await Promise.all([unknown, elsewhere].map(async (r) => ((await r.json()) as { error: string }).error))).toEqual([
      "passkey_invalid",
      "passkey_invalid",
    ]);
  });

  it("pauses an address that keeps failing, never an account", async () => {
    await boWithPasskey();
    for (let i = 0; i < 30; i++) {
      expect((await post("/auth/passkey/sign-in", { credential: { id: "x" } }, {}, "198.51.100.9")).status).toBe(401);
    }
    const paused = await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) }, {}, "198.51.100.9");
    expect(paused.status).toBe(429);
    expect(((await paused.json()) as { error: string }).error).toBe("sign_in_paused");
    // Bo, from his own address, signs in still.
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) })).status).toBe(200);
  });

  it("ends with the passkey: a session it made is refused once it is removed", async () => {
    const { id } = await boWithPasskey();
    const res = await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) });
    const pair = (await res.json()) as TokenPair;
    expect((await post("/auth/confirm", { password: PASSWORD }, bearer(pair))).status).toBe(204);
    expect(h.mem.removePasskey(id)).toHaveLength(1);
    expect((await post("/auth/confirm", { password: PASSWORD }, bearer(pair))).status).toBe(401);
  });
});

describe("confirming a session with a passkey", () => {
  it("moves only the session's confirmation, from the person's own passkey and session", async () => {
    const { pair } = await boWithPasskey();
    h.age(6);
    const options = await requestOptions("reauth", pair);
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([...h.mem.passkeys.keys()]);
    const before = [...h.mem.sessions.values()].filter((r) => !r.revoked_at).map((r) => r.absolute_expires_at);
    const res = await post("/auth/passkey/sign-in", { credential: soft.get(options) }, bearer(pair));
    expect(res.status).toBe(204);
    // No new session, and when the session ends is unchanged.
    expect([...h.mem.sessions.values()].filter((r) => !r.revoked_at).map((r) => r.absolute_expires_at)).toEqual(before);
    // Confirmed: a passkey can be added now without asking again.
    expect((await post("/auth/passkey/options", { purpose: "add" }, bearer(pair))).status).toBe(200);
  });

  it("refuses another session's challenge, someone else's passkey, and no session at all", async () => {
    const { pair } = await boWithPasskey();
    const other = await h.signIn("remote", "bo", PASSWORD);
    const options = await requestOptions("reauth", pair);
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(options) }, bearer(other.pair))).status).toBe(401);
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(options) })).status).toBe(401);

    // Liv's passkey cannot confirm Bo's session.
    const liv = await h.signIn("remote", "liv", PASSWORD);
    const livKey = new SoftAuthenticator({ origin: REMOTE_ORIGIN });
    expect((await post("/auth/passkey/add", { credential: livKey.create(await createOptions(liv.pair)) }, bearer(liv.pair))).status).toBe(201);
    const bos = await requestOptions("reauth", pair);
    const signedByLiv = livKey.get({ ...bos, allowCredentials: [] });
    expect((await post("/auth/passkey/sign-in", { credential: signedByLiv }, bearer(pair))).status).toBe(401);
  });

  it("is not offered to someone with no passkey here", async () => {
    const { pair } = await h.signIn("remote", "bo", PASSWORD);
    const res = await post("/auth/passkey/options", { purpose: "reauth" }, bearer(pair));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_passkey");
  });
});

describe("Sign in faster next time", () => {
  it("is offered once a password signs in at the remote address, never on the node's own network", async () => {
    const remote = await h.signIn("remote", "bo", PASSWORD);
    expect((remote.pair as TokenPair & { passkey_offer?: boolean }).passkey_offer).toBe(true);
    const lan = await h.signIn("lan", "bo", PASSWORD);
    expect("passkey_offer" in lan.pair).toBe(false);
  });

  it("is not offered to someone who said Not now, or who has a passkey here", async () => {
    h.mem.offerDismissed.add("u_bo");
    expect("passkey_offer" in (await h.signIn("remote", "bo", PASSWORD)).pair).toBe(false);
    h.mem.offerDismissed.clear();
    await boWithPasskey();
    expect("passkey_offer" in (await h.signIn("remote", "bo", PASSWORD)).pair).toBe(false);
  });
});

describe("Revoke everything", () => {
  it("removes every passkey, and with it the sessions they made", async () => {
    const { pair } = await boWithPasskey();
    await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) });
    const res = await post("/auth/revoke-everything", { new_password: "battery staple horse 9" }, bearer(pair));
    expect(res.status).toBe(200);
    expect(h.mem.passkeys.size).toBe(0);
    expect([...h.mem.sessions.values()].some((r) => r.signed_in_with === "passkey")).toBe(false);
    expect((await post("/auth/passkey/sign-in", { credential: soft.get(await requestOptions()) })).status).toBe(401);
  });
});
