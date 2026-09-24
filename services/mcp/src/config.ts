/**
 * Which node this server talks to, and as whom: the environment, then the
 * config file beside this server (an installed extension's own credential),
 * then ~/.config/stuga/credentials.json, then defaults. Reading is injected.
 * A credential the environment holds whole is never mixed with a file's, but
 * the file beside the server may still name the node it came from.
 */
import { readFileSync } from "node:fs";

export const DEFAULT_URL = "http://127.0.0.1:8787";
/** Sent as `x-stuga-client` when nothing names the client that spawned this server. */
export const DEFAULT_CLIENT = "stuga-mcp";
export const DEV_VERSION = "0.0.0-dev";

export interface StoredConfig {
  url?: string;
  token?: string;
  workspace?: string;
  model?: string;
  client?: string;
  version?: string;
  node_name?: string;
}

export interface ResolvedConfig {
  url: string;
  token: string;
  workspace?: string;
  model?: string;
  client: string;
  /** The version of the node that installed this server. */
  version: string;
  /** The node's name as the installer wrote it down, for when the node cannot be asked. */
  nodeName?: string;
}

const FIELDS = ["url", "token", "workspace", "model", "client", "version", "node_name"] as const;

/** A field of the wrong type counts as absent, so a half-written file costs one setting, not the server. */
export function parseConfig(raw: unknown): StoredConfig {
  if (raw === null || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const config: StoredConfig = {};
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value === "string") config[field] = value;
  }
  return config;
}

/** One config file; missing, unreadable and malformed all read as empty. */
export function readConfigFile(
  path: string | URL,
  read: (path: string | URL) => string = (p) => readFileSync(p, "utf8"),
): StoredConfig {
  try {
    return parseConfig(JSON.parse(read(path)));
  } catch {
    return {};
  }
}

/**
 * Settle every setting. With both halves of the credential in the environment,
 * only the file beside the server is opened, only for the node's name, only
 * when the environment has none, and only if that file names the same node.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, sidecar: () => StoredConfig, home: () => StoredConfig): ResolvedConfig {
  const credentialInEnv = env.STUGA_URL != null && env.STUGA_TOKEN != null;
  const files = credentialInEnv ? [] : [sidecar(), home()];
  const fromFiles = (field: keyof StoredConfig): string | undefined => {
    for (const file of files) {
      if (file[field] != null) return file[field];
    }
    return undefined;
  };
  return {
    url: env.STUGA_URL ?? fromFiles("url") ?? DEFAULT_URL,
    // An unauthenticated request gets the node's 401, which says more than a crash at startup.
    token: env.STUGA_TOKEN ?? fromFiles("token") ?? "",
    workspace: env.STUGA_WORKSPACE ?? fromFiles("workspace"),
    model: env.STUGA_MODEL ?? fromFiles("model"),
    client: env.STUGA_CLIENT ?? fromFiles("client") ?? DEFAULT_CLIENT,
    version: env.STUGA_VERSION?.trim() || fromFiles("version")?.trim() || DEV_VERSION,
    nodeName:
      env.STUGA_NODE_NAME?.trim() || (credentialInEnv ? sidecarName(env.STUGA_URL!, sidecar) : fromFiles("node_name"))?.trim() || undefined,
  };
}

/**
 * The extension leaves a name with `$` out of its launch environment, which
 * cannot carry one, and writes it only to the file beside the server; without
 * this the server would call the node by its host whenever the node is down.
 */
function sidecarName(url: string, sidecar: () => StoredConfig): string | undefined {
  const file = sidecar();
  return file.url === url ? file.node_name : undefined;
}
