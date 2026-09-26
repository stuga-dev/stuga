import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { ConfigError, legacySearchLanguages, parseConfig, parseOpsConfig, type Env } from "./env.js";

const BASE: Env = { DATABASE_URL: "postgres://stuga@localhost:5432/stuga", DATA_DIR: "/srv/stuga/data" };

function cfg(extra: Env = {}) {
  return parseConfig({ ...BASE, ...extra }, { internalSecret: "test-secret" });
}

describe("parseConfig", () => {
  it("requires DATABASE_URL and DATA_DIR and nothing else", () => {
    expect(() => parseConfig({}, { internalSecret: "s" })).toThrow(ConfigError);
    expect(() => parseConfig({ DATABASE_URL: BASE["DATABASE_URL"] }, { internalSecret: "s" })).toThrow(/DATA_DIR/);
    expect(() => parseConfig({ DATA_DIR: "/srv/stuga/data" }, { internalSecret: "s" })).toThrow(/DATABASE_URL/);
    const c = cfg();
    expect(c.databaseUrl).toBe(BASE["DATABASE_URL"]);
    expect(c.publicOrigin).toBe("http://localhost:8787");
    expect(c.bind).toBe("127.0.0.1");
    expect(c.port).toBe(8787);
    expect(c.dataDir).toBe("/srv/stuga/data");
    expect(c.mediaCookieSameSite).toBe("Lax");
    expect(c.embeddingDims).toBe(1024);
    expect(c.tlsCertDir).toBeUndefined();
  });

  it("normalises PUBLIC_ORIGIN to an origin and rejects junk", () => {
    expect(cfg({ PUBLIC_ORIGIN: "https://stuga.example/app/" }).publicOrigin).toBe("https://stuga.example");
    expect(() => cfg({ PUBLIC_ORIGIN: "not a url" })).toThrow(ConfigError);
    expect(() => cfg({ PUBLIC_ORIGIN: "ftp://x" })).toThrow(ConfigError);
  });

  it("parses EXTRA_ORIGINS into exact origins, and defaults to none", () => {
    expect(cfg().extraOrigins).toEqual([]);
    expect(cfg({ EXTRA_ORIGINS: "https://nas.local" }).extraOrigins).toEqual(["https://nas.local"]);
    expect(cfg({ EXTRA_ORIGINS: " https://nas.local/app , http://192.168.1.50:8787 , https://nas.local " }).extraOrigins).toEqual([
      "https://nas.local",
      "http://192.168.1.50:8787",
    ]);
  });

  it("drops the public origin from the list, which is always allowed on its own", () => {
    expect(cfg({ EXTRA_ORIGINS: "http://localhost:8787" }).extraOrigins).toEqual([]);
    expect(cfg({ PUBLIC_ORIGIN: "http://n.test", EXTRA_ORIGINS: "http://n.test, https://other.test" }).extraOrigins).toEqual([
      "https://other.test",
    ]);
  });

  it("refuses wildcards and junk in EXTRA_ORIGINS", () => {
    expect(() => cfg({ EXTRA_ORIGINS: "*" })).toThrow(/wildcard/);
    expect(() => cfg({ EXTRA_ORIGINS: "https://*.example.test" })).toThrow(/wildcard/);
    expect(() => cfg({ EXTRA_ORIGINS: "localhost:8787" })).toThrow(ConfigError);
    expect(() => cfg({ EXTRA_ORIGINS: "http://ok.test, nonsense" })).toThrow(ConfigError);
    expect(() => cfg({ EXTRA_ORIGINS: "ftp://files.test" })).toThrow(ConfigError);
  });

  it("rejects malformed numbers and enums", () => {
    expect(() => cfg({ PORT: "http" })).toThrow(ConfigError);
    expect(() => cfg({ PORT: "70000" })).toThrow(ConfigError);
    expect(() => cfg({ TRUST_PROXY_HEADERS: "maybe" })).toThrow(ConfigError);
    expect(() => cfg({ AI_EMBED_DIMS: "0" })).toThrow(ConfigError);
  });

  it("accepts an embedding width up to what the vector index can hold, and refuses one past it", () => {
    expect(cfg({ AI_EMBED_DIMS: String(MAX_EMBEDDING_DIMS) }).embeddingDims).toBe(MAX_EMBEDDING_DIMS);
    expect(() => cfg({ AI_EMBED_DIMS: String(MAX_EMBEDDING_DIMS + 1) })).toThrow(ConfigError);
    expect(() => cfg({ AI_EMBED_DIMS: "16000" })).toThrow(/at most 2000/);
  });

  it("makes the node the issuer of its own sessions, with nothing to choose", () => {
    const c = cfg({ PUBLIC_ORIGIN: "https://n.example" });
    expect(c.auth).not.toHaveProperty("mode");
    expect(c.auth).toMatchObject({
      issuer: "https://n.example",
      audience: "stuga",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2_592_000,
      refreshRotationGraceSeconds: 60,
    });
    expect(c.auth.keyFile).toBe(resolve(c.dataDir, "identity", "signing.jwk"));
  });

  it("honours NODE_SIGNING_KEY", () => {
    const c = cfg({ NODE_SIGNING_KEY: "/keys/node.jwk" });
    expect(c.auth.keyFile).toBe("/keys/node.jwk");
  });

  it("has no signup policy to read: after the first account, accounts come only from invite links", () => {
    expect(cfg({ SIGNUP: "open" })).not.toHaveProperty("signup");
  });

  it("reads no setting the Settings page owns", () => {
    const c = cfg({ AI_ENABLED: "true", AI_CHAT_MODEL: "m", MAX_BODY_BYTES: "1", NOTIFY_SINK: "slack", AUDIT_RETENTION_DAYS: "x" });
    expect(c).not.toHaveProperty("ai");
    expect(c).not.toHaveProperty("notify");
    expect(c).not.toHaveProperty("maxBodyBytes");
    expect(c).not.toHaveProperty("auditRetentionDays");
  });
});

