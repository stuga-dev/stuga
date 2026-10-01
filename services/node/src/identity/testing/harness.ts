/**
 * The identity routes over the in-memory database, for the route tests: a signing key in a temporary
 * directory, every alert and audit row recorded, and requests as either listener sends them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier, loadOrCreateSigningKey, type AuthConfig, type LocalKeys } from "@stuga/auth";
import { ARRIVAL_HEADER, PEER_ADDRESS_HEADER } from "../../platform/http-server.js";
import type { SecurityAlerts } from "../alerts.js";
import { createIdentityRouter, type IdentityDeps, type IdentityEvent, type IdentityRouter, type TokenPair } from "../routes.js";
import { memoryDb } from "./memory-db.js";

export const LAN_ORIGIN = "http://livs-air.local:8787";
export const REMOTE_ORIGIN = "https://k7f3q2.stuga.test";
export const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

export type AlertCall = { kind: keyof SecurityAlerts; input: Record<string, unknown> };

export interface Harness {
  router: IdentityRouter;
  mem: ReturnType<typeof memoryDb>;
  alerts: AlertCall[];
  events: IdentityEvent[];
  ended: string[];
  /** Make an account with a password hash, or none; the first one administers the node. */
  account(username: string, passwordHash: string | null): Promise<string>;
  /** A request at the node's own network, from a private address. */
  lan(path: string, body: unknown, headers?: Record<string, string>): Request;
  /** A request at the remote address, from a public one. */
  remote(path: string, body: unknown, headers?: Record<string, string>, peer?: string): Request;
  /** Sign in with a password at either listener: the token pair and the cookie this browser now holds. */
  signIn(where: "lan" | "remote", username: string, password: string, cookie?: string | null): Promise<{ pair: TokenPair; cookie: string | null; res: Response }>;
  /** Every live session row's `confirmed_at` set this many minutes ago. */
  age(minutes: number): void;
  close(): void;
}

const auth = (dir: string): AuthConfig => ({
  issuer: LAN_ORIGIN,
  audience: "stuga",
  keyFile: join(dir, "signing.jwk"),
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 3600,
  refreshRotationGraceSeconds: 0,
});

/** The device cookie a response set, as `name=value`, or null. */
export function deviceCookieOf(res: Response): string | null {
  for (const set of res.headers.getSetCookie()) {
    const pair = set.split(";")[0]!;
    if (/^(__Host-stuga-device|stuga-device-local)=/.test(pair)) return pair;
  }
  return null;
}

export async function harness(extra: Partial<IdentityDeps> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "stuga-identity-"));
  const config = auth(dir);
  const keys: LocalKeys = await loadOrCreateSigningKey(config.keyFile);
  const mem = memoryDb();
  mem.invites.set("invite", { tokenHash: "invite", usesLeft: 100 });
  const alerts: AlertCall[] = [];
  const events: IdentityEvent[] = [];
  const ended: string[] = [];
  const record =
    (kind: keyof SecurityAlerts) =>
    async (input: object): Promise<void> =>
      void alerts.push({ kind, input: input as Record<string, unknown> });
  const recorder: SecurityAlerts = {
    newDevice: record("newDevice"),
    passwordChanged: record("passwordChanged"),
    revokedEverything: record("revokedEverything"),
    apiKeyCreated: record("apiKeyCreated"),
    signInsPaused: record("signInsPaused"),
  };
  const router = createIdentityRouter({
    auth: config,
    publicOrigin: LAN_ORIGIN,
    db: mem.db,
    keys,
    verifier: createVerifier(config, keys),
    setupCode: () => "ABCDE12345",
    nodeName: () => "North Office",
    alerts: recorder,
    onIdentityChange: (e) => events.push(e),
    onSessionsEnded: (alias) => ended.push(alias),
    ...extra,
  });

  const request = (origin: string, headers: Record<string, string>) => (path: string, body: unknown, more: Record<string, string> = {}) =>
    new Request(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": SAFARI_IPHONE, ...headers, ...more },
      body: JSON.stringify(body),
    });
  const lan = request(LAN_ORIGIN, { [PEER_ADDRESS_HEADER]: "192.168.1.20" });
  const remoteAt = (peer: string) => request(REMOTE_ORIGIN, { [ARRIVAL_HEADER]: "remote", [PEER_ADDRESS_HEADER]: peer });

  return {
    router,
    mem,
    alerts,
    events,
    ended,
    async account(username, passwordHash) {
      const made = await mem.db.createLocalAccount({
        alias: `u_${username}`,
        username,
        passwordHash: passwordHash ?? "unused",
        displayName: username.charAt(0).toUpperCase() + username.slice(1),
        mayClaim: true,
        inviteHash: (await mem.db.countAccounts()) > 0 ? "invite" : null,
      });
      if (!made.ok) throw new Error(made.reason);
      if (passwordHash === null) mem.accounts.get(`u_${username}`)!.password_hash = null;
      return made.account.alias;
    },
    lan,
    remote: (path, body, headers = {}, peer = "203.0.113.7") => remoteAt(peer)(path, body, headers),
    async signIn(where, username, password, cookie = null) {
      const headers: Record<string, string> = cookie ? { cookie } : {};
      const req = where === "lan" ? lan("/auth/login", { username, password }, headers) : remoteAt("203.0.113.7")("/auth/login", { username, password }, headers);
      const res = await router.handle(req);
      if (res.status !== 200) throw new Error(`sign-in answered ${res.status}: ${await res.text()}`);
      return { pair: (await res.clone().json()) as TokenPair, cookie: deviceCookieOf(res), res };
    },
    age(minutes) {
      for (const row of mem.sessions.values()) {
        if (!row.revoked_at) row.confirmed_at = new Date(Date.now() - minutes * 60_000).toISOString();
      }
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
