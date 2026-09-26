/**
 * The settings PUT: each group is saved on its own, and an omitted key inside a
 * group is left alone.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockProvider, type MockProvider } from "@stuga/auth/testing";
import type { NodeSettingsRow } from "@stuga/db";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(async () => true),
  getNodeSettings: vi.fn(async () => null),
  saveNodeSettings: vi.fn(async () => ({ unlinkedAccounts: 0 })),
  resetNodeSettings: vi.fn(async () => ({ identityProvider: null, unlinkedAccounts: 0 })),
  countAccountsWithoutPassword: vi.fn(async () => 0),
}));

const { saveNodeSettings, getNodeSettings, resetNodeSettings, countAccountsWithoutPassword, isNodeAdminAlias } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
const { recordAudit } = await import("../../audit/record.js");
import type { Ctx } from "../../auth/context.js";

vi.mock("../../audit/record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../audit/record.js")>()),
  recordAudit: vi.fn(),
}));

// The real files, with a way to make one write fail after the row has committed.
vi.mock("../../config/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/secrets.js")>();
  return { ...actual, writeSecretFile: vi.fn(actual.writeSecretFile), removeSecretFile: vi.fn(actual.removeSecretFile) };
});
const { writeSecretFile, removeSecretFile } = await import("../../config/secrets.js");
const writeSecret = writeSecretFile as unknown as ReturnType<typeof vi.fn>;
const removeSecret = removeSecretFile as unknown as ReturnType<typeof vi.fn>;

/** The one transactional write a save makes; the database decides there whether the subjects go. */
const save = saveNodeSettings as unknown as ReturnType<typeof vi.fn>;
const storedRow = getNodeSettings as unknown as ReturnType<typeof vi.fn>;
const reset = resetNodeSettings as unknown as ReturnType<typeof vi.fn>;
const withoutPassword = countAccountsWithoutPassword as unknown as ReturnType<typeof vi.fn>;
const audit = recordAudit as unknown as ReturnType<typeof vi.fn>;

