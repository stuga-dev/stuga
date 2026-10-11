import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import IntlMessageFormat from "intl-messageformat";
import { UI_LANGUAGES } from "../domain/ui-languages";
import { parseDeliveryError, type NotificationEvent, type NotificationParams } from "./events";
import {
  NOTIFY_CATALOGS,
  formatInstant,
  recipientLanguage,
  renderChannel,
  renderDatabaseChange,
  renderGatePage,
  renderNotification,
  renderOpenAction,
} from "./render";

const AT = "2026-09-30T14:02:00.000Z";

/** Params for every event; typed against NotificationParams, so a new event needs one here. */
const SAMPLES: { [E in NotificationEvent]: NotificationParams[E] } = {
  MENTIONED_IN_COMMENT: { actor: "Ada", doc: "Q3 plan", excerpt: "@bo can you look?" },
  COMMENT_ON_OWNED_DOC: { actor: "Ada", doc: "Q3 plan", kind: "reply", excerpt: "Done." },
  DIRECT_DOC_PERMISSIONS: { actor: "Ada", doc: "Q3 plan" },
  REQUEST_ACCESS: { actor: "Ada", doc: "" },
  MENTIONED_IN_DOC: { actor: null, doc: "Q3 plan", excerpt: "Owner: @bo" },
  DATABASE_AGENT_EDIT: { actor: "Scout", doc: "Tasks", change: { kind: "rows_inserted", count: 3 } },
  DATABASE_AGENT_PROPOSED: { agent: "Scout", doc: "Tasks", count: 2 },
  AGENT_EDITS_PROPOSED: { agent: "Scout", doc: "Q3 plan", count: 1 },
  AGENT_EDITS_APPLIED: { agent: "Scout", doc: "Q3 plan" },
  ACCOUNT_NEW_SIGN_IN: { host: "k7f3q2.mystuga.com", device: "Safari on iPhone", at: AT, from: "203.0.113.7" },
  MEMBER_NEW_SIGN_IN: { name: "Bo", host: "k7f3q2.mystuga.com", device: "Safari on iPhone", at: AT, from: "203.0.113.7" },
  ACCOUNT_PASSWORD_CHANGED: { how: "changed", device: "Safari on Mac", at: AT, recourse: "machine" },
  MEMBER_PASSWORD_CHANGED: { name: "Bo", how: "reset", host: "k7f3q2.mystuga.com", device: "Safari on Mac", at: AT },
  ACCOUNT_EVERYTHING_REVOKED: { by: "Liv", device: "Edge on Windows", at: AT },
  MEMBER_EVERYTHING_REVOKED: { name: "Bo", by: null, at: AT },
  ACCOUNT_API_KEY_CREATED: { key: "Scout" },
  ACCOUNT_PASSKEY_ADDED: { host: "k7f3q2.mystuga.com", passkey: "iCloud Keychain", device: "Safari on Mac", at: AT, from: "203.0.113.9" },
  ACCOUNT_PASSKEY_REMOVED: { passkey: "Security key" },
  ACCOUNT_APP_CONNECTED: { host: "k7f3q2.mystuga.com", app: "Claude", appHost: "claude.ai" },
  ACCOUNT_EMAIL_CHANGED: { to: "bo@new.test", device: "Safari on Mac", at: AT },
  MEMBER_EMAIL_CHANGED: { name: "Bo", how: "removed", device: "Safari on Mac", at: AT },
  ACCOUNT_SIGN_INS_PAUSED: { username: "bo", host: null },
  NODE_NOTIFY_CHANNEL_CHANGED: {
    by: "Liv",
    before: { sink: "slack", host: "hooks.slack.test", from: null },
    after: { sink: "discord", host: "discord.test", from: null },
    device: "Safari on Mac",
    at: AT,
  },
  SECURITY_UPDATE_AVAILABLE: { running: "1.9.0", latest: "1.10.0", securityVersion: "1.9.2" },
  BACKUP_FAILED: { error: "pg_dump exited 1" },
  NODE_TEST_NOTIFICATION: {},
  REMOTE_CERT_RENEWAL_FAILED: { address: "https://k7f3q2.mystuga.com", expires: AT, detail: "The CA is down." },
  REMOTE_CERT_EXPIRING: { address: "https://k7f3q2.mystuga.com", expires: AT },
  REMOTE_CERT_EXPIRED: { address: "https://k7f3q2.mystuga.com" },
  REMOTE_CERT_RECOVERED: { address: "https://k7f3q2.mystuga.com", expires: AT },
  REMOTE_BINDING_REJECTED: { address: "https://k7f3q2.mystuga.com", reason: "refused" },
  REMOTE_ADDRESS_MOVED: { address: "https://k7f3q2.mystuga.com" },
};

