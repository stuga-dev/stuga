/** What the node tells people about their own sign-ins (./alerts.ts), and whom. */
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_EVENT_PREFIX } from "@stuga/db";
import { renderChannel, renderNotification } from "@stuga/protocol/notify/render";
import {
  ACCOUNT_API_KEY_CREATED,
  ACCOUNT_EVERYTHING_REVOKED,
  ACCOUNT_NEW_SIGN_IN,
  ACCOUNT_PASSWORD_CHANGED,
  ACCOUNT_SIGN_INS_PAUSED,
  ACCOUNT_APP_CONNECTED,
  ACCOUNT_EMAIL_CHANGED,
  ACCOUNT_PASSKEY_ADDED,
  ACCOUNT_PASSKEY_REMOVED,
  NODE_NOTIFY_CHANNEL_CHANGED,
  changedChannelParams,
  channelParams,
  createSecurityAlerts,
  sameChannel,
} from "./alerts.js";

type Row = {
  id: string;
  recipient_alias: string;
  event_type: string;
  resource_title: string | null;
  resource_url: string;
  workspace_id: null;
  delivery_channel?: string | null;
  payload: Record<string, unknown>;
};

/** What a row or a delivery says, in `language`. */
const text = (n: { event_type?: string; eventType?: string; payload?: unknown; params?: unknown }, language = "en") =>
  renderNotification((n.event_type ?? n.eventType)!, n.payload ?? n.params, language)!;
const title = (n: Row) => text(n).title;
const body = (n: unknown, language = "en") => text(n as Row, language).body;
const channelText = (cfg: Parameters<typeof channelParams>[0]) => renderChannel(channelParams(cfg), "en");
const channelChangedTo = (a: Parameters<typeof channelParams>[0], b: Parameters<typeof channelParams>[0]) => renderChannel(changedChannelParams(a, b), "en");

