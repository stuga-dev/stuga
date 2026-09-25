/**
 * One command that sets an agent host up against this node.
 *
 * The script carries no credential and this route mints none: it installs the
 * discovery skill, points the host at `/mcp`, and the host's own browser
 * sign-in does the granting. Both hosts register themselves through dynamic
 * client registration, which is what `/oauth/register` serves, so what comes
 * out is an ordinary connection, revocable under Connected agents.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_SERVER_KEY } from "@stuga/protocol/domain/node-name";
import { APP_ROOT } from "../app-root.js";
import { error } from "../http/respond.js";
import type { PublicCall } from "../http/router.js";

/** The Stuga skill's one copy, which the app tree carries: what both hosts install and the Claude plugin ships. */
const SKILL_DIR = join(APP_ROOT, "integrations", "skills", "stuga");

/** A skill file as the heredoc that writes it needs it: newline-terminated, never holding its own delimiter. */
function skillFile(path: string, delimiter: string): string {
  const text = readFileSync(join(SKILL_DIR, path), "utf8");
  if (text.split("\n").includes(delimiter)) throw new Error(`${path} contains the line ${delimiter}`);
  return text.endsWith("\n") ? text : `${text}\n`;
}

export const STUGA_SKILL = skillFile("SKILL.md", "STUGA_SKILL_EOF");
/** Codex's skill UI metadata. */
export const STUGA_SKILL_OPENAI = skillFile("agents/openai.yaml", "STUGA_OPENAI_EOF");

/**
 * Reading and writing one key of Antigravity's `mcp_config.json` without
 * disturbing the other servers in it. Single-quote free: the shell embeds it
 * in a single-quoted `node -e` argument.
 */
const ANTIGRAVITY_WRITE = `
const fs = require("fs");
const path = require("path");
const [file, server, url] = process.argv.slice(1);
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (typeof config !== "object" || config === null) config = {};
config.mcpServers = config.mcpServers || {};
const existing = config.mcpServers[server];
if (existing && existing.serverUrl !== url) {
  console.error(server + " already names another MCP server. Set STUGA_SERVER to another name and run this again.");
  process.exit(2);
}
config.mcpServers[server] = { serverUrl: url };
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\\n");
console.log("Configured " + server + " in " + file + ".");
`;

/**
 * Antigravity caches the OAuth token per MCP URL. Removing only the server entry
 * leaves a working credential on disk and makes the next install skip the sign-in,
 * so a removal has to forget the token as well.
 */
const ANTIGRAVITY_FORGET = `
const fs = require("fs");
const [file, url] = process.argv.slice(1);
let tokens;
try { tokens = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
if (tokens && tokens[url]) {
  delete tokens[url];
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + "\\n");
  console.log("Signed out of " + url + ".");
}
`;

const ANTIGRAVITY_DELETE = `
const fs = require("fs");
const [file, server, url] = process.argv.slice(1);
let config;
try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
if (config && config.mcpServers && config.mcpServers[server]) {
  if (config.mcpServers[server].serverUrl !== url) {
    console.error(server + " points at another MCP server; nothing was removed.");
    process.exit(2);
  }
  delete config.mcpServers[server];
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\\n");
  console.log("Removed " + server + " from " + file + ".");
}
`;

interface Host {
  /** What the person restarts; also the tab's name for the host. */
  label: string;
  /** Where the host reads user-level skills. A shell expression, expanded by the script. */
  skillDir: string;
  /** The host's MCP configuration file, for a host the script edits directly. */
  configFile?: string;
  /** Codex reads `agents/openai.yaml` beside SKILL.md; Antigravity ignores it, so only Codex gets it. */
  openaiMetadata: boolean;
  /** The command the script needs on PATH, and what to say when it is missing. */
  tool: { command: string; missing: string };
  /** Adds this node's MCP server and signs in, as far as the host allows. */
  connect: string;
  /** What the person still has to do after restarting, if anything. */
  signIn: string;
  /** Removes this node's MCP server and any sign-in stored for it. */
  disconnect: string;
}

