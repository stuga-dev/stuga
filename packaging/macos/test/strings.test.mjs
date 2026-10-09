// node --test packaging/macos/test/strings.test.mjs (macOS: plutil)
// Stuga.app's translations and the installer's pages: every language has every message with the same
// arguments, the English matches the app's own, and each conclusion page names the menu as it reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const macos = new URL("..", import.meta.url).pathname;
const skip = process.platform !== "darwin" && "needs plutil";
const languages = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "de", "fr", "es", "pt-BR"];
/** Installer.app's folder for each language. */
const installerFolders = { en: "en", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW", ja: "ja", ko: "ko", de: "de", fr: "fr", es: "es", "pt-BR": "pt" };
/** The menu titles conclusion.html tells someone to choose. */
const quotedMenu = ["menu.setUp", "menu.addressQR"];

function strings(language) {
  const run = spawnSync("plutil", ["-convert", "json", "-o", "-", join(macos, "app", `${language}.lproj/Localizable.strings`)], { encoding: "utf8" });
  assert.equal(run.status, 0, `${language}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** A message's arguments as String(format:) reads them: %@ takes the next, %2$@ the second. */
function placeholders(message) {
  let next = 0;
  const found = [];
  for (const [, position, type] of message.matchAll(/%(?:(\d+)\$)?([@%a-zA-Z])/g)) {
    if (type === "%") continue;
    found.push(`${position ? Number(position) : ++next}${type}`);
  }
  return found.sort();
}

function html(text) {
  return text.replaceAll("&#8239;", " ").replaceAll("&nbsp;", " ").replaceAll("&amp;", "&");
}

test("the app ships exactly the languages its Info.plist names", () => {
  const folders = readdirSync(join(macos, "app")).filter((name) => name.endsWith(".lproj")).map((name) => name.slice(0, -6));
  assert.deepEqual(folders.sort(), [...languages].sort());
  const script = readFileSync(join(macos, "pkg/build-pkg.sh"), "utf8");
  const listed = script.match(/<key>CFBundleLocalizations<\/key>\s*<array>(.*?)<\/array>/s)?.[1];
  assert.ok(listed, "build-pkg.sh writes CFBundleLocalizations");
  assert.deepEqual([...listed.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort(), [...languages].sort());
  assert.match(script, /<key>CFBundleDevelopmentRegion<\/key><string>en<\/string>/);
});

test("the English strings are the app's own", { skip }, () => {
  const english = strings("en");
  const inCode = {};
  for (const file of ["app/main.swift", "app/Health.swift"]) {
    for (const [, key, value] of readFileSync(join(macos, file), "utf8").matchAll(/\bL\("([^"]+)", "((?:[^"\\]|\\.)*)"/g)) {
      const text = value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
      assert.ok(!(key in inCode) || inCode[key] === text, `${key} has one English text in the code`);
      inCode[key] = text;
    }
  }
  assert.ok(Object.keys(inCode).length > 0, "the app's text goes through L()");
  assert.deepEqual(english, inCode);
});

test("every language has every message, with the same arguments", { skip }, () => {
  const english = strings("en");
  for (const language of languages) {
    const translated = strings(language);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), `${language} has the English keys`);
    for (const [key, message] of Object.entries(english)) {
      assert.ok(translated[key].trim(), `${language} ${key} is translated`);
      assert.deepEqual(placeholders(translated[key]), placeholders(message), `${language} ${key} keeps the arguments of "${message}"`);
    }
  }
});

test("each installer language has both pages, and the conclusion quotes its menu", { skip }, () => {
  const resources = join(macos, "pkg/resources");
  for (const page of ["welcome.html", "conclusion.html"]) {
    assert.match(readFileSync(join(resources, page), "utf8"), /<html lang="en">/, `the root ${page} is the English fallback`);
  }
  for (const language of languages) {
    const folder = join(resources, `${installerFolders[language]}.lproj`);
    for (const page of ["welcome.html", "conclusion.html"]) {
      assert.ok(existsSync(join(folder, page)), `${installerFolders[language]}.lproj/${page}`);
      assert.match(readFileSync(join(folder, page), "utf8"), new RegExp(`<html lang="${language}">`), `${language} ${page} says its language`);
    }
    const conclusion = html(readFileSync(join(folder, "conclusion.html"), "utf8"));
    const menu = strings(language);
    for (const key of quotedMenu) {
      assert.ok(conclusion.includes(`<b>${menu[key]}</b>`), `${language} conclusion.html quotes ${key} as "${menu[key]}"`);
    }
  }
});

test("the web app names the setup menu item as the menu bar does, in every language", { skip }, () => {
  for (const language of languages) {
    const web = JSON.parse(readFileSync(join(macos, "../../apps/web/src/i18n/messages", language, "auth.json"), "utf8"));
    assert.equal(web["macMenu.setUp"], strings(language)["menu.setUp"], language);
  }
});
