// Builds dist/: the self-contained stdio server, Stuga's LICENSE, and the license list of the npm
// packages bundled into it, which the Claude Desktop extension carries, plus the package.json and
// README that make dist/ the npm package @stuga/mcp. STUGA_VERSION (a release's) is stamped into both.
import { copyFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { thirdPartyLicenses } from "../../packaging/shared/third-party-licenses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const version = process.env.STUGA_VERSION?.trim() || "0.0.0-dev";

const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: join(dist, "stuga-mcp.js"),
  legalComments: "eof",
  logLevel: "warning",
  metafile: true,
  define: { __STUGA_MCP_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS dependencies call require(), which an ES module does not have.
  banner: { js: 'import{createRequire as __vcreq}from"node:module";const require=__vcreq(import.meta.url);' },
});

copyFileSync(join(here, "../../LICENSE"), join(dist, "LICENSE"));
copyFileSync(join(here, "README.md"), join(dist, "README.md"));
const manifest = {
  name: "@stuga/mcp",
  version,
  description: "Connect an MCP client that starts local servers to your Stuga node, signing in through your browser.",
  license: "AGPL-3.0-only",
  type: "module",
  bin: { "stuga-mcp": "stuga-mcp.js" },
  files: ["stuga-mcp.js", "npm-shrinkwrap.json", "third-party-licenses.txt", "README.md", "LICENSE"],
  keywords: ["stuga", "mcp"],
  homepage: "https://stuga.dev",
  repository: { type: "git", url: "git+https://github.com/stuga-dev/stuga.git", directory: "services/mcp" },
  engines: { node: ">=18" },
  publishConfig: { access: "public" },
};
await writeFile(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// Everything is bundled into stuga-mcp.js, so the lockfile holds the package alone: it tells a
// reviewer that `npx @stuga/mcp@<version>` installs nothing else.
const { name, license, bin, engines } = manifest;
const lockfile = { name, version, lockfileVersion: 3, requires: true, packages: { "": { name, version, license, bin, engines } } };
await writeFile(join(dist, "npm-shrinkwrap.json"), `${JSON.stringify(lockfile, null, 2)}\n`);
const heading = `Third-party software in stuga-mcp.js

stuga-mcp is part of Stuga, AGPL-3.0-only: LICENSE beside this file, and the source at
https://github.com/stuga-dev/stuga. It bundles the npm packages below, each under its own license.`;
await writeFile(
  join(dist, "third-party-licenses.txt"),
  thirdPartyLicenses(Object.keys(metafile.inputs).map((input) => resolve(here, input)), heading),
);
