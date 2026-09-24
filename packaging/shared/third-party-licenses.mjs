// The license list a bundle carries: every npm package whose code a bundler put into it, with the
// license its package.json declares and the text of its license files. Both bundles call it, the
// web app from vite.config.ts and stuga-mcp from services/mcp/build.mjs, with the module files the
// bundler reports.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const NODE_MODULES = `${sep}node_modules${sep}`;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const RULE = "=".repeat(80);

/** The package directory a bundled file belongs to, or null for a file outside node_modules. */
export function packageDirOf(file) {
  const path = file.replace(/^\0/, "").split("?")[0];
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const rest = path.slice(at + NODE_MODULES.length).split(sep);
  const depth = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length <= depth) return null;
  return path.slice(0, at + NODE_MODULES.length) + rest.slice(0, depth).join(sep);
}

function describe(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const texts = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim());
  const declared =
    typeof pkg.license === "string"
      ? pkg.license
      : (pkg.license?.type ?? (texts.length > 0 ? "undeclared, see its license file" : "no license declared"));
  return { name: pkg.name, version: pkg.version, license: declared, texts };
}

/**
 * @param {Iterable<string>} files absolute paths of the modules in the bundle
 * @param {string} heading the first paragraph: what the list is for and where its own license is
 */
export function thirdPartyLicenses(files, heading) {
  const dirs = new Set();
  for (const file of files) {
    const dir = packageDirOf(file);
    if (dir && existsSync(join(dir, "package.json"))) dirs.add(dir);
  }
  const byId = new Map();
  for (const dir of dirs) {
    const p = describe(dir);
    byId.set(`${p.name}@${p.version}`, p);
  }
  const packages = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const out = [heading.trim(), ""];
  for (const p of packages) out.push(`  ${p.name} ${p.version}: ${p.license}`);
  for (const p of packages) {
    out.push("", RULE, `${p.name} ${p.version}: ${p.license}`, RULE, "");
    out.push(p.texts.length > 0 ? p.texts.join("\n\n") : `The package carries no license file; its package.json declares ${p.license}.`);
  }
  return `${out.join("\n")}\n`;
}
