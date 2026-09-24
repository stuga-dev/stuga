#!/usr/bin/env node
// The node runs its TypeScript sources through tsx, resolved beside this file. The tsconfig is
// named, not looked up from the working directory, so every caller transpiles the same way.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

// node:sqlite, which holds the actor stores, announces itself as experimental on every start.
// That one warning is dropped; every other warning still prints.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && String(warning).startsWith("SQLite is an experimental feature")) return;
  return Reflect.apply(emitWarning, this, [warning, ...rest]);
};

register({ tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)) });
await import("../src/cli.ts");