/** What each event reads in English: the sentences the node wrote before it stored params. */
const ENGLISH: { [E in NotificationEvent]: [title: string, body: string] } = {
  MENTIONED_IN_COMMENT: ["Ada mentioned you in a comment on “Q3 plan”", "@bo can you look?"],
  COMMENT_ON_OWNED_DOC: ["Ada replied on “Q3 plan”", "Done."],
  DIRECT_DOC_PERMISSIONS: ["Ada shared “Q3 plan” with you", "You now have access to this document."],
  REQUEST_ACCESS: ["Ada requested access to “Untitled”", "Open the share dialog to grant them access."],
  MENTIONED_IN_DOC: ["You were mentioned in “Q3 plan”", "Owner: @bo"],
  DATABASE_AGENT_EDIT: ["“Tasks”: Scout made changes", "Inserted 3 rows. You can review and revert from the database’s Activity panel."],
  DATABASE_AGENT_PROPOSED: [
    "“Tasks”: Scout proposed changes",
    "Scout proposed 2 changes to this table — waiting for your review in the table’s Activity panel.",
  ],
  AGENT_EDITS_PROPOSED: ["“Q3 plan”: Scout proposed changes", "Scout proposed 1 change — waiting for your review"],
  AGENT_EDITS_APPLIED: ["“Q3 plan”: Scout made changes", "Scout changed this document directly, as it is set to allow."],
  ACCOUNT_NEW_SIGN_IN: [
    "New sign-in at k7f3q2.mystuga.com: Safari on iPhone",
    "New sign-in at k7f3q2.mystuga.com: Safari on iPhone · 2026-09-30 14:02 UTC · from 203.0.113.7. Not you? Sign out everywhere.",
  ],
  MEMBER_NEW_SIGN_IN: [
    "Bo signed in at k7f3q2.mystuga.com: Safari on iPhone",
    "Bo signed in at k7f3q2.mystuga.com: Safari on iPhone · 2026-09-30 14:02 UTC · from 203.0.113.7.",
  ],
  ACCOUNT_PASSWORD_CHANGED: [
    "Your password was changed",
    "Your password was changed on Safari on Mac · 2026-09-30 14:02 UTC. Not you? Run reset-password on the node’s machine to get back in, then sign out everywhere.",
  ],
  MEMBER_PASSWORD_CHANGED: [
    "Bo’s password was reset at k7f3q2.mystuga.com",
    "Bo’s password was reset at k7f3q2.mystuga.com on Safari on Mac · 2026-09-30 14:02 UTC.",
  ],
  ACCOUNT_EVERYTHING_REVOKED: ["Liv revoked everything for you", "Liv revoked everything for you · 2026-09-30 14:02 UTC."],
  MEMBER_EVERYTHING_REVOKED: ["Bo revoked everything", "Bo revoked everything · 2026-09-30 14:02 UTC."],
  ACCOUNT_API_KEY_CREATED: ["API key created: Scout", "API key created: Scout. Not you? Sign out everywhere."],
  ACCOUNT_PASSKEY_ADDED: [
    "Passkey added at k7f3q2.mystuga.com: iCloud Keychain",
    "Passkey added at k7f3q2.mystuga.com: iCloud Keychain · Safari on Mac · 2026-09-30 14:02 UTC · from 203.0.113.9. Not you? Sign out everywhere.",
  ],
  ACCOUNT_PASSKEY_REMOVED: ["Passkey removed: Security key", "Passkey removed: Security key. Not you? Sign out everywhere."],
  ACCOUNT_APP_CONNECTED: [
    "App connected at k7f3q2.mystuga.com: Claude (claude.ai)",
    "App connected at k7f3q2.mystuga.com: Claude (claude.ai). Not you? Sign out everywhere.",
  ],
  ACCOUNT_EMAIL_CHANGED: [
    "Your email was changed to bo@new.test",
    "Your email was changed to bo@new.test on Safari on Mac · 2026-09-30 14:02 UTC. Not you? Sign out everywhere.",
  ],
  MEMBER_EMAIL_CHANGED: ["Bo’s email was removed", "Bo’s email was removed on Safari on Mac · 2026-09-30 14:02 UTC."],
  ACCOUNT_SIGN_INS_PAUSED: [
    "Many wrong passwords for @bo on this node’s network",
    "Many wrong passwords for @bo on this node’s network. Sign-ins are paused for an hour at a time. A browser you signed in with before still signs you in.",
  ],
  NODE_NOTIFY_CHANNEL_CHANGED: [
    "Liv changed where Stuga sends notifications",
    "Liv changed where Stuga sends notifications: Slack (hooks.slack.test) to Discord (discord.test) · Safari on Mac · 2026-09-30 14:02 UTC.",
  ],
  SECURITY_UPDATE_AVAILABLE: ["Security update available: Stuga 1.10.0", "This node runs 1.9.0. Stuga 1.9.2 fixes a security issue."],
  BACKUP_FAILED: ["The scheduled backup failed", "pg_dump exited 1"],
  NODE_TEST_NOTIFICATION: [
    "Stuga test notification",
    "This is a test from your node’s settings page. If you are reading it, the sink works.",
  ],
  REMOTE_CERT_RENEWAL_FAILED: [
    "Remote access can’t renew its certificate",
    "The certificate for https://k7f3q2.mystuga.com expires 2026-09-30 14:02 UTC. The CA is down.",
  ],
  REMOTE_CERT_EXPIRING: ["Remote access’s certificate expires soon", "The certificate for https://k7f3q2.mystuga.com expires 2026-09-30 14:02 UTC."],
  REMOTE_CERT_EXPIRED: ["Remote access’s certificate expired", "https://k7f3q2.mystuga.com can’t be reached until there is a new one."],
  REMOTE_CERT_RECOVERED: [
    "Remote access has a new certificate",
    "The certificate for https://k7f3q2.mystuga.com is valid until 2026-09-30 14:02 UTC.",
  ],
  REMOTE_BINDING_REJECTED: [
    "Remote access needs a restore code",
    "The remote access service no longer accepts this node’s key. Enter a restore code to keep https://k7f3q2.mystuga.com.",
  ],
  REMOTE_ADDRESS_MOVED: [
    "Remote access moved to another computer",
    "https://k7f3q2.mystuga.com now reaches another computer. Remote access is off on this one.",
  ],
};

