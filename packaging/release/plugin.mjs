// The plugin as a release publishes it to stuga-dev/stuga-plugin: integrations/ with the version
// stamped in. The source names no version, because main holds unreleased work and only a release
// names a @stuga/mcp that npm has.
//
//   plugin.mjs stamp <version> <outdir>  copy integrations/ to <outdir>, set the manifest's version,
//                                        and pin the stdio server to @stuga/mcp@<version>
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SERVER_PACKAGE = "@stuga/mcp";
const SOURCE = fileURLToPath(new URL("../../integrations/", import.meta.url));
/** The directory refuses a plugin that carries these. */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Writes the released plugin to `outdir`, replacing whatever is there. */
export function stamp(version, outdir, source = SOURCE) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  rmSync(outdir, { recursive: true, force: true });
  cpSync(source, outdir, { recursive: true, filter: (path) => !SYSTEM_FILES.has(basename(path)) });

  const manifestPath = join(outdir, ".claude-plugin", "plugin.json");
  const { name, displayName, ...rest } = readJson(manifestPath);
  if ("version" in rest) throw new Error("the source plugin.json names a version; a release stamps it");
  writeJson(manifestPath, { name, displayName, version, ...rest });

  const mcpPath = join(outdir, ".mcp.json");
  const mcp = readJson(mcpPath);
  let pinned = 0;
  for (const server of Object.values(mcp.mcpServers ?? {})) {
    server.args = server.args?.map((arg) => {
      if (arg.startsWith(`${SERVER_PACKAGE}@`)) throw new Error(`the source .mcp.json pins ${SERVER_PACKAGE}; a release pins it`);
      if (arg !== SERVER_PACKAGE) return arg;
      pinned += 1;
      return `${SERVER_PACKAGE}@${version}`;
    });
  }
  if (pinned !== 1) throw new Error(`the source .mcp.json must run ${SERVER_PACKAGE} exactly once`);
  writeJson(mcpPath, mcp);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version, outdir] = process.argv.slice(2);
  try {
    if (command !== "stamp" || !version || !outdir) throw new Error("usage: plugin.mjs stamp <version> <outdir>");
    stamp(version, outdir);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
