/**
 * What the Agents card hands to each client, built only from the node's
 * AgentSetup, so every config names the one origin the node knows itself by.
 * A client stores one Stuga connection, under the product's own name: which
 * node and which workspace a call acts in is the `workspaces` listing's job.
 */
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { MCP_BUNDLE_FILENAME, MCP_SERVER_KEY } from "@stuga/protocol/domain/node-name";

export type ClientTab = "claude" | "claude-desktop" | "claude-code" | "codex" | "antigravity" | "dsh" | "other";

export const TAB_LABEL: Record<ClientTab, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  dsh: "DeepSeek Harness",
  other: "Other clients",
};

/** A config carries this until a key is minted. */
export const TOKEN_PLACEHOLDER = "vk_your_key_here";

/** The web UI's DeepSeek Harness profile is `web`. */
export const DSH_INSTALL_COMMAND = "dsh plugin --profile web add @stuga/dsh-plugin";

/** The `x-stuga-client` label a hand-configured Claude Desktop sends, the same one its extension sends. */
const DESKTOP_CLIENT = "claude-desktop";

/** The hosts whose setup is one command against `/api/agent-install/<client>`. */
export const INSTALLER_CLIENTS = ["codex", "antigravity"] as const;
export type InstallerClient = (typeof INSTALLER_CLIENTS)[number];

/** What a host's tab shows: the script grants nothing, so none of these carry a key. */
export interface InstallerCommands {
  setup: string;
  disconnect: string;
  uninstall: string;
}

/** A hosted connector dials from its own cloud, so it is offered only when the internet can reach the node. */
export function clientTabs(setup: AgentSetup): [ClientTab, ...ClientTab[]] {
  return setup.reachable
    ? ["claude", "claude-desktop", "claude-code", "codex", "antigravity", "dsh", "other"]
    : ["claude-desktop", "claude-code", "codex", "antigravity", "dsh", "other"];
}

interface ClientConfigs {
  mcpUrl: string;
  /** `stuga`: what every config calls this connection, and what Claude Code lists it as. */
  serverKey: string;
  /** The name the downloaded extension is saved under, which the instructions repeat. */
  bundleFilename: string;
  /**
   * Claude Code's one command, at user scope: the node is the person's, not one
   * project's. On a secure origin it signs in through the browser and carries no
   * key; on a plain-http LAN node its OAuth refuses the node's token endpoint, so
   * the command carries a key instead.
   */
  cliCommand: string;
  /** Whether `cliCommand` carries a key, so its tab asks for one first. */
  cliNeedsKey: boolean;
  /** The one-command setup and the two removals, per host that has an installer. */
  installers: Record<InstallerClient, InstallerCommands>;
  /** A streamable-HTTP MCP client's config. */
  httpJson: string;
  /** DeepSeek Harness reads these at launch. */
  dshEnv: string;
  /**
   * Claude Desktop's stdio config, or null when the node names no server file
   * a client on the browser's machine can open: only on a loopback node do the
   * two share a filesystem. Paths are absolute, since desktop clients start
   * servers without a PATH.
   */
  desktopJson: string | null;
}

export function clientConfigs(setup: AgentSetup, token: string | null): ClientConfigs {
  const key = token ?? TOKEN_PLACEHOLDER;
  const entry = setup.loopback ? setup.stdio.entry : null;
  const serverKey = MCP_SERVER_KEY;
  const cliAdd = `claude mcp add -s user --transport http ${serverKey} ${setup.mcp_url}`;
  const installer = (client: InstallerClient): InstallerCommands => {
    const run = (query = "") => `curl -fsSL '${setup.url}/api/agent-install/${client}${query}' | sh`;
    return { setup: run(), disconnect: run("?action=disconnect"), uninstall: run("?action=uninstall") };
  };
  return {
    mcpUrl: setup.mcp_url,
    serverKey,
    bundleFilename: MCP_BUNDLE_FILENAME,
    cliCommand: setup.secure ? cliAdd : `${cliAdd} --header "Authorization: Bearer ${key}"`,
    cliNeedsKey: !setup.secure,
    installers: { codex: installer("codex"), antigravity: installer("antigravity") },
    httpJson: JSON.stringify(
      { mcpServers: { [serverKey]: { type: "http", url: setup.mcp_url, headers: { Authorization: `Bearer ${key}` } } } },
      null,
      2,
    ),
    dshEnv: `STUGA_URL=${setup.url}\nSTUGA_API_KEY=${key}`,
    desktopJson:
      entry === null
        ? null
        : JSON.stringify(
            {
              mcpServers: {
                [serverKey]: {
                  command: setup.stdio.command,
                  args: [entry],
                  env: { STUGA_URL: setup.url, STUGA_TOKEN: key, STUGA_CLIENT: DESKTOP_CLIENT },
                },
              },
            },
            null,
            2,
          ),
  };
}
