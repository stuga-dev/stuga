import { readFile as fsReadFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildInstructions } from "@stuga/agent-surface/instructions";
import { registerAgentTools } from "@stuga/agent-surface/register";
import { MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";
import type { ResolvedConfig } from "./config.js";
import { configuredNode, type NodeIdentity } from "./node.js";
import { restBackend } from "./rest-backend.js";

export interface ServerDeps {
  config: ResolvedConfig;
  /** The node as `identifyNode` found it at startup; without it, what the config carries. */
  node?: NodeIdentity;
  fetch?: typeof globalThis.fetch;
  /** How `import` with `file` reads the file. */
  readFile?: (path: string) => Promise<Uint8Array>;
}

/** The stdio server with every tool registered, built without connecting a transport. */
export function buildServer({
  config,
  node = configuredNode(config),
  fetch = globalThis.fetch,
  readFile = (p) => fsReadFile(p),
}: ServerDeps): McpServer {
  // One name for the product. Which node this is, and which workspaces it reaches, are in the
  // instructions and in `workspaces` action:list, where the model can act on them.
  const server = new McpServer(
    { name: "stuga", title: MCP_SERVER_TITLE, version: config.version },
    { instructions: buildInstructions({ variant: "stdio", node }) },
  );
  registerAgentTools(server, restBackend({ config, node, fetch, readFile }), "stdio");
  return server;
}
