#!/usr/bin/env node
/** The stdio MCP server a client launches as a child process; every tool is a REST call to the node. */
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfigFile, resolveConfig } from "./config.js";
import { identifyNode } from "./node.js";
import { buildServer } from "./server.js";

/** Beside this file, not the working directory: clients start servers from anywhere. */
const SIDECAR_CONFIG = new URL("./config.json", import.meta.url);
const HOME_CONFIG = join(homedir(), ".config", "stuga", "credentials.json");

const config = resolveConfig(
  process.env,
  () => readConfigFile(SIDECAR_CONFIG),
  () => readConfigFile(HOME_CONFIG),
);

// Before connecting: the name goes out in the handshake, and the client's first message waits on stdin meanwhile.
identifyNode(config)
  .then((node) => buildServer({ config, node }).connect(new StdioServerTransport()))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
