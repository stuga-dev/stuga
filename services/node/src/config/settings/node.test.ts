import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "@stuga/db";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_UPLOAD_BYTES, bodyBytesFor, imageUploadLimits } from "../../media/media.js";
import { createNodeSettingsStore, fingerprintUrl, notifyIncomplete, redactUrl, resolveNodeSettings } from "./node.js";

const ORIGIN = "http://livs-air.local:8787";

describe("createNodeSettingsStore", () => {
  it("keeps the last good snapshot when a refresh cannot read the row, and takes the row again once it can", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stuga-settings-"));
    try {
      let answer: () => Promise<unknown[]> = async () => [{ audit_retention_days: 0, ai_usage_retention_days: 0, ask_thread_retention_days: 0 }];
      const sql = ((..._query: unknown[]) => answer()) as unknown as Sql;
      const store = await createNodeSettingsStore({ sql, dataDir, publicOrigin: ORIGIN });
      expect(store.current()).toMatchObject({ auditRetentionDays: 0, aiUsageRetentionDays: 0, askThreadRetentionDays: 0 });

      answer = async () => Promise.reject(new Error("connection terminated"));
      await expect(store.refresh()).rejects.toThrow("connection terminated");
      expect(store.current()).toMatchObject({ auditRetentionDays: 0, aiUsageRetentionDays: 0, askThreadRetentionDays: 0 });

      answer = async () => [];
      await store.refresh();
      expect(store.current()).toMatchObject({ auditRetentionDays: 180, aiUsageRetentionDays: 365, askThreadRetentionDays: 365 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("resolveNodeSettings", () => {
  it("falls back to the defaults when the row says nothing", () => {
    const r = resolveNodeSettings(null, ORIGIN);
    expect(r.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(r.auditRetentionDays).toBe(180);
    expect(r.databaseOpsKeep).toBe(500);
    expect(r.aiUsageRetentionDays).toBe(365);
    expect(r.askThreadRetentionDays).toBe(365);
    expect(r.notify).toEqual({ sink: "none" });
    expect(r.branding).toEqual({ accentColor: null });
    expect(r.updateCheck).toBe(true);
    expect(r.identityProvider).toBeNull();
  });

  it("looks for newer versions unless the row says not to, false being a value rather than unset", () => {
    expect(resolveNodeSettings({ updateCheck: null }, ORIGIN).updateCheck).toBe(true);
    expect(resolveNodeSettings({ updateCheck: true }, ORIGIN).updateCheck).toBe(true);
    expect(resolveNodeSettings({ updateCheck: false }, ORIGIN).updateCheck).toBe(false);
  });

  it("has no name until an administrator gives one, and tells the node apart by its host meanwhile", () => {
    const unnamed = resolveNodeSettings(null, ORIGIN);
    expect(unnamed.nodeName).toBeNull();
    expect(unnamed.nodeLabel).toBe("livs-air");
    expect(resolveNodeSettings(null, "https://docs.example.com").nodeLabel).toBe("docs.example.com");
    const named = resolveNodeSettings({ nodeName: "Liv's Mac" }, ORIGIN);
    expect(named.nodeName).toBe("Liv's Mac");
    expect(named.nodeLabel).toBe("Liv's Mac");
  });

  it("resolves the identity provider's button text and scopes when the row leaves them unset", () => {
    const r = resolveNodeSettings({ idpIssuer: "https://id.example.com/realms/x", idpClientId: "stuga" }, ORIGIN);
    expect(r.identityProvider).toEqual({
      issuer: "https://id.example.com/realms/x",
      clientId: "stuga",
      clientSecret: null,
      label: "id.example.com",
      scopes: "openid profile email",
    });
    const named = resolveNodeSettings({ idpIssuer: "https://id.example.com", idpClientId: "c", idpLabel: "Okta", idpScopes: "openid" }, ORIGIN);
    expect(named.identityProvider).toMatchObject({ label: "Okta", scopes: "openid" });
    expect(resolveNodeSettings({ idpIssuer: "https://id.example.com" }, ORIGIN).identityProvider).toBeNull();
  });

  it("derives a body ceiling that carries a full-size upload", () => {
    const r = resolveNodeSettings(null, ORIGIN);
    expect(r.maxBodyBytes).toBe(bodyBytesFor(DEFAULT_MAX_UPLOAD_BYTES));
    expect(imageUploadLimits(r.maxBodyBytes).bytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    const raised = resolveNodeSettings({ maxUploadBytes: 20 * 1024 * 1024 }, ORIGIN);
    expect(imageUploadLimits(raised.maxBodyBytes)).toMatchObject({ bytes: 20 * 1024 * 1024, label: "20 MB" });
  });

  it("takes the stored row, with 0 a value rather than unset", () => {
    const r = resolveNodeSettings(
      {
        auditRetentionDays: 30,
        databaseOpsKeep: 0,
        aiUsageRetentionDays: 30,
        askThreadRetentionDays: 0,
        notifySink: "webhook",
        notifyWebhookUrl: "https://hook.test/x",
      },
      ORIGIN,
    );
    expect(r.auditRetentionDays).toBe(30);
    expect(r.databaseOpsKeep).toBe(0);
    expect(r.aiUsageRetentionDays).toBe(30);
    expect(r.askThreadRetentionDays).toBe(0);
    expect(r.notify).toEqual({ sink: "webhook", webhookUrl: "https://hook.test/x" });
  });
});

describe("notifyIncomplete", () => {
  it("names what a sink is still missing, and passes a complete one", () => {
    expect(notifyIncomplete({ sink: "none" })).toBeNull();
    expect(notifyIncomplete({ sink: "slack" })).toMatch(/webhook URL/);
    expect(notifyIncomplete({ sink: "slack", webhookUrl: "https://h.test/x" })).toBeNull();
    expect(notifyIncomplete({ sink: "email" })).toMatch(/SMTP/);
    expect(notifyIncomplete({ sink: "email", smtpUrl: "smtp://h" })).toMatch(/From address/);
    expect(notifyIncomplete({ sink: "email", smtpUrl: "smtp://h", emailFrom: "a@b.test" })).toBeNull();
  });
});

describe("redactUrl", () => {
  it("keeps an SMTP host, port and user, and drops the password", () => {
    expect(redactUrl("smtp://stuga:hunter2@mail.example.com:587")).toBe("smtp://stuga@mail.example.com:587");
    expect(redactUrl("smtps://mail.example.com")).toBe("smtps://mail.example.com");
  });

  it("keeps the database name, which is addressing rather than a secret", () => {
    expect(redactUrl("postgres://stuga:stuga@db:5432/stuga")).toBe("postgres://stuga@db:5432/stuga");
  });

  it("says something safe about a value it cannot parse", () => {
    expect(redactUrl("not a url")).toBe("on file");
  });
});

describe("fingerprintUrl", () => {
  it("keeps the host and NONE of the path, which is where a webhook's secret lives", () => {
    const label = fingerprintUrl("https://hooks.slack.com/services/T0001/B0002/XXXXSECRETXXXX");
    expect(label).not.toContain("XXXXSECRETXXXX");
    expect(label).not.toContain("B0002");
    expect(label).not.toContain("services");
    expect(label).toMatch(/^hooks\.slack\.com · [0-9a-f]{6}$/);
  });

  it("does not leak a self-hosted sink whose FIRST path segment is the token", () => {
    expect(fingerprintUrl("https://sink.internal.example.com/s3cr3t-t0ken")).not.toContain("s3cr3t");
  });

  it("tells two workspaces on the same host apart", () => {
    const a = fingerprintUrl("https://hooks.slack.com/services/T0001/B0002/AAAA");
    const b = fingerprintUrl("https://hooks.slack.com/services/T9999/B8888/BBBB");
    expect(a).not.toBe(b);
    expect(fingerprintUrl("https://hooks.slack.com/services/T0001/B0002/AAAA")).toBe(a);
  });

  it("says something safe about a value it cannot parse", () => {
    expect(fingerprintUrl("not a url")).toBe("on file");
  });
});
