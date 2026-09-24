// Builds dist/: the self-contained stdio server, Stuga's LICENSE, and the license list of the npm
// packages bundled into it. The Claude Desktop extension carries all three.
import { copyFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { thirdPartyLicenses } from "../../packaging/shared/third-party-licenses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

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
  // Bundled CommonJS dependencies call require(), which an ES module does not have.
  banner: { js: 'import{createRequire as __vcreq}from"node:module";const require=__vcreq(import.meta.url);' },
});

copyFileSync(join(here, "../../LICENSE"), join(dist, "LICENSE"));
const heading = `Third-party software in stuga-mcp.js

stuga-mcp is part of Stuga, AGPL-3.0-only: LICENSE beside this file, and the source at
https://github.com/stuga-dev/stuga. It bundles the npm packages below, each under its own license.`;
await writeFile(
  join(dist, "third-party-licenses.txt"),
  thirdPartyLicenses(Object.keys(metafile.inputs).map((input) => resolve(here, input)), heading),
);
