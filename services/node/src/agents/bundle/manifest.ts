/**
 * The manifest at the root of the .mcpb extension. It declares no `user_config`:
 * everything the server needs travels inside the archive, so installing asks
 * the user nothing.
 */
import { TOOL_NAMES, TOOL_SUMMARIES } from "@stuga/agent-surface/catalog";
import { MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";

/** The installer finds the manifest by name at the archive root; the entry point must match the server path. */
export const MANIFEST_PATH = "manifest.json";
/** Stuga's mark, which the client shows beside the extension's name. */
export const ICON_PATH = "icon.png";
export const SERVER_PACKAGE_PATH = "server/package.json";
export const SERVER_ENTRY_PATH = "server/index.js";
export const SERVER_CONFIG_PATH = "server/config.json";
// Stuga's license and the licenses of the npm packages bundled into the server, as the build leaves them beside it.
export const SERVER_LICENSE_PATH = "server/LICENSE";
export const SERVER_NOTICES_PATH = "server/third-party-licenses.txt";

/** The client label the extension's runs carry in the inbox. */
export const BUNDLE_CLIENT = "claude-desktop";

/** A value bound for the launch environment that cannot survive the trip. */
export class UnsafeBundleValue extends Error {}

export interface BundleConfig {
  /** This node's public origin. */
  url: string;
  /** The node's id, which never changes: the extension's name, so a second node's extension installs beside it. */
  nodeId: string;
  /** What people call the node, handed to the server for its routing instructions, not used as its display title. */
  nodeName: string;
  /** A freshly minted API key. */
  token: string;
  /** The workspace the key was minted in, named so two extensions from one node can be told apart. */
  workspace?: string;
  /** This node's version, which the extension's server has no other way to learn. */
  stugaVersion: string;
}

/**
 * `mcp_config` values go through variable substitution on the way to the
 * spawned process, and a `$` comes back mangled, so refuse one.
 */
export function assertBundleEnvValue(key: string, value: string): void {
  if (!envSafe(value)) throw new UnsafeBundleValue(`${key} cannot contain "$"`);
}

const envSafe = (value: string) => !value.includes("$");

function envValue(key: string, value: string): string {
  assertBundleEnvValue(key, value);
  return value;
}

export interface BundleManifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: { name: string };
  icon: string;
  license: string;
  keywords: string[];
  server: {
    type: string;
    entry_point: string;
    mcp_config: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
  tools: { name: string; description: string }[];
  compatibility: {
    platforms: string[];
    runtimes: { node: string };
  };
}

export function bundleManifest(cfg: BundleConfig, now: Date): BundleManifest {
  const where = cfg.workspace ? `${cfg.url} (workspace ${cfg.workspace})` : cfg.url;
  return {
    manifest_version: "0.3",
    // The installer keys an extension by name: one per node, and a re-download from the same node replaces it.
    name: `stuga-${cfg.nodeId}`,
    display_name: MCP_SERVER_TITLE,
    // An installer sequence, not a Stuga version: a re-download (say, after
    // revoking a key) must be newer than the installed copy or it is skipped.
    version: `0.1.${Math.floor(now.getTime() / 1000)}`,
    description: `Read and edit live documents in Stuga. Connected to ${where}.`,
    author: { name: "Stuga" },
    icon: ICON_PATH,
    license: "AGPL-3.0-only",
    keywords: ["stuga", "documents", "collaboration", "markdown"],
    server: {
      type: "node",
      entry_point: SERVER_ENTRY_PATH,
      mcp_config: {
        // The host supplies its own Node runtime and resolves this name itself.
        command: "node",
        args: [`\${__dirname}/${SERVER_ENTRY_PATH}`],
        env: {
          STUGA_URL: envValue("STUGA_URL", cfg.url),
          STUGA_TOKEN: envValue("STUGA_TOKEN", cfg.token),
          STUGA_CLIENT: envValue("STUGA_CLIENT", BUNDLE_CLIENT),
          STUGA_VERSION: envValue("STUGA_VERSION", cfg.stugaVersion),
          // Free text an administrator chose: one with a `$` stays out rather than failing the download. config.json
          // still carries it beside the same URL, which is what lets the server read the name from there alone.
          ...(envSafe(cfg.nodeName) ? { STUGA_NODE_NAME: cfg.nodeName } : {}),
        },
      },
    },
    tools: TOOL_NAMES.map((name) => ({ name, description: TOOL_SUMMARIES[name] })),
    // No client version floor: a guessed constraint can refuse an install that would have worked.
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: ">=18.0.0" },
    },
  };
}
