#!/usr/bin/env node
// A built tree (packaging/shared/build-app.sh) runs the node's bundle beside this file. A checkout
// has none and runs the TypeScript sources through tsx, with the tsconfig named rather than looked
// up from the working directory, so every caller transpiles the same way.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = new URL("../dist/stuga-node.mjs", import.meta.url);
if (existsSync(bundle)) {
  // Stack traces name the source files, through the map beside the bundle.
  process.setSourceMapsEnabled(true);
  await import(bundle.href);
} else {
  const { register } = await import("tsx/esm/api");
  register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
  await import("../src/cli.ts");
}