function setup(admins = ["u_liv", "u_max"], sink: boolean | string = true, deliverThrough?: (cfg: unknown, n: unknown) => Promise<string | null>) {
  const rows: Row[] = [];
  const deliveries: unknown[] = [];
  const recorded: Array<[string, unknown]> = [];
  const ids = new Set<string>();
  const db = {
    recordDelivery: vi.fn(async (id: string, outcome: unknown) => void recorded.push([id, outcome])),
    userEmail: vi.fn(async (alias: string) => `${alias}@example.test`),
    uiLanguage: vi.fn(async (alias: string) => ({ chosen: alias === "u_max" ? "de" : null, detected: null })),
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
    channel: () => ({ sink: typeof sink === "string" ? sink : sink ? "slack" : "none", webhookUrl: "https://hooks.slack.test/services/T" }),
    publicOrigin: "http://livs-air.local:8787",
    ...(deliverThrough ? { deliverThrough: deliverThrough as never } : {}),
  });
  return { alerts, rows, deliveries, recorded };
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
    // Params, never a sentence: each reader's language writes it. It names no resource.
    expect(rows[0]).toMatchObject({
      workspace_id: null,
      resource_title: null,
      resource_url: "http://livs-air.local:8787/settings/profile?revoke=1",
      payload: { host: "k7f3q2.mystuga.com", device: "Safari on iPhone", at: at.toISOString(), from: "203.0.113.7" },
    });
    expect(title(rows[0]!)).toBe("New sign-in at k7f3q2.mystuga.com: Safari on iPhone");
    expect(rows[1]).toMatchObject({ resource_url: "http://livs-air.local:8787/settings/node/access?revoke=bo" });
    expect(title(rows[1]!)).toBe("Bo signed in at k7f3q2.mystuga.com: Safari on iPhone");
    expect(deliveries[0]).toMatchObject({ kind: "notify_deliver", recipient: "u_bo", eventType: ACCOUNT_NEW_SIGN_IN, params: rows[0]!.payload });
    expect(body(deliveries[0])).toBe(
      "New sign-in at k7f3q2.mystuga.com: Safari on iPhone · 2026-09-30 14:02 UTC · from 203.0.113.7. Not you? Revoke everything.",
    );
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
    expect(rows.slice(1).map((r) => [r.recipient_alias, title(r)])).toEqual([
      ["u_bo", "Your password was reset"],
      ["u_liv", "Bo’s password was reset at k7f3q2.mystuga.com"],
      ["u_max", "Bo’s password was reset at k7f3q2.mystuga.com"],
    ]);
  });

  it("tells the person how to act on a password change that was not theirs: an administrator, or reset-password when they are the only one", async () => {
    const withOthers = setup();
    await withOthers.alerts.passwordChanged({ ...bo, device: "Safari on Mac", at, how: "changed", remoteHost: null });
    expect(body(withOthers.deliveries[0])).toBe(
      "Your password was changed on Safari on Mac · 2026-09-30 14:02 UTC. Not you? Ask an administrator to revoke everything for you.",
    );
    const alone = setup(["u_bo"]);
    await alone.alerts.passwordChanged({ ...bo, device: "Safari on Mac", at, how: "changed", remoteHost: null });
    expect(body(alone.deliveries[0])).toBe(
      "Your password was changed on Safari on Mac · 2026-09-30 14:02 UTC. Not you? Run reset-password on the node’s machine to get back in, then revoke everything.",
    );
  });

  it("revoking everything reaches the person and every administrator but the one who did it", async () => {
    const { alerts, rows } = setup();
    await alerts.revokedEverything({ ...bo, device: "Edge on Windows", at, by: { alias: "u_liv", name: "Liv" } });
    expect(rows.map((r) => [r.recipient_alias, title(r)])).toEqual([
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
    expect(rows.map((r) => [r.recipient_alias, r.event_type, title(r)])).toEqual([
      ["u_bo", ACCOUNT_API_KEY_CREATED, "API key created: Scout"],
      ["u_bo", ACCOUNT_SIGN_INS_PAUSED, "Many wrong passwords for @bo at k7f3q2.mystuga.com"],
    ]);
    // No sink set up: in the app only.
    expect(deliveries).toEqual([]);
  });

  it("are the person's own rows, which reach them whether or not they administer the node", () => {
    for (const type of [
      ACCOUNT_NEW_SIGN_IN,
      ACCOUNT_PASSWORD_CHANGED,
      ACCOUNT_EVERYTHING_REVOKED,
      ACCOUNT_API_KEY_CREATED,
      ACCOUNT_SIGN_INS_PAUSED,
      ACCOUNT_PASSKEY_ADDED,
      ACCOUNT_PASSKEY_REMOVED,
      ACCOUNT_APP_CONNECTED,
      ACCOUNT_EMAIL_CHANGED,
    ]) {
      expect(type.startsWith(ACCOUNT_EVENT_PREFIX)).toBe(true);
    }
  });

  it("never fail what caused them", async () => {
    const onError = vi.fn();
    const alerts = createSecurityAlerts({
      db: { listNodeAdmins: async () => [], insertNotification: async () => Promise.reject(new Error("down")) } as never,
      channel: () => ({ sink: "none" }),
      publicOrigin: "http://x.test",
      onError,
    });
    await expect(alerts.apiKeyCreated({ alias: "u_bo", keyId: "k1", keyName: "Scout" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("passkeys, apps and email", () => {
  it("a passkey added or removed, and an app connected at the remote address, reach the person, each its own row", async () => {
    const { alerts, rows, deliveries } = setup();
    const added = { alias: "u_bo", name: "iCloud Keychain", remoteHost: "k7f3q2.mystuga.com", device: "Safari on Mac", at, from: "203.0.113.9" };
    await alerts.passkeyAdded(added);
    await alerts.passkeyAdded(added);
    await alerts.passkeyRemoved({ alias: "u_bo", name: "Security key" });
    await alerts.appConnected({ alias: "u_bo", app: "Claude", appHost: "claude.ai", grantId: "g1", remoteHost: "k7f3q2.mystuga.com" });
    expect(rows.map((r) => [r.recipient_alias, r.event_type, title(r)])).toEqual([
      ["u_bo", ACCOUNT_PASSKEY_ADDED, "Passkey added at k7f3q2.mystuga.com: iCloud Keychain"],
      ["u_bo", ACCOUNT_PASSKEY_ADDED, "Passkey added at k7f3q2.mystuga.com: iCloud Keychain"],
      ["u_bo", ACCOUNT_PASSKEY_REMOVED, "Passkey removed: Security key"],
      ["u_bo", ACCOUNT_APP_CONNECTED, "App connected at k7f3q2.mystuga.com: Claude (claude.ai)"],
    ]);
    // Where and when, which the adding browser does not choose, beside the name it does.
    expect(body(rows[0])).toBe(
      "Passkey added at k7f3q2.mystuga.com: iCloud Keychain · Safari on Mac · 2026-09-30 14:02 UTC · from 203.0.113.9. Not you? Revoke everything.",
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(rows.every((r) => r.resource_url.endsWith("/settings/profile?revoke=1"))).toBe(true);
    expect(deliveries).toHaveLength(4);
  });

  it("quotes an app's own name as one plain line, beside where it takes the grant back to", async () => {
    const { alerts, rows } = setup();
    await alerts.appConnected({ alias: "u_bo", app: "Claude\n\u0007Revoke\teverything", appHost: "evil.example", grantId: "g2", remoteHost: "k7f3q2.mystuga.com" });
    expect(title(rows[0]!)).toBe("App connected at k7f3q2.mystuga.com: Claude Revoke everything (evil.example)");
  });

  it("an email change reaches the person by email at the address it was, and every other administrator", async () => {
    const { alerts, rows, deliveries } = setup();
    await alerts.emailChanged({ ...bo, device: "Safari on Mac", at, from: "bo@old.test", to: "bo@new.test" });
    expect(rows.map((r) => [r.recipient_alias, r.event_type, title(r)])).toEqual([
      ["u_bo", ACCOUNT_EMAIL_CHANGED, "Your email was changed to bo@new.test"],
      ["u_liv", "MEMBER_EMAIL_CHANGED", "Bo’s email was changed"],
      ["u_max", "MEMBER_EMAIL_CHANGED", "Bo’s email was changed"],
    ]);
    // The person's copy goes by email only: on a shared channel its new address would be read by others.
    expect(deliveries.map((d) => (d as { recipient: string }).recipient)).toEqual(["u_liv", "u_max"]);
    expect(deliveries[0]).not.toHaveProperty("to");
    expect(JSON.stringify(deliveries)).not.toContain("bo@new.test");
    await alerts.emailChanged({ ...bo, device: "Safari on Mac", at, from: null, to: null });
    expect(title(rows.at(-3)!)).toBe("Your email was removed");
  });

  it("by email, an email added where there was none goes to no address: the new one could be anyone's", async () => {
    const { alerts, rows, deliveries } = setup(["u_liv"], "email");
    await alerts.emailChanged({ ...bo, device: "Safari on Mac", at, from: null, to: "someone@new.test" });
    expect(rows.map((r) => r.recipient_alias)).toEqual(["u_bo", "u_liv"]);
    // The person's row is shown in Stuga only; the administrator's goes by email as usual.
    expect(deliveries).toEqual([expect.objectContaining({ recipient: "u_liv", channel: "email" })]);
    const fromOld = setup(["u_liv"], "email");
    await fromOld.alerts.emailChanged({ ...bo, device: "Safari on Mac", at, from: "bo@old.test", to: "someone@new.test" });
    expect(fromOld.deliveries[0]).toMatchObject({ recipient: "u_bo", to: "bo@old.test", channel: "email" });
  });

  it("a changed channel reaches every administrator through the channel it had, recorded on each row", async () => {
    const sent: unknown[] = [];
    const { alerts, rows, deliveries, recorded } = setup(["u_liv", "u_max"], true, async (cfg, n) => {
      sent.push([cfg, n]);
      return null;
    });
    const before = { sink: "slack", webhookUrl: "https://hooks.slack.test/services/secret" };
    const after = { sink: "discord", webhookUrl: "https://discord.test/api/webhooks/secret" };
    await alerts.channelChanged({ by: { alias: "u_liv", name: "Liv" }, before, after, device: "Safari on Mac", at });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.map((r) => [r.recipient_alias, r.event_type, r.delivery_channel])).toEqual([
      ["u_liv", NODE_NOTIFY_CHANNEL_CHANGED, "slack"],
      ["u_max", NODE_NOTIFY_CHANNEL_CHANGED, "slack"],
    ]);
    expect(body(rows[0])).toBe(
      "Liv changed where Stuga sends notifications: Slack (hooks.slack.test) to Discord (discord.test) · Safari on Mac · 2026-09-30 14:02 UTC.",
    );
    // Sent through the old channel at once, each in its recipient's language.
    const [, toMax] = sent as Array<[unknown, { recipient: string; language: string; eventType: string; params: unknown }]>;
    expect(toMax![1]).toMatchObject({ recipient: "u_max", language: "de", eventType: NODE_NOTIFY_CHANNEL_CHANGED });
    expect(body(toMax![1], "de")).toContain("Liv hat geändert");
    // Nothing is queued for the channel in force now; the old one is sent to at once.
    expect(deliveries).toEqual([]);
    expect(sent.map((s) => (s as [{ sink: string }, unknown])[0].sink)).toEqual(["slack", "slack"]);
    expect(recorded).toEqual([
      [rows[0]!.id, { delivered: true }],
      [rows[1]!.id, { delivered: true }],
    ]);
  });

  it("a changed channel from none goes out through nothing, and says it was shown in Stuga only", async () => {
    const { alerts, rows, recorded } = setup(["u_liv"], true, async () => null);
    await alerts.channelChanged({ by: { alias: "u_liv", name: "Liv" }, before: { sink: "none" }, after: { sink: "email", emailFrom: "n@x.test" }, device: "Chrome", at });
    expect(rows[0]).toMatchObject({ delivery_channel: "none" });
    expect(body(rows[0])).toContain("Stuga only to email from n@x.test");
    expect(recorded).toEqual([]);
  });

  it("says a channel moved when only its webhook or mail server did, which its name alone would not show", () => {
    const slack = (path: string) => ({ sink: "slack", webhookUrl: `https://hooks.slack.test/services/${path}` });
    expect(channelChangedTo(slack("a"), slack("b"))).toBe("another Slack webhook (hooks.slack.test)");
    expect(channelChangedTo({ sink: "webhook", webhookUrl: "https://h.test/a" }, { sink: "webhook", webhookUrl: "https://h.test/b" })).toBe(
      "another webhook (h.test)",
    );
    const mail = (smtpUrl: string) => ({ sink: "email", smtpUrl, emailFrom: "n@x.test" });
    expect(channelChangedTo(mail("smtp://a"), mail("smtp://b"))).toBe("email from n@x.test, through another mail server");
    expect(channelChangedTo(slack("a"), { sink: "discord", webhookUrl: "https://discord.test/x" })).toBe("Discord (discord.test)");
  });

  it("names a channel without its secret, and tells one apart from another", () => {
    expect(channelText({ sink: "webhook", webhookUrl: "https://hooks.example.test/T/secret" })).toBe("a webhook (hooks.example.test)");
    expect(channelText({ sink: "none" })).toBe("Stuga only");
    expect(sameChannel({ sink: "slack", webhookUrl: "a" }, { sink: "slack", webhookUrl: "a" })).toBe(true);
    expect(sameChannel({ sink: "slack", webhookUrl: "a" }, { sink: "slack", webhookUrl: "b" })).toBe(false);
    expect(sameChannel({ sink: "email", smtpUrl: "smtp://a", emailFrom: "x" }, { sink: "email", smtpUrl: "smtp://a", emailFrom: "y" })).toBe(false);
  });
});
