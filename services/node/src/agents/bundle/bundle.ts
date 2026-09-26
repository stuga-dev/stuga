/**
 * The one file a user installs: manifest, icon, server and its licenses. It
 * holds no credential, so it can be passed around; the server signs in, or uses
 * a key the person typed into the extension's settings. The archive is not
 * signed; the installer rejects archives from the signing tool in circulation.
 */
import { readFileSync } from "node:fs";
import {
  BUNDLE_CLIENT,
  ICON_PATH,
  MANIFEST_PATH,
  SERVER_CONFIG_PATH,
  SERVER_ENTRY_PATH,
  SERVER_LICENSE_PATH,
  SERVER_NOTICES_PATH,
  SERVER_PACKAGE_PATH,
  bundleManifest,
  type BundleConfig,
} from "./manifest.js";
import { MCP_BUNDLE_FILENAME } from "@stuga/protocol/domain/node-name";
import { zipFiles } from "../../lib/zip.js";

/** The name Your own AI saves the extension under: the product's, for every node. */
export const bundleFilename = MCP_BUNDLE_FILENAME;

/** Rendered from apps/web/public/favicon.svg: `sips -z 256 256 -s format png favicon.svg --out icon.png`. */
const ICON_PNG = readFileSync(new URL("./icon.png", import.meta.url));

/** Node parses the single-file ESM server as CommonJS without `"type": "module"` beside it. */
const SERVER_PACKAGE_JSON = `{"name":"stuga-mcp","version":"0.0.0","private":true,"type":"module"}`;

export interface McpbInput {
  /** The self-contained server build. */
  serverJs: Uint8Array;
  /** Stuga's LICENSE and the license list of the npm packages in the build, both from beside it. */
  license: Uint8Array;
  thirdPartyLicenses: Uint8Array;
  cfg: BundleConfig;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

export function buildMcpb({ serverJs, license, thirdPartyLicenses, cfg }: McpbInput): Uint8Array<ArrayBuffer> {
  // Stored, not deflated: the installer has failed on deflated archives.
  return zipFiles([
    { name: MANIFEST_PATH, data: utf8(`${JSON.stringify(bundleManifest(cfg), null, 2)}\n`) },
    { name: ICON_PATH, data: ICON_PNG },
    { name: SERVER_PACKAGE_PATH, data: utf8(SERVER_PACKAGE_JSON) },
    { name: SERVER_ENTRY_PATH, data: serverJs },
    // Hosts do not always pass the manifest's environment to the spawned server; it reads this file beside itself.
    { name: SERVER_CONFIG_PATH, data: utf8(JSON.stringify(sidecarConfig(cfg))) },
    { name: SERVER_LICENSE_PATH, data: license },
    { name: SERVER_NOTICES_PATH, data: thirdPartyLicenses },
  ], "stored");
}

/** What the server falls back to when the host passes it no environment: the node it came from, and no key. */
function sidecarConfig(cfg: BundleConfig): Record<string, string> {
  return { url: cfg.url, client: BUNDLE_CLIENT, version: cfg.stugaVersion };
}
