#!/usr/bin/env node
/**
 * What the translations owe the English catalog: keys a language lacks, keys it has that English
 * dropped, and keys whose English changed since they were last translated (source-hashes.json).
 *
 *   node scripts/i18n-check.mjs            report, as JSON, per language
 *   node scripts/i18n-check.mjs --accept   record the current English as translated, once every
 *                                          language has been brought up to date
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const i18n = fileURLToPath(new URL("../src/i18n/", import.meta.url));
const messages = join(i18n, "messages");
const hashesPath = join(i18n, "source-hashes.json");

function catalog(language) {
  const out = {};
  for (const file of readdirSync(join(messages, language)).filter((f) => f.endsWith(".json"))) {
    const ns = file.slice(0, -".json".length);
    for (const [key, message] of Object.entries(JSON.parse(readFileSync(join(messages, language, file), "utf8")))) out[`${ns}.${key}`] = message;
  }
  return out;
}

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const en = catalog("en");
const languages = readdirSync(messages, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "en").map((d) => d.name);
let recorded = {};
try {
  recorded = JSON.parse(readFileSync(hashesPath, "utf8"));
} catch {
  recorded = {};
}

if (process.argv.includes("--accept")) {
  const missing = languages.flatMap((l) => Object.keys(en).filter((k) => !(k in catalog(l))).map((k) => `${l} ${k}`));
  if (missing.length) {
    console.error(`not accepted: ${missing.length} translations are missing, e.g. ${missing.slice(0, 5).join(", ")}`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.keys(en).sort().map((k) => [k, hash(en[k])]));
  writeFileSync(hashesPath, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`recorded ${Object.keys(sorted).length} English messages as translated`);
  process.exit(0);
}

const stale = Object.keys(en).filter((k) => recorded[k] !== hash(en[k]));
const report = {};
for (const language of languages) {
  const theirs = catalog(language);
  report[language] = {
    missing: Object.keys(en).filter((k) => !(k in theirs)),
    extra: Object.keys(theirs).filter((k) => !(k in en)),
  };
}
console.log(JSON.stringify({ stale, languages: report }, null, 2));