const EVENTS = Object.keys(SAMPLES) as NotificationEvent[];

describe("renderNotification", () => {
  it.each(EVENTS)("%s reads in English as the node wrote it", (event) => {
    expect(renderNotification(event, SAMPLES[event], "en")).toEqual({ title: ENGLISH[event][0], body: ENGLISH[event][1] });
  });

  it.each(EVENTS)("%s reads in German, with every argument filled in", (event) => {
    const de = renderNotification(event, SAMPLES[event], "de")!;
    const en = renderNotification(event, SAMPLES[event], "en")!;
    expect(de.title).not.toBe(en.title);
    expect(`${de.title} ${de.body}`).not.toMatch(/[{}]/);
  });

  it("writes each language's own words, quotes and times", () => {
    expect(renderNotification("DIRECT_DOC_PERMISSIONS", SAMPLES.DIRECT_DOC_PERMISSIONS, "ja")!.title).toBe("Adaが「Q3 plan」をあなたと共有しました");
    expect(renderNotification("REQUEST_ACCESS", SAMPLES.REQUEST_ACCESS, "zh-Hans")!.title).toContain("“未命名”");
    const signIn = renderNotification("ACCOUNT_NEW_SIGN_IN", SAMPLES.ACCOUNT_NEW_SIGN_IN, "de")!.body;
    expect(signIn).toContain(formatInstant(AT, "de"));
    expect(signIn).not.toContain("2026-09-30 14:02 UTC");
  });

  it("reads a regional tag as its language, and anything unknown as English", () => {
    expect(renderNotification("BACKUP_FAILED", SAMPLES.BACKUP_FAILED, "de-AT")).toEqual(renderNotification("BACKUP_FAILED", SAMPLES.BACKUP_FAILED, "de"));
    expect(renderNotification("BACKUP_FAILED", SAMPLES.BACKUP_FAILED, "xx")).toEqual(renderNotification("BACKUP_FAILED", SAMPLES.BACKUP_FAILED, "en"));
    expect(renderNotification("NOT_AN_EVENT", {}, "en")).toBeNull();
  });

  it("writes each change an agent made to a database, and each channel", () => {
    expect(renderDatabaseChange({ kind: "rows_imported", count: 1, table: "Leads" }, "en")).toBe("Imported 1 row into “Leads”.");
    expect(renderDatabaseChange({ kind: "column_type_changed" }, "en")).toBe("Changed a column’s type.");
    expect(renderChannel({ sink: "none", host: null, from: null }, "en")).toBe("Stuga only");
    expect(renderChannel({ sink: "slack", host: "hooks.slack.test", from: null, another: true }, "en")).toBe("another Slack webhook (hooks.slack.test)");
    expect(renderChannel({ sink: "email", host: null, from: "n@x.test", another: true }, "en")).toBe("email from n@x.test, through another mail server");
    expect(renderOpenAction("fr")).toBe("Ouvrir");
  });
});

