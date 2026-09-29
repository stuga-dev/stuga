// Builds the node for a built tree: <out>/dist/stuga-node.mjs, one ES module holding the node and
// every npm package it runs, with its source map, the migrations and the files the sources read
// beside themselves, and the license list of the bundled packages. packaging/shared/build-app.sh
// runs it; bin/stuga-node.js runs the bundle when it is there.
//
//   node services/node/build.mjs <out>      <out> is the tree's services/node
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { thirdPartyLicenses } from "../../packaging/shared/third-party-licenses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error("usage: node services/node/build.mjs <out>");
  process.exit(2);
}
const dist = join(resolve(out), "dist");

const { metafile, outputFiles } = await build({
  absWorkingDir: here,
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  // Laid out as in the checkout, so the map names sources by their path in the repository.
  outfile: join(here, "dist", "stuga-node.mjs"),
  write: false,
  sourcemap: "linked",
  sourcesContent: false,
  // Folds constants, keeps names and layout: the bundle stays readable.
  minifySyntax: true,
  legalComments: "eof",
  logLevel: "warning",
  metafile: true,
  define: { __STUGA_MIGRATIONS_URL__: JSON.stringify("./migrations/") },
  // Bundled CommonJS dependencies call require(), which an ES module does not have.
  banner: { js: 'import{createRequire as __vcreq}from"node:module";const require=__vcreq(import.meta.url);' },
});

mkdirSync(dist, { recursive: true });
for (const file of outputFiles) writeFileSync(join(dist, file.path.slice(join(here, "dist").length + 1)), file.contents);
cpSync(join(here, "../../packages/db/migrations"), join(dist, "migrations"), { recursive: true });
copyFileSync(join(here, "src/agents/bundle/icon.png"), join(dist, "icon.png"));

// Every file the sources read beside themselves has to be beside the bundle now.
const bundle = outputFiles.find((file) => file.path.endsWith(".mjs")).text;
const missing = [...bundle.matchAll(/new URL\("(\.{1,2}\/[^"]*)", import\.meta\.url\)/g)]
  .map((match) => match[1])
  .filter((path) => !existsSync(join(dist, path)));
if (missing.length > 0) {
  console.error(`error: the bundle reads ${missing.join(", ")} beside itself; build.mjs does not put it there`);
  process.exit(1);
}

const heading = `Third-party software in stuga-node.mjs

The Stuga node is AGPL-3.0-only: LICENSE at the root of this tree, and the source at
https://github.com/stuga-dev/stuga. It bundles the npm packages below, each under its own license.`;
writeFileSync(
  join(dist, "third-party-licenses.txt"),
  thirdPartyLicenses(Object.keys(metafile.inputs).map((input) => resolve(here, input)), heading),
);
