/**
 * checkPassword (./check-password.ts) through the routes that check a password: the order of its
 * refusals, what each costs, and that every route that checks a password goes through it.
 */
import { scrypt } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHashQueue,
  createVerifier,
  hashPassword,
  loadOrCreateSigningKey,
  needsRehash,
  type AuthConfig,
  type HashLane,
  type HashQueue,
  type LocalKeys,
} from "@stuga/auth";

const scored = vi.hoisted(() => [] as Array<{ password: string; inputs: readonly string[] }>);
/** The hashes each password was verified against, in order. */
const verified = vi.hoisted(() => [] as string[]);
vi.mock("@stuga/auth", async (orig) => {
  const real = await orig<typeof import("@stuga/auth")>();
  return {
    ...real,
    verifyPassword: (password: string, hash: string) => {
      verified.push(hash);
      return real.verifyPassword(password, hash);
    },
  };
});
vi.mock("@stuga/password-strength", async (orig) => {
  const real = await orig<typeof import("@stuga/password-strength")>();
  return {
    ...real,
    remotePasswordOk: (password: string, inputs: readonly string[]) => {
      scored.push({ password, inputs });
      return real.remotePasswordOk(password, inputs);
    },
  };
});

const { strengthInputs } = await import("@stuga/password-strength");
const { ARRIVAL_HEADER, PEER_ADDRESS_HEADER } = await import("../platform/http-server.js");
const { createIdentityRouter } = await import("./routes.js");
const { createSignInLimits } = await import("./sign-in-limits.js");
const { REMOTE_PASSWORD_WEAK, hashLane } = await import("./check-password.js");
const { memoryDb } = await import("./testing/memory-db.js");
import type { IdentityDeps, TokenPair } from "./routes.js";
import type { SignInLimits } from "./sign-in-limits.js";

const ORIGIN = "http://livs-air.local:8787";
const REMOTE = "https://k7f3q2.stuga.test";
const STRONG = "trumpet walnut ceiling";
const SHORT = "correct horse";

const dir = mkdtempSync(join(tmpdir(), "stuga-check-password-"));
let keys: LocalKeys;
let strongHash: string;
let shortHash: string;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(async () => {
  keys = await loadOrCreateSigningKey(join(dir, "signing.jwk"));
  [strongHash, shortHash] = await Promise.all([hashPassword(STRONG), hashPassword(SHORT)]);
});

const auth: AuthConfig = {
  issuer: ORIGIN,
  audience: "stuga",
  keyFile: join(dir, "signing.jwk"),
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 3600,
  refreshRotationGraceSeconds: 0,
};

let mem: ReturnType<typeof memoryDb>;
let hashes: HashLane[];
let queue: HashQueue;
beforeEach(() => {
  mem = memoryDb();
  hashes = [];
  scored.length = 0;
  verified.length = 0;
  const real = createHashQueue();
  queue = { ...real, run: (lane, work) => (hashes.push(lane), real.run(lane, work)) };
});

function router(extra: Partial<IdentityDeps> = {}) {
  return createIdentityRouter({
    auth,
    publicOrigin: ORIGIN,
    db: mem.db,
    keys,
    verifier: createVerifier(auth, keys),
    setupCode: () => null,
    nodeName: () => "North Office",
    hashQueue: queue,
    ...extra,
  });
}

