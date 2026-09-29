/**
 * The keys remote access keeps under `DATA_DIR/secrets` (docs/remote-access.md): the binding key
 * that signs every request to the service, and one ACME account key per CA directory. A binding
 * key is written to disk before the service ever sees it, and none is ever deleted: a replaced one
 * is renamed and kept.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir, syncDir, writeFileDurable } from "./files.js";

export const BINDING_KEY_FILE = "remote-binding.jwk";
export const PENDING_BINDING_KEY_FILE = "remote-binding.pending.jwk";

export interface BindingKey {
  privateKey: KeyObject;
  /** The public key, base64url: the JWK's `x`. */
  x: string;
  /** RFC 7638, which the service knows the key by. */
  thumbprint: string;
}

const b64u = (bytes: Buffer | string): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: string | Buffer): Buffer => createHash("sha256").update(data).digest();

/** RFC 7638 over an Ed25519 public key: the required members in lexicographic order, no whitespace. */
export function okpThumbprint(x: string): string {
  return b64u(sha256(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })));
}

/** RFC 7638 over an EC public key. */
export function ecThumbprint(jwk: { crv: string; x: string; y: string }): string {
  return b64u(sha256(JSON.stringify({ crv: jwk.crv, kty: "EC", x: jwk.x, y: jwk.y })));
}

export function secretsDir(dataDir: string): string {
  return join(dataDir, "secrets");
}

function bindingKeyOf(jwk: { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown }): BindingKey {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("not an Ed25519 private key");
  }
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, format: "jwk" });
  return { privateKey, x: jwk.x, thumbprint: okpThumbprint(jwk.x) };
}

/** A binding key file is there but cannot be read or is not a key: truncated, say, or edited by hand. */
export class UnreadableKey extends Error {
  constructor(
    readonly path: string,
    why: string,
  ) {
    super(`${path} can't be read: ${why}`);
  }
}

async function readKeyFile(path: string): Promise<BindingKey | null> {
  try {
    return bindingKeyOf(JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UnreadableKey(path, (e as Error).message);
  }
}

/** The binding key in use, or null before the node is bound or after it was lost; UnreadableKey when the file is damaged. */
export function readBindingKey(dataDir: string): Promise<BindingKey | null> {
  return readKeyFile(join(secretsDir(dataDir), BINDING_KEY_FILE));
}

export function readPendingBindingKey(dataDir: string): Promise<BindingKey | null> {
  return readKeyFile(join(secretsDir(dataDir), PENDING_BINDING_KEY_FILE));
}

/**
 * The key an enrollment or a rebind presents: the one a failed attempt left, so a retry with the
 * same code is the same request to the service, or a new one, on disk before this returns.
 */
export async function pendingBindingKey(dataDir: string): Promise<BindingKey> {
  const existing = await readPendingBindingKey(dataDir);
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  await ensurePrivateDir(secretsDir(dataDir), 0o700);
  await writeFileDurable(
    join(secretsDir(dataDir), PENDING_BINDING_KEY_FILE),
    `${JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d })}\n`,
    0o600,
  );
  return bindingKeyOf({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d });
}

/**
 * Make the pending key the binding key, once the service and the database both have it. The key it
 * replaces is kept as `remote-binding.retired-<unix>.jwk`. With no pending key, as when another
 * caller promoted it first, nothing changes.
 */
export async function promotePendingKey(dataDir: string, now: Date): Promise<void> {
  const dir = secretsDir(dataDir);
  const pending = join(dir, PENDING_BINDING_KEY_FILE);
  if (!(await exists(pending))) return;
  const current = join(dir, BINDING_KEY_FILE);
  if (await exists(current)) {
    let unix = Math.floor(now.getTime() / 1000);
    while (await exists(join(dir, `remote-binding.retired-${unix}.jwk`))) unix += 1;
    await rename(current, join(dir, `remote-binding.retired-${unix}.jwk`));
  }
  await rename(pending, current);
  await syncDir(dir);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** A fresh certificate key. */
export function generateP256(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
}

export function pkcs8Pem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** SHA-256 over a key's SubjectPublicKeyInfo DER, hex: what the self-check compares. */
export function spkiSha256(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return sha256(publicKey.export({ type: "spki", format: "der" })).toString("hex");
}

/** `remote-acme-<first 16 hex of sha256(directory URL)>.jwk`: one account key per CA directory. */
export function acmeAccountKeyFile(directoryUrl: string): string {
  return `remote-acme-${sha256(directoryUrl).toString("hex").slice(0, 16)}.jwk`;
}

/** The P-256 key of this directory's ACME account, created on first use. */
export async function loadOrCreateAcmeAccountKey(dataDir: string, directoryUrl: string): Promise<KeyObject> {
  const path = join(secretsDir(dataDir), acmeAccountKeyFile(directoryUrl));
  try {
    const jwk = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    return createPrivateKey({ key: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! }, format: "jwk" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const key = generateP256();
  const { x, y, d } = key.export({ format: "jwk" }) as Record<string, string>;
  await ensurePrivateDir(secretsDir(dataDir), 0o700);
  await writeFileDurable(path, `${JSON.stringify({ kty: "EC", crv: "P-256", x, y, d })}\n`, 0o600);
  return key;
}
