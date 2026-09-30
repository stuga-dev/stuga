import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { ConfigError, parseConfig, parseOpsConfig, type Env } from "./env.js";

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

  it("keeps the setup code in the data directory unless packaging names a file", () => {
    expect(cfg().setupCodeFile).toBeUndefined();
    expect(cfg({ SETUP_CODE_FILE: "/opt/stuga/setup/setup-code" }).setupCodeFile).toBe("/opt/stuga/setup/setup-code");
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

  it("offers remote access only with both of its hints", () => {
    expect(cfg().remote).toBeUndefined();
    expect(cfg({ STUGA_REMOTE_SERVICE: "https://api.stuga.dev/", STUGA_REMOTE_DIR: "/Users/liv/.stuga-remote/" }).remote).toEqual({
      service: "https://api.stuga.dev",
      dir: "/Users/liv/.stuga-remote",
    });
  });

  it("says so once, and leaves remote access off, when packaging sets one hint without the other", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(cfg({ STUGA_REMOTE_SERVICE: "https://api.stuga.dev" }).remote).toBeUndefined();
      expect(cfg({ STUGA_REMOTE_DIR: "/Users/liv/.stuga-remote" }).remote).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![0]).toContain("STUGA_REMOTE_DIR");
    } finally {
      warn.mockRestore();
    }
  });

  it("takes the remote-access service over https only, or plain HTTP on loopback for tests", () => {
    const dir = { STUGA_REMOTE_DIR: "/Users/liv/.stuga-remote" };
    expect(cfg({ ...dir, STUGA_REMOTE_SERVICE: "http://127.0.0.1:18080" }).remote?.service).toBe("http://127.0.0.1:18080");
    expect(cfg({ ...dir, STUGA_REMOTE_SERVICE: "http://localhost:18080" }).remote?.service).toBe("http://localhost:18080");
    for (const bad of ["http://api.stuga.dev", "api.stuga.dev", "https://api.stuga.dev/v1", "https://api.stuga.dev/?x=1", "https://liv:pw@api.stuga.dev"]) {
      expect(() => cfg({ ...dir, STUGA_REMOTE_SERVICE: bad }), bad).toThrow(ConfigError);
    }
  });

  it("takes the connector's pair beside the remote hints, both or neither, as absolute paths", () => {
    const remote = { STUGA_REMOTE_SERVICE: "https://api.stuga.dev", STUGA_REMOTE_DIR: "/Library/Application Support/Stuga/remote" };
    const pair = {
      STUGA_CONNECTOR_REQUEST: "/Library/Application Support/Stuga/requests/remote",
      STUGA_CONNECTOR_STATUS: "/Library/Application Support/Stuga/status/remote.json",
    };
    expect(cfg({ ...remote, ...pair }).remote?.connector).toEqual({
      request: "/Library/Application Support/Stuga/requests/remote",
      status: "/Library/Application Support/Stuga/status/remote.json",
    });
    expect(cfg(remote).remote?.connector).toBeUndefined();
    // Without the remote hints the pair means nothing.
    expect(cfg(pair).remote).toBeUndefined();
    expect(() => cfg({ ...remote, ...pair, STUGA_CONNECTOR_STATUS: "status/remote.json" })).toThrow(/STUGA_CONNECTOR_STATUS must be an absolute path/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(cfg({ ...remote, STUGA_CONNECTOR_REQUEST: pair.STUGA_CONNECTOR_REQUEST }).remote).toMatchObject({ dir: remote.STUGA_REMOTE_DIR });
      expect(cfg({ ...remote, STUGA_CONNECTOR_REQUEST: pair.STUGA_CONNECTOR_REQUEST }).remote?.connector).toBeUndefined();
      expect(warn.mock.calls[0]![0]).toContain("STUGA_CONNECTOR_STATUS");
    } finally {
      warn.mockRestore();
    }
  });

  it("takes the connector's group and user beside the remote hints, both or neither, as ids", () => {
    const remote = { STUGA_REMOTE_SERVICE: "https://api.stuga.dev", STUGA_REMOTE_DIR: "/run/stuga-remote" };
    const pair = { STUGA_REMOTE_GID: "65532", STUGA_REMOTE_CONNECTOR_UID: "65532" };
    expect(cfg({ ...remote, ...pair }).remote?.group).toEqual({ gid: 65532, connectorUid: 65532 });
    expect(cfg({ ...remote, STUGA_REMOTE_GID: "0", STUGA_REMOTE_CONNECTOR_UID: "4294967294" }).remote?.group).toEqual({ gid: 0, connectorUid: 4294967294 });
    expect(cfg(remote).remote?.group).toBeUndefined();
    expect(cfg(pair).remote).toBeUndefined();
    for (const bad of ["-1", "65532.0", "stuga", "4294967295"]) {
      expect(() => cfg({ ...remote, ...pair, STUGA_REMOTE_GID: bad }), bad).toThrow(ConfigError);
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(cfg({ ...remote, STUGA_REMOTE_GID: "65532" }).remote).toMatchObject({ dir: "/run/stuga-remote" });
      expect(cfg({ ...remote, STUGA_REMOTE_GID: "65532" }).remote?.group).toBeUndefined();
      expect(warn.mock.calls[0]![0]).toContain("STUGA_REMOTE_CONNECTOR_UID");
    } finally {
      warn.mockRestore();
    }
  });

  it("needs an absolute STUGA_REMOTE_DIR, since an env file does not expand ~", () => {
    const service = { STUGA_REMOTE_SERVICE: "https://api.stuga.dev" };
    for (const bad of ["~/.stuga-remote", ".stuga-remote", "remote/dir"]) {
      expect(() => cfg({ ...service, STUGA_REMOTE_DIR: bad }), bad).toThrow(/absolute/);
    }
  });
});

describe("parseOpsConfig", () => {
  it("reads the same required variables as the node", () => {
    expect(() => parseOpsConfig({ DATABASE_URL: BASE["DATABASE_URL"] })).toThrow(/DATA_DIR/);
    expect(parseOpsConfig(BASE)).toMatchObject({ dataDir: "/srv/stuga/data", publicOrigin: "http://localhost:8787" });
  });
});
