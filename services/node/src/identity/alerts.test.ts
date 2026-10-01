/** What the node tells people about their own sign-ins (./alerts.ts), and whom. */
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_EVENT_PREFIX } from "@stuga/db";
import {
  ACCOUNT_API_KEY_CREATED,
  ACCOUNT_EVERYTHING_REVOKED,
  ACCOUNT_NEW_SIGN_IN,
  ACCOUNT_PASSWORD_CHANGED,
  ACCOUNT_SIGN_INS_PAUSED,
  createSecurityAlerts,
} from "./alerts.js";

type Row = { id: string; recipient_alias: string; event_type: string; resource_title: string; resource_url: string; workspace_id: null };

function setup(admins = ["u_liv", "u_max"], sink = true) {
  const rows: Row[] = [];
  const deliveries: unknown[] = [];
  const ids = new Set<string>();
  const db = {
    listNodeAdmins: vi.fn(async () => admins.map((alias) => ({ alias }))),
    insertNotification: vi.fn(async (row: Row, delivery: unknown) => {
      if (ids.has(row.id)) return false;
      ids.add(row.id);
      rows.push(row);
      if (delivery) deliveries.push(delivery);
      return true;
    }),
  };
  const alerts = createSecurityAlerts({
    db: db as never,
    sinkConfigured: () => sink,
    publicOrigin: "http://livs-air.local:8787",
  });
  return { alerts, rows, deliveries };
}

const at = new Date(Date.UTC(2026, 8, 30, 14, 2));
const bo = { alias: "u_bo", username: "bo", name: "Bo" };

describe("a sign-in from a new device", () => {
  it("tells the person, and each administrator at most once an hour per person", async () => {
    const { alerts, rows, deliveries } = setup();
    const input = { ...bo, device: "Safari on iPhone", at, remoteHost: "k7f3q2.mystuga.com", from: "203.0.113.7", deviceHash: "a".repeat(64) };
    await alerts.newDevice(input);
    await alerts.newDevice({ ...input, deviceHash: "b".repeat(64), at: new Date(at.getTime() + 60_000) });
    expect(rows.map((r) => [r.recipient_alias, r.event_type])).toEqual([
      ["u_bo", ACCOUNT_NEW_SIGN_IN],
      ["u_liv", "MEMBER_NEW_SIGN_IN"],
      ["u_max", "MEMBER_NEW_SIGN_IN"],
      // A second new device within the hour: the person again, the administrators not.
      ["u_bo", ACCOUNT_NEW_SIGN_IN],
    ]);
    expect(rows[0]).toMatchObject({
      workspace_id: null,
      resource_title: "New sign-in at k7f3q2.mystuga.com: Safari on iPhone",
      resource_url: "http://livs-air.local:8787/settings/profile?revoke=1",
    });
    expect(rows[1]).toMatchObject({
      resource_title: "Bo signed in at k7f3q2.mystuga.com: Safari on iPhone",
      resource_url: "http://livs-air.local:8787/settings/node/access?revoke=bo",
    });
    expect(deliveries[0]).toMatchObject({
      kind: "notify_deliver",
      recipient: "u_bo",
      body: "New sign-in at k7f3q2.mystuga.com: Safari on iPhone · 2026-09-30 14:02 UTC · from 203.0.113.7. Not you? Revoke everything.",
    });
  });

  it("an administrator who is the person gets the person's own row only", async () => {
    const { alerts, rows } = setup(["u_bo", "u_liv"]);
    await alerts.newDevice({ ...bo, device: "Chrome", at, remoteHost: "k7f3q2.mystuga.com", from: "203.0.113.7", deviceHash: "c".repeat(64) });
    expect(rows.map((r) => r.recipient_alias)).toEqual(["u_bo", "u_liv"]);
  });
});

