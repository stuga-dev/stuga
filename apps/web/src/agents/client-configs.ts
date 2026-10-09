/**
 * What the Agents card hands to each client, built only from the node's
 * AgentSetup, so every config names an origin the node knows itself by: a
 * hosted client the remote address while it is on, a client on the browser's
 * machine the address the page was opened at. A client stores one Stuga
 * connection, under the product's own name: which node and which workspace a
 * call acts in is the `workspaces` listing's job.
 */
import type { AgentSetup } from "@stuga/protocol/api/agent-setup";
import { MCP_BUNDLE_FILENAME, MCP_SERVER_KEY } from "@stuga/protocol/domain/node-name";
import { t, type MessageKey } from "../i18n/i18n";

export type ClientTab =
  | "claude"
  | "claude-desktop"
  | "lmstudio"
  | "cursor"
  | "vscode"
  | "antigravity"
  | "kiro"
  | "claude-code"
  | "codex"
  | "goose"
  | "pi"
  | "dsh"
  | "other";

/** Each client's name as its maker writes it, the same in every language. */
export const CLIENT_NAME: Record<Exclude<ClientTab, "other">, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  lmstudio: "LM Studio",
  cursor: "Cursor",
  vscode: "VS Code",
  antigravity: "Antigravity",
  kiro: "Kiro",
  "claude-code": "Claude Code",
  codex: "Codex",
  goose: "Goose",
  pi: "Pi",
  dsh: "DeepSeek Harness",
};

/** What the picker calls a client: its name, or "Other clients" in the reader's language. */
export function tabLabel(tab: ClientTab): string {
  return tab === "other" ? t("agents.picker.otherClients") : CLIENT_NAME[tab];
}

/** How the picker groups the clients, in the order it lists them; "Other clients" comes last, on its own. */
export const CLIENT_GROUPS: ReadonlyArray<{ titleKey: MessageKey; clients: readonly ClientTab[] }> = [
  { titleKey: "agents.picker.chatApps", clients: ["claude", "claude-desktop", "lmstudio"] },
  { titleKey: "agents.picker.editors", clients: ["cursor", "vscode", "antigravity", "kiro"] },
  { titleKey: "agents.picker.codingAgents", clients: ["claude-code", "codex", "goose", "pi", "dsh"] },
];

/** A config carries this until a key is minted. */
export const TOKEN_PLACEHOLDER = "vk_your_key_here";

/** The web UI's DeepSeek Harness profile is `web`. */
export const DSH_INSTALL_COMMAND = "dsh plugin --profile web add @stuga/dsh-plugin";
export const DSH_REMOVE_COMMAND = "dsh plugin --profile web remove @stuga/dsh-plugin";

/** Pi has no MCP of its own: pi-mcp-adapter makes the connection, and the Stuga package registers the node with it as `stuga`. */
export const PI_INSTALL_COMMAND = "pi install npm:pi-mcp-adapter\npi install npm:@stuga/pi-package";

/** The adapter stays: it may serve other servers. */
export const PI_REMOVE_COMMAND = "pi remove npm:@stuga/pi-package";

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

/** The hosts whose setup is one link that opens the app with the node filled in. */
export const LINK_CLIENTS = ["cursor", "vscode", "kiro", "goose", "lmstudio"] as const;
export type LinkClient = (typeof LINK_CLIENTS)[number];

/**
 * A host's install link, and the same link carrying a key. Goose's link can only
 * ask for a header's value, never carry one, so it has no key form.
 */
export interface InstallLink {
  signIn: string;
  withKey: string | null;
}

/** Where a hosted client, which dials from its vendor's cloud, reaches the node over HTTPS; null where it cannot. */
function hostedEndpoint(setup: AgentSetup): string | null {
  if (setup.remote) return setup.remote.mcp_url;
  return setup.reachable && setup.secure ? setup.mcp_url : null;
}

/**
 * Where a client on the browser's machine reaches the node. On the remote
 * address that machine may be anywhere, so it gets the remote address; anywhere
 * else PUBLIC_ORIGIN, so a client on the network never goes round by the relay.
 */
function localOrigin(setup: AgentSetup, pageOrigin: string | undefined): { url: string; mcpUrl: string; secure: boolean; remote: boolean } {
  if (setup.remote && pageOrigin === setup.remote.url) {
    return { url: setup.remote.url, mcpUrl: setup.remote.mcp_url, secure: true, remote: true };
  }
  return { url: setup.url, mcpUrl: setup.mcp_url, secure: setup.secure, remote: false };
}

/**
 * Every client in picker order. A hosted connector dials from its own cloud over
 * HTTPS, so it is offered only when the internet can reach the node that way.
 */
export function clientTabs(setup: AgentSetup): [ClientTab, ...ClientTab[]] {
  const hosted = hostedEndpoint(setup) !== null;
  const listed = CLIENT_GROUPS.flatMap((g) => g.clients).filter((t) => t !== "claude" || hosted);
  const [first, ...rest] = listed;
  return first === undefined ? ["other"] : [first, ...rest, "other"];
}

