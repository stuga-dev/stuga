/**
 * The manifest at the root of the .mcpb extension: one extension, `stuga`, for
 * every node. It carries no credential. `user_config` asks for the node's
 * address, filled in with the node it was downloaded from, and an optional key;
 * without one the server signs in through the person's browser.
 */
import { TOOL_NAMES, TOOL_SUMMARIES } from "@stuga/agent-surface/catalog";
import { MCP_SERVER_KEY, MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";

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
  /** The node the extension was downloaded from: the address it offers until the person changes it. */
  url: string;
  /** This node's version, which the extension's server has no other way to learn. */
  stugaVersion: string;
}

/**
 * `mcp_config` values go through variable substitution on the way to the
 * spawned process, and a `$` comes back mangled, so refuse one.
 */
export function assertBundleEnvValue(key: string, value: string): void {
  if (value.includes("$")) throw new UnsafeBundleValue(`${key} cannot contain "$"`);
}

function envValue(key: string, value: string): string {
  assertBundleEnvValue(key, value);
  return value;
}

interface UserConfigField {
  type: "string";
  title: string;
  description: string;
  required: boolean;
  sensitive?: boolean;
  default?: string;
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
  user_config: Record<"node_url" | "access_key", UserConfigField>;
  tools: { name: string; description: string }[];
  compatibility: {
    platforms: string[];
    runtimes: { node: string };
  };
}

export function bundleManifest(cfg: BundleConfig): BundleManifest {
  return {
    manifest_version: "0.3",
    // One name for every node: the installer keys an extension by it, so a newer download replaces the old one.
    name: MCP_SERVER_KEY,
    display_name: MCP_SERVER_TITLE,
    version: cfg.stugaVersion,
    description: "Read and edit live documents in Stuga.",
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
          STUGA_URL: "${user_config.node_url}",
          STUGA_TOKEN: "${user_config.access_key}",
          STUGA_CLIENT: envValue("STUGA_CLIENT", BUNDLE_CLIENT),
          STUGA_VERSION: envValue("STUGA_VERSION", cfg.stugaVersion),
        },
      },
    },
    user_config: {
      node_url: {
        type: "string",
        title: "Stuga address",
        description: "The address you open Stuga at.",
        required: true,
        default: envValue("the node's address", cfg.url),
      },
      access_key: {
        type: "string",
        title: "Access key",
        description: "Leave empty to sign in through your browser.",
        required: false,
        sensitive: true,
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