describe("the other alerts", () => {
  it("a password change reaches the administrators only when it happened at the remote address", async () => {
    const { alerts, rows } = setup();
    await alerts.passwordChanged({ ...bo, device: "Safari on Mac", at, how: "changed", remoteHost: null });
    expect(rows.map((r) => r.recipient_alias)).toEqual(["u_bo"]);
    await alerts.passwordChanged({ ...bo, device: "Safari on Mac", at, how: "reset", remoteHost: "k7f3q2.mystuga.com" });
    expect(rows.slice(1).map((r) => [r.recipient_alias, r.resource_title])).toEqual([
      ["u_bo", "Your password was reset"],
      ["u_liv", "Bo's password was reset at k7f3q2.mystuga.com"],
      ["u_max", "Bo's password was reset at k7f3q2.mystuga.com"],
    ]);
  });

  it("tells the person how to act on a password change that was not theirs: an administrator, or reset-password when they are the only one", async () => {
    const withOthers = setup();
    await withOthers.alerts.passwordChanged({ ...bo, device: "Safari on Mac", at, how: "changed", remoteHost: null });
    expect(withOthers.deliveries[0]).toMatchObject({
      body: "Your password was changed on Safari on Mac · 2026-09-30 14:02 UTC. Not you? Ask an administrator to revoke everything for you.",
    });
    const alone = setup(["u_bo"]);
    await alone.alerts.passwordChanged({ ...bo, device: "Safari on Mac", at, how: "changed", remoteHost: null });
    expect(alone.deliveries[0]).toMatchObject({
      body: "Your password was changed on Safari on Mac · 2026-09-30 14:02 UTC. Not you? Run reset-password on the node's machine to get back in, then revoke everything.",
    });
  });

  it("revoking everything reaches the person and every administrator but the one who did it", async () => {
    const { alerts, rows } = setup();
    await alerts.revokedEverything({ ...bo, device: "Edge on Windows", at, by: { alias: "u_liv", name: "Liv" } });
    expect(rows.map((r) => [r.recipient_alias, r.resource_title])).toEqual([
      ["u_bo", "Liv revoked everything for you"],
      ["u_max", "Liv revoked everything for Bo"],
    ]);
    expect(rows[0]!.event_type).toBe(ACCOUNT_EVERYTHING_REVOKED);
  });

  it("an API key and an hour-long pause reach the person alone, the pause once a day", async () => {
    const { alerts, rows, deliveries } = setup(["u_liv"], false);
    await alerts.apiKeyCreated({ alias: "u_bo", keyId: "k1", keyName: "Scout" });
    await alerts.signInsPaused({ alias: "u_bo", username: "bo", arrival: "remote", remoteHost: "k7f3q2.mystuga.com" });
    await alerts.signInsPaused({ alias: "u_bo", username: "bo", arrival: "remote", remoteHost: "k7f3q2.mystuga.com" });
    expect(rows.map((r) => [r.recipient_alias, r.event_type, r.resource_title])).toEqual([
      ["u_bo", ACCOUNT_API_KEY_CREATED, "API key created: Scout"],
      ["u_bo", ACCOUNT_SIGN_INS_PAUSED, "Many wrong passwords for @bo at k7f3q2.mystuga.com"],
    ]);
    // No sink set up: in the app only.
    expect(deliveries).toEqual([]);
  });

  it("are the person's own rows, which reach them whether or not they administer the node", () => {
    for (const type of [ACCOUNT_NEW_SIGN_IN, ACCOUNT_PASSWORD_CHANGED, ACCOUNT_EVERYTHING_REVOKED, ACCOUNT_API_KEY_CREATED, ACCOUNT_SIGN_INS_PAUSED]) {
      expect(type.startsWith(ACCOUNT_EVENT_PREFIX)).toBe(true);
    }
  });

  it("never fail what caused them", async () => {
    const onError = vi.fn();
    const alerts = createSecurityAlerts({
      db: { listNodeAdmins: async () => [], insertNotification: async () => Promise.reject(new Error("down")) } as never,
      sinkConfigured: () => false,
      publicOrigin: "http://x.test",
      onError,
    });
    await expect(alerts.apiKeyCreated({ alias: "u_bo", keyId: "k1", keyName: "Scout" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