describe("recipientLanguage", () => {
  it("takes the person's choice, else what their browser asked for, else English", () => {
    expect(recipientLanguage({ chosen: "ja", detected: "de" })).toBe("ja");
    expect(recipientLanguage({ chosen: null, detected: "de" })).toBe("de");
    expect(recipientLanguage({ chosen: null, detected: null })).toBe("en");
    expect(recipientLanguage(null)).toBe("en");
  });
});

describe("parseDeliveryError", () => {
  it("splits a stored error into its code and what came with it", () => {
    expect(parseDeliveryError("email_not_set_up")).toEqual({ code: "email_not_set_up" });
    expect(parseDeliveryError("sink_answered:500")).toEqual({ code: "sink_answered", status: "500" });
    expect(parseDeliveryError("failed:connect ECONNREFUSED")).toEqual({ code: "failed", detail: "connect ECONNREFUSED" });
  });
});

describe("renderGatePage", () => {
  it("says what the node is doing, in the browser's language", () => {
    expect(renderGatePage("starting", "en")).toEqual({ title: "Stuga is starting.", body: null, reloads: "This page reloads by itself." });
    expect(renderGatePage("starting", "zh-Hans").title).toBe("Stuga 正在启动。");
    const refused = renderGatePage({ servedBy: "1.1.0", version: "1.0.0" }, "zh-Hans");
    expect(refused.title).toContain("1.1.0");
    expect(refused.body).toContain("1.0.0");
    expect(renderGatePage({ servedBy: null, version: "1.0.0" }, "en").title).toBe("A newer Stuga changed this data");
  });
});

describe("the catalogs", () => {
  const dir = new URL("./messages/", import.meta.url);
  const english = NOTIFY_CATALOGS.en;

  type Node = { type: number; value?: unknown; options?: Record<string, { value: Node[] }> };

  /** A message's argument names, from its parsed form. */
  function argumentsOf(message: string, lang: string): string[] {
    const names = new Set<string>();
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.type >= 1 && n.type <= 6 && typeof n.value === "string") names.add(n.value);
        for (const option of Object.values(n.options ?? {})) walk(option.value);
      }
    };
    walk(new IntlMessageFormat(message, lang, undefined, { ignoreTag: true }).getAst() as Node[]);
    return [...names].sort();
  }

  it("has a file for every interface language, and no other", () => {
    expect(readdirSync(dir).map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...UI_LANGUAGES].sort());
  });

  it.each(UI_LANGUAGES.filter((l) => l !== "en"))("%s has every English key, no other, with the same arguments", (lang) => {
    const catalog = JSON.parse(readFileSync(new URL(`${lang}.json`, dir), "utf8")) as Record<string, string>;
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort());
    for (const [key, message] of Object.entries(catalog)) {
      expect(argumentsOf(message, lang), `${lang} ${key}`).toEqual(argumentsOf(english[key]!, "en"));
      expect(message, `${lang} ${key}`).not.toContain("'");
    }
  });
});