const HOSTS: Record<string, Host> = {
  codex: {
    label: "Codex",
    skillDir: '"${HOME}/.agents/skills/stuga"',
    openaiMetadata: true,
    tool: { command: "codex", missing: "Codex CLI is required. Install it, then run this command again." },
    // Current Codex releases complete OAuth during `mcp add --url`. Following it with
    // `mcp login` makes the person sign in a second time.
    connect: `if STUGA_EXISTING="$(codex mcp get "\${STUGA_SERVER}" --json 2>/dev/null)"; then
  case "\${STUGA_EXISTING}" in
    *"\${STUGA_MCP_URL}"*) echo "Codex already has \${STUGA_SERVER}. To sign in again: codex mcp login \${STUGA_SERVER}" ;;
    *) echo "\${STUGA_SERVER} already names another MCP server. Set STUGA_SERVER to another name and run this again." >&2; exit 2 ;;
  esac
else
  codex mcp add "\${STUGA_SERVER}" --url "\${STUGA_MCP_URL}"
fi`,
    signIn: "",
    // `codex mcp remove` leaves the stored OAuth credentials behind, so log out first.
    disconnect: `if STUGA_EXISTING="$(codex mcp get "\${STUGA_SERVER}" --json 2>/dev/null)"; then
  case "\${STUGA_EXISTING}" in
    *"\${STUGA_MCP_URL}"*)
      codex mcp logout "\${STUGA_SERVER}" >/dev/null 2>&1 || true
      codex mcp remove "\${STUGA_SERVER}" >/dev/null 2>&1 || true
      echo "Removed \${STUGA_SERVER} from Codex."
      ;;
    *) echo "\${STUGA_SERVER} points at another MCP server; nothing was removed." >&2; exit 2 ;;
  esac
else
  echo "Codex has no \${STUGA_SERVER}."
fi`,
  },
  antigravity: {
    label: "Antigravity",
    // Verified against the shipped language_server: it knows ~/.gemini/config/skills and
    // .agents/skills, and no longer reads the ~/.gemini/antigravity/skills the docs call legacy.
    skillDir: '"${HOME}/.gemini/config/skills/stuga"',
    configFile: '"${HOME}/.gemini/config/mcp_config.json"',
    openaiMetadata: false,
    tool: { command: "node", missing: "Node.js is required to edit the Antigravity MCP configuration." },
    // Antigravity dials a remote server through `serverUrl` and handles dynamic client
    // registration itself, so the entry holds a URL and nothing else.
    connect: `node -e '${ANTIGRAVITY_WRITE}' "\${STUGA_CONFIG}" "\${STUGA_SERVER}" "\${STUGA_MCP_URL}"`,
    signIn: "Then sign in: Settings \u2192 Customizations \u2192 Installed MCP Servers \u2192 Authenticate.",
    disconnect: `node -e '${ANTIGRAVITY_DELETE}' "\${STUGA_CONFIG}" "\${STUGA_SERVER}" "\${STUGA_MCP_URL}"
for STUGA_OAUTH_FILE in "\${HOME}/.gemini/antigravity/mcp_oauth_tokens.json" "\${HOME}/.gemini/config/mcp_oauth_tokens.json"; do
  if [ -f "\${STUGA_OAUTH_FILE}" ]; then
    node -e '${ANTIGRAVITY_FORGET}' "\${STUGA_OAUTH_FILE}" "\${STUGA_MCP_URL}"
  fi
done`,
  },
};

export const INSTALL_CLIENTS = Object.keys(HOSTS);

export type InstallAction = "install" | "disconnect" | "uninstall";

/** A POSIX-shell single-quoted literal. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireTool({ tool }: Host): string {
  return `if ! command -v ${tool.command} >/dev/null 2>&1; then
  echo ${shellQuote(tool.missing)} >&2
  exit 1
fi`;
}

function writeSkill(host: Host): string {
  const metadata = host.openaiMetadata
    ? `mkdir -p "\${STUGA_SKILL_DIR}/agents"
cat > "\${STUGA_SKILL_DIR}/agents/openai.yaml" <<'STUGA_OPENAI_EOF'
${STUGA_SKILL_OPENAI}STUGA_OPENAI_EOF
`
    : "";
  return `mkdir -p "\${STUGA_SKILL_DIR}"
cat > "\${STUGA_SKILL_DIR}/SKILL.md" <<'STUGA_SKILL_EOF'
${STUGA_SKILL}STUGA_SKILL_EOF
${metadata}echo "Installed the Stuga skill to \${STUGA_SKILL_DIR}."`;
}

const REVOKE_NOTE = "Local removal does not revoke access. Also revoke the connection under Connected agents in Stuga.";

export function installScript(
  client: string,
  action: InstallAction,
  publicOrigin: string,
): string | null {
  const host = HOSTS[client];
  if (!host) return null;
  const serverKey = MCP_SERVER_KEY;
  const head = `#!/bin/sh
set -eu

: "\${HOME:?HOME must be set}"
STUGA_SERVER="\${STUGA_SERVER:-${serverKey}}"
STUGA_MCP_URL=${shellQuote(`${publicOrigin}/mcp`)}
STUGA_SKILL_DIR=${host.skillDir}
${host.configFile ? `STUGA_CONFIG=${host.configFile}\n` : ""}`;
  const tail = `
echo
echo "Restart ${host.label} to apply this."`;

  if (action === "install") {
    return `${head}
${requireTool(host)}

${writeSkill(host)}

${host.connect}

echo
echo "Setup complete. Restart ${host.label}."
${host.signIn ? `echo ${shellQuote(host.signIn)}
` : ""}echo "Then ask: can you access my Stuga workspace?"
`;
  }
  if (action === "disconnect") {
    return `${head}
${requireTool(host)}

${host.disconnect}

echo ${shellQuote(REVOKE_NOTE)}${tail}
`;
  }
  // Complete removal takes the skill away first: it is ours whatever the client's entry now points at.
  return `${head}
rm -rf "\${STUGA_SKILL_DIR}"
echo "Removed the Stuga skill from \${STUGA_SKILL_DIR}."

if command -v ${host.tool.command} >/dev/null 2>&1; then
${host.disconnect
  .split("\n")
  .map((l) => `  ${l}`)
  .join("\n")}
fi

echo ${shellQuote(REVOKE_NOTE)}${tail}
`;
}

function readAction(value: string | null): InstallAction {
  return value === "uninstall" ? "uninstall" : value === "disconnect" ? "disconnect" : "install";
}

/**
 * GET /api/agent-install/:client — public because it hands out no credential:
 * the script points the host at `/mcp`, and OAuth grants the access.
 */
export async function getAgentInstaller({ env, url, match }: PublicCall): Promise<Response> {
  const script = installScript(match[1] ?? "", readAction(url.searchParams.get("action")), env.publicOrigin);
  if (script === null) return error(404, "unknown agent host");
  return new Response(script, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
