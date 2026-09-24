/**
 * What a client needs to point an agent at this node. A hosted assistant dials
 * `mcp_url` from its own network, so a loopback or LAN address is useless to it;
 * a local client launches the stdio server with absolute paths, because desktop
 * clients start servers without a usable PATH; and a client that signs in through
 * the browser needs a secure origin, or its config has to carry a key instead.
 */
import { createRequire } from "node:module";
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { isIpLiteral, isLocalName, isLoopbackHost, isNonPublicAddress } from "../net/addresses.js";
import { json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/** A host only a machine on the same network can resolve; a single dotless label counts. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) return isNonPublicAddress(host);
  return isLocalName(host) || !host.includes(".");
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * https, or plain http to loopback: what a browser calls a secure context, and
 * what an OAuth client requires of a token endpoint before it will send a
 * credential to it. A plain-http LAN node is neither.
 */
export function isSecureOrigin(origin: string): boolean {
  if (isLoopbackOrigin(origin)) return true;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

/** An origin that does not parse counts as unreachable. */
export function reachableFromInternet(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return !isPrivateHost(hostname);
}

/** The single-file stdio server, through @stuga/mcp's `./bundle` export; null when it has not been built. */
export function mcpBundlePath(): string | null {
  try {
    return createRequire(import.meta.url).resolve("@stuga/mcp/bundle");
  } catch {
    return null;
  }
}

export interface AgentSetupProbe {
  command?: string;
  /** STUGA_STDIO_ENTRY: a path for local stdio clients, "" for none, undefined to use the bundle. */
  stdioEntry?: string;
  bundlePath?: string | null;
}

export function agentSetup(publicOrigin: string, node: { id: string; name: string }, probe: AgentSetupProbe = {}): AgentSetup {
  const bundlePath = probe.bundlePath !== undefined ? probe.bundlePath : mcpBundlePath();
  const entry = probe.stdioEntry !== undefined ? probe.stdioEntry.trim() || null : bundlePath;
  return {
    url: publicOrigin,
    mcp_url: `${publicOrigin}/mcp`,
    node: { id: node.id, name: node.name },
    reachable: reachableFromInternet(publicOrigin),
    loopback: isLoopbackOrigin(publicOrigin),
    secure: isSecureOrigin(publicOrigin),
    bundle: { available: bundlePath !== null },
    // The interpreter running this node is the one known to be installed.
    stdio: { command: probe.command ?? process.execPath, entry },
  };
}

/** GET /api/agent-setup: any member or API key may read it, the same answer for both; it describes this node and carries no secret. */
export async function getAgentSetup({ ctx }: WorkspaceCall): Promise<Response> {
  const node = { id: ctx.env.nodeId, name: ctx.env.settings.current().nodeLabel };
  return json(agentSetup(ctx.env.publicOrigin, node, { stdioEntry: ctx.env.stdioEntry }));
}
