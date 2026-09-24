/**
 * Secrets on disk under `<DATA_DIR>/secrets`, never in Postgres: a database dump
 * travels to places the data directory does not. 0700 on the directory and 0600
 * on each file.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBase64url } from "@stuga/auth";

/** Read a secret, or null when it has never been written. */
export function readSecretFile(dataDir: string, name: string): string | null {
  try {
    const v = readFileSync(resolve(dataDir, "secrets", name), "utf8").trim();
    return v.length > 0 ? v : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return null;
  }
}

export function writeSecretFile(dataDir: string, name: string, value: string): void {
  const file = resolve(dataDir, "secrets", name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "w" });
}

/** Remove a secret; an absent one is already gone. */
export function removeSecretFile(dataDir: string, name: string): void {
  rmSync(resolve(dataDir, "secrets", name), { force: true });
}

/**
 * The HMAC root for socket tickets, media tickets and upload signatures:
 * generated once (32 random bytes) and kept at `secrets/internal`, so every
 * restart presents the same value.
 */
export function loadOrCreateInternalSecret(dataDir: string): string {
  const stored = readSecretFile(dataDir, "internal");
  if (stored && stored.length >= 32) return stored;
  const secret = randomBase64url(32);
  writeSecretFile(dataDir, "internal", secret);
  return secret;
}