const dataDir = mkdtempSync(join(tmpdir(), "stuga-settings-route-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** The search languages a node was set up with; a save starts a rebuild at once, which stays running. */
function searchLanguages(languages: string[] = [], error: string | null = null) {
  let rebuilding = false;
  const rebuild = vi.fn(async (next: string[]) => {
    languages = [...next];
    rebuilding = true;
  });
  return {
    current: () => languages,
    status: () => ({ languages: [...languages], rebuilding, error }),
    rebuild,
    save: vi.fn(async (next: string[], _updatedBy: string | null) => void rebuild(next)),
    stop: async () => {},
  };
}

/** A node administrator on a node with nothing saved yet; `nodeName` is the name set, null for none. */
function ctx(nodeName: string | null = null, search = searchLanguages()): Ctx {
  return {
    sql: {},
    alias: "admin-1",
    isAgent: false,
    principals: ["user:admin-1"],
    env: {
      publicOrigin: "http://node.test",
      extraOrigins: ["http://nas.local:8787"],
      dataDir,
      bind: "127.0.0.1",
      port: 8787,
      databaseUrl: "postgres://stuga:stuga@db:5432/stuga",
      embeddingDims: 1024,
      searchLanguages: search,
      restartHint: "Restart the node to apply.",
      nodeId: "abcdefghijk23456",
      settings: {
        current: () => ({
          nodeName,
          nodeLabel: nodeName ?? "node.test",
          maxUploadBytes: 10 * 1024 * 1024,
          maxBodyBytes: 10 * 1024 * 1024 + 64 * 1024,
          auditRetentionDays: 180,
          databaseOpsKeep: 500,
          aiUsageRetentionDays: 365,
          askThreadRetentionDays: 365,
          notify: { sink: "none" },
          branding: { accentColor: null },
          updateCheck: true,
          backups: { auto: true, hour: 3 },
          timeZone: "UTC",
          identityProvider: null,
        }),
        refresh: async () => {},
        secrets: () => ({
          webhook: { set: false, label: null, stale: false },
          smtp: { set: false, label: null, stale: false },
          idpClientSecret: { set: false, label: null, stale: false },
        }),
      },
    },
  } as unknown as Ctx;
}

function put(c: Ctx, body: unknown): Promise<Response | null> {
  const req = new Request("http://node.test/api/node/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return routeWorkspaceRequest(c, req);
}

describe("PUT /api/node/settings", () => {
  it("saves the database activity retention beside the audit one, and refuses a negative", async () => {
    save.mockClear();
    const res = await put(ctx(), { maintenance: { database_ops_keep: 2000 } });
    expect(res?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ databaseOpsKeep: 2000 });
    expect((await put(ctx(), { maintenance: { database_ops_keep: 0 } }))?.status).toBe(200);
    expect((await put(ctx(), { maintenance: { database_ops_keep: -1 } }))?.status).toBe(400);
  });

  it("saves the audit retention in days, with 0 keeping every row, and refuses a negative or a fraction", async () => {
    save.mockClear();
    expect((await put(ctx(), { maintenance: { audit_retention_days: 0 } }))?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ auditRetentionDays: 0 });
    expect((await put(ctx(), { maintenance: { audit_retention_days: 30 } }))?.status).toBe(200);
    expect((await put(ctx(), { maintenance: { audit_retention_days: -1 } }))?.status).toBe(400);
    expect((await put(ctx(), { maintenance: { audit_retention_days: 2.5 } }))?.status).toBe(400);
  });

  it("saves the AI usage and ask thread retention in days, 0 allowed, negatives refused", async () => {
    save.mockClear();
    const res = await put(ctx(), { maintenance: { ai_usage_retention_days: 90, ask_thread_retention_days: 0 } });
    expect(res?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ aiUsageRetentionDays: 90, askThreadRetentionDays: 0 });
    expect((await put(ctx(), { maintenance: { ai_usage_retention_days: -1 } }))?.status).toBe(400);
    expect((await put(ctx(), { maintenance: { ask_thread_retention_days: 1.5 } }))?.status).toBe(400);
  });

  it("turns the look for newer versions off and on, and takes only a boolean for it", async () => {
    save.mockClear();
    expect((await put(ctx(), { updates: { check: false } }))?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ updateCheck: false });
    expect((await put(ctx(), { updates: { check: true } }))?.status).toBe(200);
    expect(save.mock.calls[1]?.[1]).toMatchObject({ updateCheck: true });

    // "false" is a truthy string: saved as it reads, it would turn the look on.
    const res = await put(ctx(), { updates: { check: "false" } });
    expect(res?.status).toBe(400);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("turns the daily backup off and on, moves its hour, and names the time zone it is in", async () => {
    save.mockClear();
    expect((await put(ctx(), { backups: { auto: false, hour: 22 } }))?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ backupAuto: false, backupHour: 22 });
    expect((await put(ctx(), { time_zone: "Asia/Shanghai" }))?.status).toBe(200);
    expect(save.mock.calls[1]?.[1]).toMatchObject({ timeZone: "Asia/Shanghai" });
    expect((await put(ctx(), { time_zone: null }))?.status).toBe(200);
    expect(save.mock.calls[2]?.[1]).toMatchObject({ timeZone: null });

    for (const bad of [{ backups: { auto: "yes" } }, { backups: { hour: 24 } }, { backups: { hour: 2.5 } }, { time_zone: "Mars/Olympus" }]) {
      expect((await put(ctx(), bad))?.status).toBe(400);
    }
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("leaves the look for newer versions as it was when another group is saved", async () => {
    save.mockClear();
    expect((await put(ctx(), { maintenance: { audit_retention_days: 30 } }))?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ updateCheck: null });
  });

  it("accepts a group with no fields as a no-op rather than an error", async () => {
    const res = await put(ctx(), { maintenance: {} });
    expect(res?.status).toBe(200);
  });

  it("refuses a body that names no group at all", async () => {
    const res = await put(ctx(), {});
    expect(res?.status).toBe(400);
    expect(await res?.json()).toMatchObject({ error: expect.stringContaining("nothing to save") });
  });

  it("has no network group: the allowed origins are set in the environment only", async () => {
    save.mockClear();
    const res = await put(ctx(), { network: { extra_origins: ["https://*.example.test"] } });
    expect(res?.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("reports the environment's origins read-only, with how a change applies", async () => {
    const req = new Request("http://node.test/api/node/settings");
    const res = await routeWorkspaceRequest(ctx(), req);
    const body = (await res?.json()) as Record<string, unknown> & { node: Record<string, unknown> };
    expect(body.node).toMatchObject({ public_origin: "http://node.test", extra_origins: ["http://nas.local:8787"] });
    expect(body.restart_hint).toBe("Restart the node to apply.");
    expect(body).not.toHaveProperty("network");
  });

  it("holds the upload size to its ceiling, naming the reason", async () => {
    const res = await put(ctx(), { limits: { max_upload_mb: 500 } });
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain("50 MB");
    expect(body.error).toContain("memory");
  });
});

describe("the node's name", () => {
  beforeEach(() => {
    save.mockClear();
    audit.mockClear();
    storedRow.mockResolvedValue(null);
  });

  const get = async (c: Ctx) =>
    (await (await routeWorkspaceRequest(c, new Request("http://node.test/api/node/settings")))!.json()) as Record<string, unknown> & {
      node: Record<string, unknown>;
    };

  it("answers the name set, the label that tells the node apart, and the node's id among the facts", async () => {
    const body = await get(ctx("Liv's Mac"));
    expect(body.node_name).toBe("Liv's Mac");
    expect(body.node_label).toBe("Liv's Mac");
    expect(body).not.toHaveProperty("node_name_default");
    expect(body.node.node_id).toBe("abcdefghijk23456");
    // Unnamed: no name to show, and the host as the label.
    const unnamed = await get(ctx());
    expect(unnamed.node_name).toBeNull();
    expect(unnamed.node_label).toBe("node.test");
    // The name is its own setting now: branding is the mark and the colour.
    expect(body.branding).toEqual({ accent_color: null });
  });

  it("saves a name trimmed, and an empty one as none", async () => {
    expect((await put(ctx(), { node_name: "  Liv's Mac  " }))?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ nodeName: "Liv's Mac" });
    expect((await put(ctx(), { node_name: "" }))?.status).toBe(200);
    expect(save.mock.calls[1]?.[1]).toMatchObject({ nodeName: null });
  });

  it("keeps the stored name when another group is saved", async () => {
    storedRow.mockResolvedValue({ node_name: "Liv's Mac" });
    await put(ctx("Liv's Mac"), { maintenance: { audit_retention_days: 30 } });
    expect(save.mock.calls[0]?.[1]).toMatchObject({ nodeName: "Liv's Mac" });
  });

  it.each([
    ["an emoji joined by a zero-width joiner", "🏳️\u200d🌈 Home"],
    ["a word with a zero-width non-joiner", "می\u200cخواهم"],
    ["a soft hyphen", "Co\u00adop"],
  ])("takes %s", async (_what, name) => {
    expect((await put(ctx(), { node_name: name }))?.status).toBe(200);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ nodeName: name });
  });

  it.each<[string, unknown, RegExp]>([
    ["a name over 80 characters", "x".repeat(81), /80 characters/],
    ["a control character", "Liv\u0007s Mac", /control characters/],
    ["a line break", "Liv\ns Mac", /control characters/],
    ["a line separator", "Liv\u2028s Mac", /control characters/],
    ["nothing visible", "\u200b\u200d", /visible character/],
    ["a mark that reverses the text after it", "a\u202eb", /control characters/],
    ["something that is not text", 42, /must be a string/],
  ])("refuses %s", async (_what, name, message) => {
    const res = (await put(ctx(), { node_name: name }))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(save).not.toHaveBeenCalled();
  });

  it("records the name before and after in the audit row", async () => {
    await put(ctx(), { node_name: "Liv's Mac" });
    const detail = audit.mock.calls.find((c) => c[1].action === "node.settings.update")![1].detail;
    expect(detail.before.node_name).toBeNull();
    expect(detail.after).toHaveProperty("node_name");
  });

  it("goes back to the default on a reset, with every other setting", async () => {
    reset.mockClear();
    const res = await routeWorkspaceRequest(ctx(), new Request("http://node.test/api/node/settings", { method: "DELETE" }));
    expect(res?.status).toBe(200);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("the search languages", () => {
  const get = async (c: Ctx) =>
    (await (await routeWorkspaceRequest(c, new Request("http://node.test/api/node/settings")))!.json()) as Record<string, unknown>;

  beforeEach(() => {
    save.mockClear();
    audit.mockClear();
  });

  it("answers the languages chosen, the choices, whether the indexes are being rebuilt and why the last rebuild gave up", async () => {
    expect((await get(ctx(null, searchLanguages(["ko"])))).search).toEqual({
      languages: ["ko"],
      choices: ["ko", "ar"],
      rebuilding: false,
      error: null,
    });
    expect((await get(ctx(null, searchLanguages(["ko"], "could not extend file: No space left on device")))).search).toMatchObject({
      rebuilding: false,
      error: "could not extend file: No space left on device",
    });
  });

  it("saves them on their own, starts one rebuild, and answers that it is rebuilding", async () => {
    const search = searchLanguages();
    const res = await put(ctx(null, search), { search: { languages: ["ar", "ko", "ar"] } });
    expect(res?.status).toBe(200);
    expect(search.save).toHaveBeenCalledTimes(1);
    expect(search.save).toHaveBeenCalledWith(["ko", "ar"], "admin-1");
    // The rest of the row is not written for them.
    expect(save).not.toHaveBeenCalled();
    expect(((await res!.json()) as Record<string, unknown>).search).toEqual({
      languages: ["ko", "ar"],
      choices: ["ko", "ar"],
      rebuilding: true,
      error: null,
    });
    const detail = audit.mock.calls.find((c) => c[1].action === "node.settings.update")![1].detail;
    expect(detail.before.search_languages).toEqual([]);
    expect(detail.after.search_languages).toEqual(["ko", "ar"]);
  });

  it("saves none as a choice", async () => {
    const search = searchLanguages(["ko"]);
    expect((await put(ctx(null, search), { search: { languages: [] } }))?.status).toBe(200);
    expect(search.save).toHaveBeenCalledWith([], "admin-1");
  });

  it("refuses a language that is not a choice, or anything but a list, and saves nothing", async () => {
    for (const languages of [["ko", "fr"], "ko", [1], null]) {
      const search = searchLanguages();
      const res = await put(ctx(null, search), { search: { languages } });
      expect(res?.status, JSON.stringify(languages)).toBe(400);
      expect(((await res!.json()) as { error: string }).error).toBe("search.languages must be a list of: ko, ar");
      expect(search.save).not.toHaveBeenCalled();
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves them alone when another group is saved, or the rest is reset", async () => {
    const search = searchLanguages(["ar"]);
    expect((await put(ctx(null, search), { updates: { check: false } }))?.status).toBe(200);
    expect((await routeWorkspaceRequest(ctx(null, search), new Request("http://node.test/api/node/settings", { method: "DELETE" })))?.status).toBe(200);
    expect(search.save).not.toHaveBeenCalled();
    expect(search.rebuild).not.toHaveBeenCalled();
    expect((await get(ctx(null, search))).search).toMatchObject({ languages: ["ar"] });
  });

  it("are a node administrator's to change", async () => {
    (isNodeAdminAlias as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const search = searchLanguages();
    const res = await put(ctx(null, search), { search: { languages: ["ko"] } });
    expect(res?.status).toBe(403);
    expect(search.save).not.toHaveBeenCalled();
  });

  it("audits the other groups a save committed when writing the languages then fails, and nothing when they were all it sent", async () => {
    const failing = searchLanguages();
    failing.save.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const updates = () => audit.mock.calls.filter((c) => c[1].action === "node.settings.update");

    await expect(put(ctx(null, failing), { node_name: "Liv's Mac", search: { languages: ["ko"] } })).rejects.toThrow("connection terminated unexpectedly");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatchObject({ nodeName: "Liv's Mac" });
    expect(updates()).toHaveLength(1);
    // The languages were not saved, so the row says they did not change.
    expect(updates()[0]![1].detail.after.search_languages).toEqual([]);

    audit.mockClear();
    await expect(put(ctx(null, failing), { search: { languages: ["ko"] } })).rejects.toThrow("connection terminated unexpectedly");
    expect(updates()).toEqual([]);
  });

  it("are no longer an environment fact", async () => {
    expect((await get(ctx())).node).not.toHaveProperty("search_languages");
  });
});

describe("the identity provider section", () => {
  let idp: MockProvider;
  beforeEach(async () => {
    idp = await startMockProvider();
    save.mockClear();
    audit.mockClear();
    storedRow.mockResolvedValue(null);
  });
  afterEach(async () => {
    await idp.stop();
    storedRow.mockResolvedValue(null);
  });

  const secretFile = () => join(dataDir, "secrets", "idp-client-secret");
  const row = (over: Partial<NodeSettingsRow> = {}): Partial<NodeSettingsRow> => ({
    idp_issuer: idp.issuer,
    idp_client_id: "stuga",
    idp_client_secret_label: null,
    idp_label: null,
    idp_scopes: null,
    ...over,
  });

  it("saves a provider whose discovery document checks out, storing the provider's own issuer", async () => {
    const res = await put(ctx(), { identity_provider: { issuer: `${idp.issuer}/`, client_id: " stuga ", client_secret: "s3cret", label: "Mock" } });
    expect(res?.status).toBe(200);
    expect(save.mock.calls[0]?.[1].identityProvider).toEqual({
      issuer: idp.issuer,
      clientId: "stuga",
      clientSecretLabel: expect.stringMatching(/^[0-9a-f]{8}$/),
      label: "Mock",
      scopes: null,
    });
    expect(readFileSync(secretFile(), "utf8").trim()).toBe("s3cret");
    // The audit row names the provider, never its secret.
    const detail = audit.mock.calls.find((c) => c[1].action === "node.settings.update")![1].detail;
    expect(detail.after.identity_provider).toEqual({ issuer: idp.issuer, client_id: "stuga", label: "Mock", scopes: null });
    expect(JSON.stringify(detail)).not.toContain("s3cret");
    expect(detail.after).not.toHaveProperty("identity_provider_unlinked_accounts");
  });

  it.each<[string, unknown, RegExp]>([
    ["plain http off this machine", { issuer: "http://id.example.test", client_id: "c" }, /https/],
    ["no client ID", { issuer: "https://id.example.test" }, /client ID/],
    ["scopes without openid", { issuer: "http://127.0.0.1:1", client_id: "c", scopes: "profile email" }, /openid/],
    ["a provider that does not answer", { issuer: "http://127.0.0.1:1", client_id: "c" }, /could not be reached/],
  ])("refuses %s", async (_what, provider, message) => {
    const res = (await put(ctx(), { identity_provider: provider }))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an issuer the discovery document does not confirm", async () => {
    const res = await put(ctx(), { identity_provider: { issuer: `${idp.issuer}/realms/other`, client_id: "c" } });
    expect(res?.status).toBe(400);
  });

  it("keeps the secret when it is left out, and deletes it when it is empty", async () => {
    storedRow.mockResolvedValue(row({ idp_client_secret_label: "abcd1234" }));
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga" } });
    expect(save.mock.calls[0]?.[1].identityProvider.clientSecretLabel).toBe("abcd1234");
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "" } });
    expect(save.mock.calls[1]?.[1].identityProvider.clientSecretLabel).toBeNull();
    expect(existsSync(secretFile())).toBe(false);
  });

  it("removes the provider and its secret, and records how many accounts the database unlinked", async () => {
    storedRow.mockResolvedValue(row({ idp_client_secret_label: "abcd1234" }));
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "s3cret" } });
    expect(existsSync(secretFile())).toBe(true);
    save.mockClear();
    save.mockResolvedValueOnce({ unlinkedAccounts: 3 });
    const res = await put(ctx(), { identity_provider: null });
    expect(res?.status).toBe(200);
    expect(save.mock.calls[0]?.[1].identityProvider).toBeNull();
    expect(existsSync(secretFile())).toBe(false);
    const updates = audit.mock.calls.filter((c) => c[1].action === "node.settings.update");
    expect(updates.at(-1)![1].detail.after.identity_provider_unlinked_accounts).toBe(3);
  });

  it("leaves the secret file alone when the transaction fails", async () => {
    storedRow.mockResolvedValue(row({ idp_client_secret_label: "abcd1234" }));
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "kept" } });
    save.mockRejectedValueOnce(new Error("serialization failure"));
    await expect(put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "new" } })).rejects.toThrow(
      "serialization failure",
    );
    expect(readFileSync(secretFile(), "utf8").trim()).toBe("kept");
    save.mockRejectedValueOnce(new Error("serialization failure"));
    await expect(put(ctx(), { identity_provider: null })).rejects.toThrow("serialization failure");
    expect(readFileSync(secretFile(), "utf8").trim()).toBe("kept");
  });

  it("a failed read of the settings row fails the save and writes nothing", async () => {
    storedRow.mockResolvedValue(row({ idp_client_secret_label: "abcd1234" }));
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "kept" } });
    save.mockClear();
    audit.mockClear();
    // Read as "nothing saved", this save would drop the provider, its secret and every other stored setting.
    storedRow.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    await expect(put(ctx(), { node_name: "Renamed", notify: { sink: "none", webhook_url: "" } })).rejects.toThrow(
      "connection terminated unexpectedly",
    );
    expect(save).not.toHaveBeenCalled();
    expect(readFileSync(secretFile(), "utf8").trim()).toBe("kept");
    expect(audit).not.toHaveBeenCalled();
  });

  it("a failed reset leaves every secret file in place", async () => {
    storedRow.mockResolvedValue(row({ idp_client_secret_label: "abcd1234" }));
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "kept" } });
    reset.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    await expect(
      routeWorkspaceRequest(ctx(), new Request("http://node.test/api/node/settings", { method: "DELETE" })),
    ).rejects.toThrow("connection terminated unexpectedly");
    expect(readFileSync(secretFile(), "utf8").trim()).toBe("kept");
  });

  it("audits a committed save whose secret files then fail, and still applies the files after the one that failed", async () => {
    storedRow.mockResolvedValue(row({ idp_client_secret_label: "abcd1234" }));
    await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "kept" } });
    audit.mockClear();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The disk refuses the first file; the row, with the provider and 3 links gone, has already committed.
      removeSecret.mockImplementationOnce(() => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      });
      save.mockResolvedValueOnce({ unlinkedAccounts: 3 });
      const res = await put(ctx(), { notify: { sink: "none", webhook_url: "" }, identity_provider: null });
      expect(res?.status).toBe(200);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("secret file notify-webhook "), expect.any(Error));
      expect(existsSync(secretFile())).toBe(false);
      const detail = audit.mock.calls.find((c) => c[1].action === "node.settings.update")![1].detail;
      expect(detail.before.identity_provider).toMatchObject({ issuer: idp.issuer });
      expect(detail.after).toMatchObject({ identity_provider: null, identity_provider_unlinked_accounts: 3 });

      // The same for a reset, and for a write rather than a removal.
      writeSecret.mockClear();
      await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "again" } });
      expect(writeSecret).toHaveBeenCalled();
      removeSecret.mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      reset.mockResolvedValueOnce({ identityProvider: { issuer: idp.issuer, clientId: "stuga", label: null, scopes: null }, unlinkedAccounts: 2 });
      const cleared = await routeWorkspaceRequest(ctx(), new Request("http://node.test/api/node/settings", { method: "DELETE" }));
      expect(cleared?.status).toBe(200);
      expect(existsSync(secretFile())).toBe(false);
      expect(audit.mock.calls.find((c) => c[1].action === "node.settings.reset")![1].detail).toMatchObject({
        identity_provider_unlinked_accounts: 2,
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("a write that fails after the commit still leaves the rest of the files and the audit row", async () => {
    storedRow.mockResolvedValue(row());
    audit.mockClear();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeSecret.mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
      save.mockResolvedValueOnce({ unlinkedAccounts: 4 });
      const res = await put(ctx(), { identity_provider: { issuer: idp.issuer, client_id: "stuga", client_secret: "lost" } });
      expect(res?.status).toBe(200);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("idp-client-secret"), expect.any(Error));
      const detail = audit.mock.calls.find((c) => c[1].action === "node.settings.update")![1].detail;
      expect(detail.after).toMatchObject({ identity_provider_secret_changed: true, identity_provider_unlinked_accounts: 4 });
    } finally {
      logged.mockRestore();
    }
  });

  it("audits a committed save and a committed reset even when reloading the settings fails", async () => {
    const c = ctx();
    (c.env.settings as { refresh: () => Promise<void> }).refresh = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    audit.mockClear();
    save.mockResolvedValueOnce({ unlinkedAccounts: 3 });
    await expect(put(c, { identity_provider: null })).rejects.toThrow("connection terminated unexpectedly");
    expect(audit.mock.calls.find((call) => call[1].action === "node.settings.update")![1].detail.after).toMatchObject({
      identity_provider: null,
      identity_provider_unlinked_accounts: 3,
    });
    reset.mockResolvedValueOnce({ identityProvider: { issuer: idp.issuer, clientId: "stuga", label: null, scopes: null }, unlinkedAccounts: 2 });
    await expect(
      routeWorkspaceRequest(c, new Request("http://node.test/api/node/settings", { method: "DELETE" })),
    ).rejects.toThrow("connection terminated unexpectedly");
    expect(audit.mock.calls.find((call) => call[1].action === "node.settings.reset")![1].detail).toEqual({
      identity_provider: { issuer: idp.issuer, client_id: "stuga", label: null, scopes: null },
      identity_provider_unlinked_accounts: 2,
    });
  });

  it("reports the stored values, the defaults, one callback URL per origin, and who would be locked out", async () => {
    storedRow.mockResolvedValue(row());
    withoutPassword.mockResolvedValueOnce(2);
    const res = await routeWorkspaceRequest(ctx(), new Request("http://node.test/api/node/settings"));
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.identity_provider).toEqual({
      issuer: idp.issuer,
      client_id: "stuga",
      label: null,
      default_label: new URL(idp.issuer).host,
      scopes: null,
      default_scopes: "openid profile email",
      client_secret_set: false,
      client_secret_label: null,
      client_secret_stale: false,
      callback_urls: ["http://node.test/auth/oidc/callback", "http://nas.local:8787/auth/oidc/callback"],
      accounts_without_password: 2,
    });
    // The sign-in method is no longer a read-only node fact: only the environment's are left.
    expect(Object.keys(body.node as object).sort()).toEqual(
      ["bind", "data_dir", "database", "embedding_dims", "extra_origins", "node_id", "port", "public_origin"],
    );
  });

  it("clears the provider on a reset, and records it with the accounts unlinked", async () => {
    reset.mockResolvedValueOnce({
      identityProvider: { issuer: idp.issuer, clientId: "stuga", label: null, scopes: null },
      unlinkedAccounts: 2,
    });
    const res = await routeWorkspaceRequest(ctx(), new Request("http://node.test/api/node/settings", { method: "DELETE" }));
    expect(res?.status).toBe(200);
    const detail = audit.mock.calls.find((c) => c[1].action === "node.settings.reset")![1].detail;
    expect(detail).toEqual({
      identity_provider: { issuer: idp.issuer, client_id: "stuga", label: null, scopes: null },
      identity_provider_unlinked_accounts: 2,
    });
  });

  it("is never reached out to by the notification test", async () => {
    const req = new Request("http://node.test/api/node/settings/notify-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notify: { sink: "none" }, identity_provider: { issuer: "http://127.0.0.1:1", client_id: "c" } }),
    });
    const res = await routeWorkspaceRequest(ctx(), req);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ ok: true });
  });
});
