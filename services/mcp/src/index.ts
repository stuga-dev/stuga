#!/usr/bin/env node
/** The stdio MCP server a desktop client launches as a child process: a proxy to one node's /mcp. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CLIENT, readConfigFile, resolveConfig } from "./config.js";
import { identifyNode } from "./node.js";
import { buildProxy, within } from "./proxy.js";
import { CredentialFile, NodeSignIn } from "./sign-in.js";
import { Upstream } from "./upstream.js";

/** Beside this file, not the working directory: clients start servers from anywhere. */
const SIDECAR_CONFIG = new URL("./config.json", import.meta.url);
const CONFIG_DIR = join(homedir(), ".config", "stuga");
/** How long the handshake waits for the node, so the instructions the client keeps are the node's own. */
const STARTUP_WAIT_MS = 3000;

const config = resolveConfig(
  process.env,
  () => readConfigFile(SIDECAR_CONFIG),
  () => readConfigFile(join(CONFIG_DIR, "credentials.json")),
);

/** What the node lists this connection as until the person renames it. */
const CLIENT_NAMES = new Map([
  ["claude-desktop", "Claude Desktop"],
  ["claude", "Claude"],
  [DEFAULT_CLIENT, "Stuga local connector"],
]);
const clientName = CLIENT_NAMES.get(config.client) ?? config.client;

async function main(): Promise<void> {
  const signIn = config.token
    ? null
    : new NodeSignIn({ nodeUrl: config.url, clientName, store: new CredentialFile(join(CONFIG_DIR, "oauth.json")) });
  await signIn?.listen();
  let server: Server | null = null;
  let announce = false;
  // A connection that finished after the handshake brings its tools with a list-changed notice.
  const upstream = new Upstream(config, signIn, () => {
    if (announce) void server?.sendToolListChanged().catch(() => undefined);
  });
  const node = await identifyNode(config);
  // Until stdio is connected nothing else holds the process open: the sign-in listener and every timer are unref'd.
  const hold = setTimeout(() => undefined, STARTUP_WAIT_MS);
  const early = await within(upstream.ready(), STARTUP_WAIT_MS).catch(() => null);
  clearTimeout(hold);
  // From here on every (re)connection may change the tools, and the client re-lists on the notice.
  announce = true;
  server = buildProxy({ config, node, upstream, instructions: early?.getInstructions() });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