/** Base64 of an ASCII string: the node's origin and a `vk_` key are both ASCII. */
const base64 = (text: string): string => btoa(text);

/** Each link host's own format, from its documentation (Goose's from its deeplink generator). */
function installLinks(mcpUrl: string, name: string, key: string): Record<LinkClient, InstallLink> {
  const q = encodeURIComponent;
  const headers = { Authorization: `Bearer ${key}` };
  const cursor = (config: object) =>
    `cursor://anysphere.cursor-deeplink/mcp/install?name=${q(name)}&config=${q(base64(JSON.stringify(config)))}`;
  const vscode = (config: object) => `vscode:mcp/install?${q(JSON.stringify({ name, type: "http", ...config }))}`;
  const kiro = (config: object) =>
    `https://kiro.dev/launch/mcp/add?name=${q(name)}&config=${q(JSON.stringify({ ...config, disabled: false, autoApprove: [] }))}`;
  const lmstudio = (config: object) => `lmstudio://add_mcp?name=${q(name)}&config=${q(base64(JSON.stringify(config)))}`;
  return {
    cursor: { signIn: cursor({ url: mcpUrl }), withKey: cursor({ url: mcpUrl, headers }) },
    vscode: { signIn: vscode({ url: mcpUrl }), withKey: vscode({ url: mcpUrl, headers }) },
    kiro: { signIn: kiro({ url: mcpUrl }), withKey: kiro({ url: mcpUrl, headers }) },
    lmstudio: { signIn: lmstudio({ url: mcpUrl }), withKey: lmstudio({ url: mcpUrl, headers }) },
    goose: {
      // i18n-exempt: an install link; the description is Goose's stored config for the server.
      signIn: `goose://extension?url=${q(mcpUrl)}&type=streamable_http&id=${q(name)}&name=Stuga&description=${q("Documents and databases in Stuga")}`,
      withKey: null,
    },
  };
}

interface ClientConfigs {
  /** What a hosted client such as Claude on the web dials; `clientTabs` offers none where nothing can. */
  hostedMcpUrl: string;
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
  /** The install link per host that has one; `withKey` carries the minted key, or the placeholder before one is. */
  links: Record<LinkClient, InstallLink>;
  /** A streamable-HTTP MCP client's config. */
  httpJson: string;
  /** DeepSeek Harness reads these at launch. */
  dshEnv: string;
  /** Where the Stuga package points pi-mcp-adapter, set in the shell that starts Pi. */
  piUrlEnv: string;
  /** A key in place of Pi's browser sign-in. */
  piKeyEnv: string;
  /**
   * Claude Desktop's stdio config, or null when the node names no server file
   * a client on the browser's machine can open: only on a loopback node do the
   * two share a filesystem. Paths are absolute, since desktop clients start
   * servers without a PATH.
   */
  desktopJson: string | null;
}

/** `pageOrigin` is the origin the page was opened at, `location.origin`. */
export function clientConfigs(setup: AgentSetup, token: string | null, pageOrigin?: string): ClientConfigs {
  const key = token ?? TOKEN_PLACEHOLDER;
  const local = localOrigin(setup, pageOrigin);
  // The node's files are the browser's only on a loopback node, and a page at the remote address is not there.
  const entry = setup.loopback && !local.remote ? setup.stdio.entry : null;
  const serverKey = MCP_SERVER_KEY;
  const cliAdd = `claude mcp add -s user --transport http ${serverKey} ${local.mcpUrl}`;
  const installer = (client: InstallerClient): InstallerCommands => {
    const run = (query = "") => `curl -fsSL '${local.url}/api/agent-install/${client}${query}' | sh`;
    return { setup: run(), disconnect: run("?action=disconnect"), uninstall: run("?action=uninstall") };
  };
  return {
    hostedMcpUrl: hostedEndpoint(setup) ?? setup.mcp_url,
    serverKey,
    bundleFilename: MCP_BUNDLE_FILENAME,
    cliCommand: local.secure ? cliAdd : `${cliAdd} --header "Authorization: Bearer ${key}"`,
    cliNeedsKey: !local.secure,
    installers: { codex: installer("codex"), antigravity: installer("antigravity") },
    links: installLinks(local.mcpUrl, serverKey, key),
    httpJson: JSON.stringify(
      { mcpServers: { [serverKey]: { type: "http", url: local.mcpUrl, headers: { Authorization: `Bearer ${key}` } } } },
      null,
      2,
    ),
    dshEnv: `STUGA_URL=${local.url}\nSTUGA_API_KEY=${key}`,
    piUrlEnv: `export STUGA_URL=${local.url}`,
    piKeyEnv: `export STUGA_API_KEY=${key}`,
    desktopJson:
      entry === null
        ? null
        : JSON.stringify(
            {
              mcpServers: {
                [serverKey]: {
                  command: setup.stdio.command,
                  args: [entry],
                  env: { STUGA_URL: local.url, STUGA_TOKEN: key, STUGA_CLIENT: DESKTOP_CLIENT },
                },
              },
            },
            null,
            2,
          ),
  };
}