async function account(username: string, passwordHash: string | null = strongHash) {
  const made = await mem.db.createLocalAccount({
    alias: `u_${username}`,
    username,
    passwordHash: passwordHash ?? "unused",
    displayName: username,
    mayClaim: true,
    inviteHash: (await mem.db.countAccounts()) > 0 ? "invite" : null,
  });
  if (!made.ok) throw new Error(made.reason);
  if (passwordHash === null) mem.accounts.get(`u_${username}`)!.password_hash = null;
  return made.account;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function remotePost(path: string, body: unknown, headers: Record<string, string> = {}, peer = "203.0.113.7") {
  return new Request(REMOTE + path, {
    method: "POST",
    headers: { "content-type": "application/json", [ARRIVAL_HEADER]: "remote", [PEER_ADDRESS_HEADER]: peer, ...headers },
    body: JSON.stringify(body),
  });
}

const login = (password: string, username = "ada") => remotePost("/auth/login", { username, password });

beforeEach(async () => {
  mem.invites.set("invite", { tokenHash: "invite", usesLeft: 100 });
});

describe("the remote rule", () => {
  it("answers a short password the same whether it is right, wrong, or for no account, without hashing", async () => {
    await account("ada", shortHash);
    const r = router();
    const answers = [];
    for (const [username, password] of [
      ["ada", SHORT],
      ["ada", "wrong horse!"],
      ["nobody", SHORT],
    ] as const) {
      const res = await r.handle(login(password, username));
      answers.push({ status: res.status, body: await res.json() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 401, body: { error: "remote_password_weak", message: REMOTE_PASSWORD_WEAK } });
    expect(hashes).toEqual([]);
    // Too short to score: zxcvbn was never asked.
    expect(scored).toEqual([]);
  });

  it("refuses long but guessable passwords unhashed, and takes a passphrase", async () => {
    await account("ada");
    const r = router();
    for (const weak of ["password1234567", "qwertyuiopasdfgh", "aaaaaaaaaaaaaaaa"]) {
      expect((await (await r.handle(login(weak))).json()).error, weak).toBe("remote_password_weak");
    }
    expect(hashes).toEqual([]);
    expect((await r.handle(login(STRONG))).status).toBe(200);
  });

  it("is the remote address's alone: the same short password signs in on the LAN", async () => {
    await account("ada", shortHash);
    expect((await router().handle(post("/auth/login", { username: "ada", password: SHORT }))).status).toBe(200);
  });

  it("scores with what a guesser knows: the name typed, the node's name and the address's first label", async () => {
    const r = router();
    await r.handle(login("some long passphrase here", "Typed.Name"));
    expect(scored).toEqual([
      { password: "some long passphrase here", inputs: strengthInputs({ username: "typed.name", nodeName: "North Office", hostLabel: "k7f3q2" }) },
    ]);
  });

  it("counts a refused password against the source, never the account", async () => {
    await account("ada");
    const limits = createSignInLimits();
    const r = router({ signInLimits: limits });
    for (let i = 0; i < 10; i++) await r.handle(login("short one"));
    // The account is not paused: another address signs in.
    expect((await r.handle(remotePost("/auth/login", { username: "ada", password: STRONG }, {}, "198.51.100.1"))).status).toBe(200);
    for (let i = 0; i < 20; i++) await r.handle(login("short one"));
    expect((await r.handle(login(STRONG))).status).toBe(429);
  });

  it("answers busy, without scoring, when a second's scoring budget is spent; short passwords take none of it", async () => {
    const limits = createSignInLimits();
    const take = vi.spyOn(limits, "takeStrengthCheck").mockReturnValue(false);
    const r = router({ signInLimits: limits });
    expect((await (await r.handle(login("short"))).json()).error).toBe("remote_password_weak");
    expect(take).not.toHaveBeenCalled();
    const res = await r.handle(login(STRONG));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(scored).toEqual([]);
    expect(hashes).toEqual([]);
  });
});

describe("the order of refusals", () => {
  it("refuses over plain http from outside the network before anything else", async () => {
    await account("ada");
    const res = await router().handle(post("/auth/login", { username: "ada", password: STRONG }, { [PEER_ADDRESS_HEADER]: "203.0.113.7" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("password_off_network");
    expect(hashes).toEqual([]);
  });

  it("refuses a new password from outside the network too, at setup and a reset link", async () => {
    const away = { [PEER_ADDRESS_HEADER]: "203.0.113.7" };
    const r = router({ setupCode: () => "ABCDE12345" });
    const claim = await r.handle(post("/auth/register", { username: "ada", password: STRONG, setup_code: "ABCDE12345" }, away));
    expect((await claim.json()).error).toBe("password_off_network");
    const reset = await r.handle(post("/auth/reset", { token: "t", new_password: STRONG }, away));
    expect((await reset.json()).error).toBe("password_off_network");
    expect(hashes).toEqual([]);
    expect(await mem.db.countAccounts()).toBe(0);
  });

  it("refuses a paused account before scoring or hashing, with when to come back", async () => {
    await account("ada");
    const r = router();
    for (let i = 0; i < 5; i++) expect((await r.handle(post("/auth/login", { username: "ada", password: "wrong pw" }))).status).toBe(401);
    hashes.length = 0;
    const res = await r.handle(post("/auth/login", { username: "ada", password: STRONG }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toMatchObject({ error: "sign_in_paused", retry_after: 60 });
    expect(hashes).toEqual([]);
    // The remote address's count is its own.
    expect((await r.handle(login(STRONG))).status).toBe(200);
  });

  it("tells the person once their account reaches the hour-long pause", async () => {
    await account("ada");
    let t = Date.now();
    const paused: Array<Record<string, unknown>> = [];
    const r = router({
      signInLimits: createSignInLimits({ now: () => t }),
      alerts: { signInsPaused: async (i: Record<string, unknown>) => void paused.push(i) } as unknown as IdentityDeps["alerts"],
    });
    for (const minutes of [1, 5, 15, 60]) {
      for (let i = 0; i < 5; i++) await r.handle(login(`wrong but long enough ${i}`));
      expect(paused).toHaveLength(minutes === 60 ? 1 : 0);
      t += minutes * 60_000;
    }
    expect(paused[0]).toEqual({ alias: "u_ada", username: "ada", arrival: "remote", remoteHost: "k7f3q2.stuga.test" });
    // Twenty wrong passwords, each hashed at the full cost.
  }, 60_000);

  it("refuses a stranger at the remote address once the minute's wrong passwords are spent, before hashing", async () => {
    await account("ada");
    const limits: SignInLimits = { ...createSignInLimits(), remoteBudgetSpent: () => true };
    const r = router({ signInLimits: limits });
    const res = await r.handle(login(STRONG));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("busy");
    expect(hashes).toEqual([]);
    // Not the LAN.
    expect((await r.handle(post("/auth/login", { username: "ada", password: STRONG }))).status).toBe(200);
  });

  it("answers busy when the hash queue is full", async () => {
    await account("ada");
    const full: HashQueue = { run: async () => Promise.reject(new (await import("@stuga/auth")).HashBusy()), stats: queue.stats };
    const res = await router({ hashQueue: full }).handle(post("/auth/login", { username: "ada", password: STRONG }));
    expect(res.status).toBe(503);
  });

  it("hashes a stranger's check at the remote address in their own line, the LAN's and the signed-in's in the priority one", () => {
    const at = (arrival: string) => new Request(REMOTE, { headers: { [ARRIVAL_HEADER]: arrival } });
    expect(hashLane(at("remote"), false)).toBe("anonymous");
    expect(hashLane(at("remote"), true)).toBe("priority");
    expect(hashLane(at("local"), false)).toBe("priority");
  });
});

describe("a hash made at an older cost", () => {
  it("is hashed again at the current cost on a sign-in that works, and left alone on one that does not", async () => {
    const salt = Buffer.from("0123456789abcdef");
    const key = await new Promise<Buffer>((res, rej) => scrypt(SHORT, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
    const old = ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
    await account("ada", old);
    const r = router();
    expect((await r.handle(post("/auth/login", { username: "ada", password: "wrong pw" }))).status).toBe(401);
    expect(mem.accounts.get("u_ada")!.password_hash).toBe(old);
    expect((await r.handle(post("/auth/login", { username: "ada", password: SHORT }))).status).toBe(200);
    const now = mem.accounts.get("u_ada")!.password_hash!;
    expect(now).toMatch(/^scrypt\$65536\$8\$2\$/);
    expect(needsRehash(now)).toBe(false);
    expect((await r.handle(post("/auth/login", { username: "ada", password: SHORT }))).status).toBe(200);
  });
});

describe("every route that checks a password", () => {
  it("goes through checkPassword: no other file hashes or verifies one", () => {
    const src = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const path = join(d, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          const text = readFileSync(path, "utf8");
          if (/\b(verifyPassword|hashPassword)\b/.test(text)) offenders.push(path.slice(src.length + 1));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual(["identity/check-password.ts"]);
  });

  it("counts wrong passwords from a password change and a provider link like a sign-in's", async () => {
    await account("ada");
    const r = router();
    for (let i = 0; i < 4; i++) {
      expect((await r.handle(post("/auth/password", { username: "ada", current_password: "wrong pw", new_password: "battery staple 9" }))).status).toBe(401);
    }
    // The fifth wrong one, from the provider's first-visit link, pauses the account.
    const { sha256Hex } = await import("@stuga/auth");
    const { bindingHash } = await import("./http.js");
    await mem.db.createOidcTicket({
      ticketHash: sha256Hex("t1"),
      kind: "first_visit",
      bindingHash: bindingHash("browser-1", false),
      sub: "sub-1",
      issuer: "https://idp.test",
      returnTo: "/",
      expiresAt: new Date(Date.now() + 60_000),
    } as Parameters<typeof mem.db.createOidcTicket>[0]);
    const linked = await r.handle(
      post("/auth/oidc/link", { ticket: "t1", username: "ada", password: "wrong pw" }, { cookie: "stuga_signin=browser-1" }),
    );
    expect(linked.status).toBe(401);
    expect((await r.handle(post("/auth/login", { username: "ada", password: STRONG }))).status).toBe(429);
  });
});

describe("POST /auth/password at the remote address", () => {
  async function remoteSession(r: ReturnType<typeof router>, username = "ada", password = STRONG): Promise<TokenPair> {
    const res = await r.handle(remotePost("/auth/login", { username, password }));
    expect(res.status).toBe(200);
    return (await res.json()) as TokenPair;
  }
  const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });
  const age = (minutes: number) => {
    for (const row of mem.sessions.values()) row.confirmed_at = new Date(Date.now() - minutes * 60_000).toISOString();
  };

  it("needs a session there: a username and the current password alone are not enough", async () => {
    await account("ada");
    const res = await router().handle(remotePost("/auth/password", { username: "ada", current_password: STRONG, new_password: "battery staple 9" }));
    expect(res.status).toBe(401);
  });

  it("changes only the signed-in account's", async () => {
    await account("ada");
    await account("bo");
    const r = router();
    const pair = await remoteSession(r);
    const res = await r.handle(remotePost("/auth/password", { username: "bo", current_password: STRONG, new_password: "battery staple 9" }, bearer(pair)));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("wrong_account");
    expect(hashes.filter((l) => l === "priority")).toEqual([]);
  });

  it("with the current password: changed, every session ended, a new one for this browser", async () => {
    await account("ada");
    const r = router();
    const pair = await remoteSession(r);
    hashes.length = 0;
    const wrong = await r.handle(remotePost("/auth/password", { current_password: "wrong but long enough pw", new_password: "battery staple 9" }, bearer(pair)));
    expect(wrong.status).toBe(401);
    const res = await r.handle(remotePost("/auth/password", { username: "ada", current_password: STRONG, new_password: "new walnut ceiling" }, bearer(pair)));
    expect(res.status).toBe(200);
    const next = (await res.json()) as TokenPair;
    expect(next.access_token).toBeTruthy();
    // Checked and hashed in the priority line: a flood of strangers cannot hold it up.
    expect(hashes.every((l) => l === "priority")).toBe(true);
    const rows = [...mem.sessions.values()];
    expect(rows.filter((row) => !row.revoked_at)).toHaveLength(1);
    expect(rows.find((row) => !row.revoked_at)).toMatchObject({ arrival: "remote", signed_in_with: "password" });
    expect((await r.handle(login("new walnut ceiling"))).status).toBe(200);
  });

  it("the current password must meet the remote rule like any sign-in there", async () => {
    await account("ada");
    const r = router();
    const pair = await remoteSession(r);
    const res = await r.handle(remotePost("/auth/password", { current_password: SHORT, new_password: "battery staple 9" }, bearer(pair)));
    expect((await res.json()).error).toBe("remote_password_weak");
  });

  it("without it, from a sign-in confirmed in the last five minutes; otherwise asks for a confirmation", async () => {
    await account("ada");
    const r = router();
    const pair = await remoteSession(r);
    age(6);
    const stale = await r.handle(remotePost("/auth/password", { new_password: "battery staple 9" }, bearer(pair)));
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "reauth_required", message: "confirm it's you", methods: ["password"] });
    age(1);
    const fresh = await r.handle(remotePost("/auth/password", { new_password: "battery staple 9" }, bearer(pair)));
    expect(fresh.status).toBe(200);
  });

  it("sets a first password for an account that has none, from a recent sign-in", async () => {
    await account("ada");
    const r = router();
    const pair = await remoteSession(r);
    mem.accounts.get("u_ada")!.password_hash = null;
    age(6);
    expect((await r.handle(remotePost("/auth/password", { new_password: "battery staple 9" }, bearer(pair)))).status).toBe(401);
    age(0);
    expect((await r.handle(remotePost("/auth/password", { new_password: "battery staple 9" }, bearer(pair)))).status).toBe(204);
    expect(mem.accounts.get("u_ada")!.password_hash).toMatch(/^scrypt\$/);
  });

  it("keeps the LAN's two ways as they were", async () => {
    await account("ada", shortHash);
    const r = router();
    const res = await r.handle(post("/auth/password", { username: "ada", current_password: SHORT, new_password: "battery staple 9" }));
    expect(res.status).toBe(200);
  });
});

describe("checks that run while something else happens", () => {
  const oldHash = async (password: string) => {
    const salt = Buffer.from("0123456789abcdef");
    const key = await new Promise<Buffer>((res, rej) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
    return ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
  };

  it("lets a browser the account signed in from before through while the minute's remote budget is spent", async () => {
    await account("ada");
    const first = await router().handle(login(STRONG));
    expect(first.status).toBe(200);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const spent: SignInLimits = { ...createSignInLimits(), remoteBudgetSpent: () => true };
    const r = router({ signInLimits: spent });
    expect((await r.handle(remotePost("/auth/login", { username: "ada", password: STRONG }, { cookie }))).status).toBe(200);
    // A browser it never signed in from waits out the minute.
    expect((await r.handle(login(STRONG))).status).toBe(503);
  });

  it("checks a wrong guess against an older-cost hash and the decoy, so it costs what no account costs", async () => {
    const legacy = await oldHash(SHORT);
    await account("ada", legacy);
    const r = router();
    expect((await r.handle(post("/auth/login", { username: "ada", password: "wrong pw" }))).status).toBe(401);
    expect(verified[0]).toBe(legacy);
    expect(verified[1]).toMatch(/^scrypt\$65536\$8\$2\$/);
    verified.length = 0;
    expect((await r.handle(post("/auth/login", { username: "nobody", password: "wrong pw" }))).status).toBe(401);
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatch(/^scrypt\$65536\$8\$2\$/);
    // A hash at the current cost needs no evening out.
    await account("bo");
    verified.length = 0;
    await r.handle(post("/auth/login", { username: "bo", password: "wrong pw" }));
    expect(verified).toEqual([strongHash]);
  });

  it("refuses concurrent wrong guesses once the pause they reach begins, not after every one is hashed", async () => {
    await account("ada");
    const r = router();
    const answers = await Promise.all(
      Array.from({ length: 16 }, (_, i) => r.handle(post("/auth/login", { username: "ada", password: `wrong pw ${i}` })).then((res) => res.status)),
    );
    const hashed = answers.filter((s) => s === 401).length;
    // Five reach the pause; one more may already be hashing beside the fifth.
    expect(hashed).toBeGreaterThanOrEqual(5);
    expect(hashed).toBeLessThanOrEqual(6);
    expect(answers.filter((s) => s === 429)).toHaveLength(16 - hashed);
  }, 60_000);

  it("counts every way of typing a name as one account", async () => {
    await account("ada");
    const r = router();
    for (const typed of ["ada", "@ada", " ADA", "@Ada", "ada"]) {
      expect((await r.handle(post("/auth/login", { username: typed, password: "wrong pw" }))).status).toBe(401);
    }
    expect((await r.handle(post("/auth/login", { username: "ada", password: STRONG }))).status).toBe(429);
  });

  it("refuses a sign-in whose password was replaced while it was being checked", async () => {
    await account("ada");
    const real = createHashQueue();
    let after: (() => void) | null = null;
    const r = router({
      hashQueue: { ...real, run: async (lane, work) => { const out = await real.run(lane, work); after?.(); after = null; return out; } },
    });
    // A recovery lands between the check and the session.
    after = () => void (mem.accounts.get("u_ada")!.password_hash = "replaced by an administrator");
    const res = await r.handle(post("/auth/login", { username: "ada", password: STRONG }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
    expect([...mem.sessions.values()]).toEqual([]);
  });

  it("refuses your own Revoke everything when an administrator's lands while your new password is hashed", async () => {
    await account("ada");
    const real = createHashQueue();
    let after: (() => Promise<void>) | null = null;
    const r = router({
      hashQueue: { ...real, run: async (lane, work) => { const out = await real.run(lane, work); const hook = after; after = null; await hook?.(); return out; } },
    });
    const pair = (await (await r.handle(remotePost("/auth/login", { username: "ada", password: STRONG }))).json()) as TokenPair;
    after = async () => void (await mem.db.revokeEverything({ alias: "u_ada", by: "u_admin", passwordHash: null }));
    const res = await r.handle(remotePost("/auth/revoke-everything", { new_password: "the attacker's own choice" }, { authorization: `Bearer ${pair.access_token}` }));
    expect(res.status).toBe(401);
    expect(mem.accounts.get("u_ada")!.password_hash).toBeNull();
    expect([...mem.sessions.values()].filter((row) => !row.revoked_at)).toEqual([]);
  });

  it("refuses a password change from a confirmed sign-in that ended while the new one was hashed", async () => {
    await account("ada");
    const real = createHashQueue();
    let after: (() => Promise<void>) | null = null;
    const r = router({
      hashQueue: { ...real, run: async (lane, work) => { const out = await real.run(lane, work); const hook = after; after = null; await hook?.(); return out; } },
    });
    const pair = (await (await r.handle(remotePost("/auth/login", { username: "ada", password: STRONG }))).json()) as TokenPair;
    after = async () => void (await mem.db.revokeRefreshSessions("u_ada"));
    const res = await r.handle(remotePost("/auth/password", { new_password: "the attacker's own choice" }, { authorization: `Bearer ${pair.access_token}` }));
    expect(res.status).toBe(401);
    expect(mem.accounts.get("u_ada")!.password_hash).toBe(strongHash);
  });

  it("looks a reset link up before hashing, and refuses a stranger's once the remote budget is spent", async () => {
    await account("ada");
    const r = router();
    const res = await r.handle(remotePost("/auth/reset", { token: "made-up", new_password: STRONG }));
    expect((await res.json()).error).toBe("reset_invalid");
    expect(hashes).toEqual([]);
    const spent = router({ signInLimits: { ...createSignInLimits(), remoteBudgetSpent: () => true } });
    expect((await spent.handle(remotePost("/auth/reset", { token: "made-up", new_password: STRONG }))).status).toBe(503);
    const { sha256Hex } = await import("@stuga/auth");
    mem.invites.set(sha256Hex("join-me"), { tokenHash: sha256Hex("join-me"), usesLeft: 1 });
    expect((await spent.handle(remotePost("/auth/register", { username: "liv", password: STRONG, invite: "join-me" }))).status).toBe(503);
    expect(hashes).toEqual([]);
  });

  it("throttles a signed-in person's password checks per account, whatever address they come from", async () => {
    await account("ada");
    const keys: string[] = [];
    const r = router({ limiter: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: !key.startsWith("auth:account:") }) } as unknown as IdentityDeps["limiter"] });
    const pair = (await (await r.handle(remotePost("/auth/login", { username: "ada", password: STRONG }))).json()) as TokenPair;
    hashes.length = 0;
    const res = await r.handle(remotePost("/auth/confirm", { password: STRONG }, { authorization: `Bearer ${pair.access_token}` }, "2001:db8:1::1"));
    expect(res.status).toBe(429);
    expect(keys).toContain("auth:account:remote:u_ada");
    expect(hashes).toEqual([]);
  });
});
