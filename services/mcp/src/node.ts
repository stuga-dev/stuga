/**
 * Which node this server speaks for, as the client and the model are told: the
 * name and public origin the node answers now on its public /auth/config, which
 * are the ones its own /mcp states, else the name the installer wrote down and
 * the URL this server was given. The node is asked once, at startup, and
 * briefly: one that does not answer must not hold up the client's launch.
 */
import { MAX_NODE_NAME_CHARS, UNSAFE_TEXT, hasVisibleText, hostLabel } from "@stuga/protocol/domain/node-name";
import type { ResolvedConfig } from "./config.js";

export const NODE_NAME_TIMEOUT_MS = 2000;

export interface NodeIdentity {
  name: string;
  origin: string;
}

/** Without asking the node. */
export function configuredNode(config: ResolvedConfig): NodeIdentity {
  let url: URL | null = null;
  try {
    url = new URL(config.url);
  } catch {
    // Every call will fail too; the model is still told what the server was pointed at.
  }
  return { name: config.nodeName || (url ? hostLabel(url.origin) : config.url), origin: url?.origin ?? config.url };
}

/**
 * The node's answer wins: a rename after the install still reaches the model,
 * and a server given another address of the node (a loopback, a LAN name) still
 * introduces it by the origin /mcp does, so both describe one node alike.
 */
export async function identifyNode(
  config: ResolvedConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = NODE_NAME_TIMEOUT_MS,
): Promise<NodeIdentity> {
  const configured = configuredNode(config);
  try {
    const res = await fetchImpl(`${config.url}/auth/config`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return configured;
    const body = (await res.json()) as unknown;
    return { name: announcedName(body) ?? configured.name, origin: announcedOrigin(body) ?? configured.origin };
  } catch {
    return configured;
  }
}

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;

/** The label the node tells nodes apart by: its name, else its host. Taken as it is; anything else is not a Stuga node's answer. */
function announcedName(body: unknown): string | null {
  const name = field(body, "node_label");
  if (typeof name !== "string") return null;
  const ok = name.trim() !== "" && name.length <= MAX_NODE_NAME_CHARS && !UNSAFE_TEXT.test(name) && hasVisibleText(name);
  return ok ? name : null;
}

/** An http(s) origin and nothing more, as the node's PUBLIC_ORIGIN is. */
function announcedOrigin(body: unknown): string | null {
  const origin = field(body, "origin");
  if (typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}
