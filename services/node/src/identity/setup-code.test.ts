import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SETUP_CODE_FILE,
  formatSetupCode,
  loadOrCreateSetupCode,
  normalizeSetupCode,
  removeSetupCode,
  setupCodeFile,
  setupCodeMatches,
  setupLink,
} from "./setup-code.js";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stuga-setup-code-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setup code", () => {
  it("is ten characters of Crockford base32, kept owner-only in the data directory and shown in two groups", async () => {
    const dir = dataDir();
    const code = await loadOrCreateSetupCode(setupCodeFile(dir));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    const path = join(dir, SETUP_CODE_FILE);
    expect(readFileSync(path, "utf8")).toBe(`${formatSetupCode(code)}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(formatSetupCode(code)).toMatch(/^.{5}-.{5}$/);
  });

  it("is readable by its group in a file the packaging names, whatever the umask", async () => {
    const path = join(dataDir(), "setup", "code");
    mkdirSync(dirname(path));
    const previous = process.umask(0o077);
    try {
      await loadOrCreateSetupCode(setupCodeFile("/nowhere", path));
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(path))).toEqual(["code"]);
  });

  it("survives a restart until the node is claimed, then a new one is made", async () => {
    const file = setupCodeFile(dataDir());
    const first = await loadOrCreateSetupCode(file);
    expect(await loadOrCreateSetupCode(file)).toBe(first);
    await removeSetupCode(file);
    await removeSetupCode(file); // already gone: not an error
    const next = await loadOrCreateSetupCode(file);
    expect(next).not.toBe(first);
  });

  it("replaces a file that holds no code", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, SETUP_CODE_FILE), "not a code\n");
    expect(await loadOrCreateSetupCode(setupCodeFile(dir))).toMatch(/^[0-9A-Z]{10}$/);
  });

  it("matches what a person types, and nothing when there is no code", () => {
    expect(setupCodeMatches("ABCDE12345", "abcde-12345")).toBe(true);
    expect(setupCodeMatches("ABCDE12345", " ABCDE 12345 ")).toBe(true);
    expect(setupCodeMatches("0A1B2C3D4E", "OA-LB2C3D4E")).toBe(true);
    expect(setupCodeMatches("ABCDE12345", "ABCDE12346")).toBe(false);
    expect(setupCodeMatches("ABCDE12345", "ABCDE1234")).toBe(false);
    expect(setupCodeMatches("ABCDE12345", 12345)).toBe(false);
    expect(setupCodeMatches(null, "ABCDE12345")).toBe(false);
    expect(setupCodeMatches("ABCDE12345", "")).toBe(false);
    expect(normalizeSetupCode("ab-cd e")).toBe("ABCDE");
  });

  it("links to the setup page on the node's public origin", () => {
    expect(setupLink("http://livs-air.local:8787/", "ABCDE12345")).toBe("http://livs-air.local:8787/login?setup=ABCDE-12345");
  });
});
