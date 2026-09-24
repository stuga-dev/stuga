/**
 * The setup code: what proves the right to claim a node nobody has claimed yet.
 * Without it the first visitor to reach the node would become its
 * administrator, and a node on a network is reachable by everyone on it.
 *
 * It lives in `DATA_DIR/setup-code` until the node is claimed, so a restart
 * keeps it and the packaging can read it to open the setup page for whoever
 * installed the node. The node prints it in its log at every start.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Crockford's base32: no I, L, O or U, so it reads aloud and types without confusion. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 10 characters, about 50 bits: out of reach at the auth endpoints' rate limit. */
const LENGTH = 10;

export const SETUP_CODE_FILE = "setup-code";

function newCode(): string {
  let code = "";
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** A code as it is shown: two groups of five, `ABCDE-FGHJK`. */
export function formatSetupCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** The page that sets up the node, with its code filled in. */
export function setupLink(publicOrigin: string, code: string): string {
  return `${publicOrigin.replace(/\/$/, "")}/login?setup=${formatSetupCode(code)}`;
}

/** What a person typed, reduced to the code's characters: case, spaces and dashes do not matter, nor O for 0 or I and L for 1. */
export function normalizeSetupCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-Z]/g, "");
}

/** Whether `given` is `expected`, compared in constant time. False when there is no code to compare with. */
export function setupCodeMatches(expected: string | null, given: unknown): boolean {
  if (!expected || typeof given !== "string") return false;
  const digest = (s: string) => createHash("sha256").update(normalizeSetupCode(s)).digest();
  return timingSafeEqual(digest(expected), digest(given));
}

/** The code kept in `dataDir`, or a new one written there (owner-only) when there is none. */
export async function loadOrCreateSetupCode(dataDir: string): Promise<string> {
  const path = join(dataDir, SETUP_CODE_FILE);
  const kept = normalizeSetupCode(await readFile(path, "utf8").catch(() => ""));
  if (kept.length === LENGTH) return kept;
  const code = newCode();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${formatSetupCode(code)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return code;
}

/** Forget the code once the node is claimed. */
export async function removeSetupCode(dataDir: string): Promise<void> {
  await rm(join(dataDir, SETUP_CODE_FILE), { force: true });
}