describe("the platform hints packaging may set", () => {
  it("serves the repository's web build unless packaging places it elsewhere", () => {
    expect(cfg().webDistDir).toMatch(/apps[/\\]web[/\\]dist$/);
    expect(cfg({ WEB_DIST_DIR: "/opt/stuga/web" }).webDistDir).toBe("/opt/stuga/web");
  });

  it("tells an operator how an environment change lands, in a sentence packaging may replace", () => {
    expect(cfg().restartHint).toBe("Restart the node to apply.");
    expect(cfg({ STUGA_RESTART_HINT: "Restart the Stuga service to apply." }).restartHint).toBe(
      "Restart the Stuga service to apply.",
    );
  });

  it("tells an operator how to move to a newer version, in a sentence packaging may replace", () => {
    expect(cfg().upgradeHint).toBe("Upgrade on the machine that runs the node.");
    expect(cfg({ STUGA_UPGRADE_HINT: "Run ./stuga upgrade." }).upgradeHint).toBe("Run ./stuga upgrade.");
  });

  it("keeps an empty STUGA_STDIO_ENTRY distinct from an unset one", () => {
    expect(cfg().stdioEntry).toBeUndefined();
    expect(cfg({ STUGA_STDIO_ENTRY: "" }).stdioEntry).toBe("");
  });

  it("points the Ollama provider default at AI_OLLAMA_DEFAULT_URL, keeping its path", () => {
    expect(cfg().aiProviderBaseUrls).toEqual({
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com/v1",
      ollama: "http://127.0.0.1:11434",
    });
    expect(cfg({ AI_OLLAMA_DEFAULT_URL: "http://ollama.lan:11434/" }).aiProviderBaseUrls.ollama).toBe(
      "http://ollama.lan:11434",
    );
    expect(cfg({ AI_OLLAMA_DEFAULT_URL: "http://gpu.lan/ollama" }).aiProviderBaseUrls.ollama).toBe("http://gpu.lan/ollama");
    expect(() => cfg({ AI_OLLAMA_DEFAULT_URL: "gpu.lan:11434" })).toThrow(ConfigError);
  });

  it("reads the samples from stuga-dev/samples' releases unless SAMPLES_URL names a mirror", () => {
    expect(cfg().samplesUrl).toBe("https://github.com/stuga-dev/samples/releases");
    expect(cfg({ SAMPLES_URL: "http://mirror.lan/stuga/samples/" }).samplesUrl).toBe("http://mirror.lan/stuga/samples");
    expect(cfg({ SAMPLES_URL: "HTTPS://Mirror.LAN" }).samplesUrl).toBe("https://mirror.lan");
    for (const bad of ["mirror.lan/samples", "ftp://mirror.lan", "https://mirror.lan/?tag=1", "https://mirror.lan/#x", "https://liv:pw@mirror.lan"]) {
      expect(() => cfg({ SAMPLES_URL: bad }), bad).toThrow(ConfigError);
    }
  });
});

describe("parseOpsConfig", () => {
  it("reads the same required variables as the node", () => {
    expect(() => parseOpsConfig({ DATABASE_URL: BASE["DATABASE_URL"] })).toThrow(/DATA_DIR/);
    expect(parseOpsConfig(BASE)).toMatchObject({ dataDir: "/srv/stuga/data", publicOrigin: "http://localhost:8787" });
  });
});

describe("legacySearchLanguages", () => {
  it("is null when SEARCH_LANGUAGES is not set, and the languages it lists when it is", () => {
    expect(legacySearchLanguages(BASE)).toBeNull();
    expect(legacySearchLanguages({ ...BASE, SEARCH_LANGUAGES: "  " })).toBeNull();
    expect(legacySearchLanguages({ ...BASE, SEARCH_LANGUAGES: "KO, ar,ko" })).toEqual(["ko", "ar"]);
    expect(legacySearchLanguages({ ...BASE, SEARCH_LANGUAGES: "," })).toEqual([]);
  });

  it("refuses a language it does not know", () => {
    expect(() => legacySearchLanguages({ ...BASE, SEARCH_LANGUAGES: "ko,fr" })).toThrow(/SEARCH_LANGUAGES entries must be one of ko, ar/);
  });

  it("is no longer part of the node's configuration", () => {
    expect(cfg({ SEARCH_LANGUAGES: "ko" })).not.toHaveProperty("searchLanguages");
    expect(parseOpsConfig({ ...BASE, SEARCH_LANGUAGES: "ko" })).not.toHaveProperty("searchLanguages");
  });
});
