/**
 * The operator's environment, parsed once at boot. Only bootstrap, network,
 * secret and packaging settings live here; everything the Settings page edits
 * lives in the database (see ./settings).
 */
import { join, resolve } from "node:path";
import type { AiProvider } from "@stuga/ai";
import type { AuthConfig } from "@stuga/auth";
import { EMBEDDING_DIMS, MAX_EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { SEARCH_LANGUAGES, type SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { APP_ROOT } from "../app-root.js";
import type { NodeConfig } from "../env.js";
import { loadOrCreateInternalSecret } from "./secrets.js";

export type Env = Record<string, string | undefined>;

/** `NodeConfig` plus the listener settings only the boot path reads. */
interface NodeBootConfig extends NodeConfig {
  /** Directory of `<host>/fullchain.pem` + `privkey.pem`; set, the node serves https. */
  tlsCertDir?: string;
  webDistDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_PUBLIC_ORIGIN = "http://localhost:8787";
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
/** The releases of stuga-dev/samples, whose newest lists the sample workspaces. */
const DEFAULT_SAMPLES_URL = "https://github.com/stuga-dev/samples/releases";
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 2_592_000;
/** Absorbs a renewal whose response was lost in flight; a stolen token is still worthless minutes later. */
const DEFAULT_REFRESH_ROTATION_GRACE_SECONDS = 60;
const LOCAL_TOKEN_AUDIENCE = "stuga";

/** Shown after an environment change when packaging names nothing better (STUGA_RESTART_HINT). */
const DEFAULT_RESTART_HINT = "Restart the node to apply.";
/** Shown beside a newer version when packaging names nothing better (STUGA_UPGRADE_HINT). */
const DEFAULT_UPGRADE_HINT = "Upgrade on the machine that runs the node.";

// ---- value helpers ---------------------------------------------------------

function str(env: Env, name: string): string | undefined {
  const t = env[name]?.trim();
  return t ? t : undefined;
}

function int(env: Env, name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  const n = Number(raw);
  if (opts.min !== undefined && n < opts.min) throw new ConfigError(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new ConfigError(`${name} must be at most ${opts.max}`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = str(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase() as T;
  if (!allowed.includes(v)) throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return v;
}

/** A comma-separated list, each entry checked against `allowed` and deduped. */
function list<T extends string>(env: Env, name: string, allowed: readonly T[]): T[] {
  const raw = str(env, name);
  if (raw === undefined) return [];
  const out = new Set<T>();
  for (const entry of raw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)) {
    if (!allowed.includes(entry as T)) {
      throw new ConfigError(`${name} entries must be one of ${allowed.join(", ")}, got "${entry}"`);
    }
    out.add(entry as T);
  }
  return [...out];
}

function httpUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return url;
}

function origin(env: Env, name: string, fallback: string): string {
  return httpUrl(name, str(env, name) ?? fallback).origin;
}

/**
 * A comma-separated list of exact origins. Consulted before answering a
 * credentialed cross-origin request, so a pattern is refused: the URL parser
 * would otherwise accept `https://*.x` as a literal host that never matches.
 */
function parseOriginList(env: Env, name: string): string[] {
  const out: string[] = [];
  for (const entry of (str(env, name) ?? "").split(",").map((v) => v.trim()).filter(Boolean)) {
    if (entry.includes("*")) {
      throw new ConfigError(`${name} takes exact origins, not patterns; "${entry}" contains a wildcard`);
    }
    const url = httpUrl(name, entry);
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  return out;
}

/** A base URL whose path is load-bearing (`https://host/v1`), without trailing slashes. */
function baseUrl(env: Env, name: string, fallback: string): string {
  const raw = str(env, name) ?? fallback;
  httpUrl(name, raw);
  return raw.replace(/\/+$/, "");
}

/** A base the node appends paths to: no credentials, query or fragment, and no trailing slash. */
function pathBase(env: Env, name: string, fallback: string): string {
  const raw = str(env, name) ?? fallback;
  const url = httpUrl(name, raw);
  if (url.username || url.password || /[?#]/.test(raw)) {
    throw new ConfigError(`${name} must be an http(s) URL without credentials, a query or a fragment, got "${raw}"`);
  }
  return url.href.replace(/\/+$/, "");
}

// ---- parsers ---------------------------------------------------------------

function requiredDatabaseUrl(env: Env): string {
  const databaseUrl = str(env, "DATABASE_URL");
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is required (postgres://user:pass@host:5432/stuga)");
  return databaseUrl;
}

function requiredDataDir(env: Env): string {
  const dataDir = str(env, "DATA_DIR");
  if (!dataDir) throw new ConfigError("DATA_DIR is required: the directory that holds the node's blobs, actor stores and keys");
  return resolve(dataDir);
}

/** The part of the node's configuration the operator commands read. */
export interface OpsConfig {
  databaseUrl: string;
  dataDir: string;
  publicOrigin: string;
  embeddingDims: number;
}

/**
 * The variables the operator commands share with the node, and nothing else.
 * Never touches the data directory: a backup or restore that wrote into the
 * directory it is copying or replacing would change what it copies.
 */
export function parseOpsConfig(env: Env = process.env): OpsConfig {
  return {
    databaseUrl: requiredDatabaseUrl(env),
    dataDir: requiredDataDir(env),
    publicOrigin: origin(env, "PUBLIC_ORIGIN", DEFAULT_PUBLIC_ORIGIN),
    embeddingDims: int(env, "AI_EMBED_DIMS", EMBEDDING_DIMS, { min: 1, max: MAX_EMBEDDING_DIMS }),
  };
}

/**
 * SEARCH_LANGUAGES, which chose the search languages before they were a node
 * setting, in the order the setting keeps. Read only by the boot of a node that
 * has never chosen, which adopts it; null when it is not set.
 */
export function legacySearchLanguages(env: Env): SearchLanguage[] | null {
  if (str(env, "SEARCH_LANGUAGES") === undefined) return null;
  const listed = list(env, "SEARCH_LANGUAGES", SEARCH_LANGUAGES);
  return SEARCH_LANGUAGES.filter((l) => listed.includes(l));
}

/** The node's own sessions. An identity provider is a node setting, not an environment variable. */
function authConfig(env: Env, ops: OpsConfig): AuthConfig {
  return {
    issuer: ops.publicOrigin,
    audience: LOCAL_TOKEN_AUDIENCE,
    keyFile: resolve(str(env, "NODE_SIGNING_KEY") ?? resolve(ops.dataDir, "identity", "signing.jwk")),
    accessTokenTtlSeconds: int(env, "ACCESS_TOKEN_TTL_SECONDS", DEFAULT_ACCESS_TOKEN_TTL_SECONDS, { min: 60 }),
    refreshTokenTtlSeconds: int(env, "REFRESH_TOKEN_TTL_SECONDS", DEFAULT_REFRESH_TOKEN_TTL_SECONDS, { min: 60 }),
    // 0 disables the grace window.
    refreshRotationGraceSeconds: int(env, "REFRESH_ROTATION_GRACE_SECONDS", DEFAULT_REFRESH_ROTATION_GRACE_SECONDS, { min: 0 }),
  };
}

function sameSite(env: Env): NodeConfig["mediaCookieSameSite"] {
  const v = oneOf(env, "MEDIA_COOKIE_SAMESITE", ["lax", "strict", "none"] as const, "lax");
  return v === "lax" ? "Lax" : v === "strict" ? "Strict" : "None";
}

/**
 * Parse the environment. Pure apart from the internal secret, generated under
 * the data directory on first boot unless `internalSecret` is passed.
 */
export function parseConfig(env: Env = process.env, opts: { internalSecret?: string } = {}): NodeBootConfig {
  const ops = parseOpsConfig(env);
  const cfg: NodeBootConfig = {
    publicOrigin: ops.publicOrigin,
    extraOrigins: parseOriginList(env, "EXTRA_ORIGINS").filter((o) => o !== ops.publicOrigin),
    databaseUrl: ops.databaseUrl,
    dataDir: ops.dataDir,
    bind: str(env, "BIND") ?? DEFAULT_BIND,
    port: int(env, "PORT", DEFAULT_PORT, { min: 0, max: 65535 }),
    auth: authConfig(env, ops),
    embeddingDims: ops.embeddingDims,
    internalSecret: opts.internalSecret ?? loadOrCreateInternalSecret(ops.dataDir),
    mediaCookieSameSite: sameSite(env),
    // Off by default: a node published straight onto a port receives whatever
    // the client writes there, and the auth throttle keys on the address.
    trustProxyHeaders: bool(env, "TRUST_PROXY_HEADERS", false),
    webDistDir: resolve(str(env, "WEB_DIST_DIR") ?? join(APP_ROOT, "apps", "web", "dist")),
    restartHint: str(env, "STUGA_RESTART_HINT") ?? DEFAULT_RESTART_HINT,
    upgradeHint: str(env, "STUGA_UPGRADE_HINT") ?? DEFAULT_UPGRADE_HINT,
    stdioEntry: env.STUGA_STDIO_ENTRY,
    aiProviderBaseUrls: providerBaseUrls(baseUrl(env, "AI_OLLAMA_DEFAULT_URL", DEFAULT_OLLAMA_URL)),
    samplesUrl: pathBase(env, "SAMPLES_URL", DEFAULT_SAMPLES_URL),
  };
  const tlsCertDir = str(env, "TLS_CERT_DIR");
  if (tlsCertDir) cfg.tlsCertDir = resolve(tlsCertDir);
  const requests = str(env, "STUGA_UPGRADE_REQUESTS");
  const status = str(env, "STUGA_UPGRADE_STATUS");
  if (requests && status) cfg.upgradeHelper = { requests: resolve(requests), status: resolve(status) };
  return cfg;
}

/** Where each provider listens when a settings row names no base URL. */
function providerBaseUrls(ollama: string): Readonly<Record<AiProvider, string>> {
  return Object.freeze({
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com/v1",
    ollama,
  });
}
