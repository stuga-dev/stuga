/**
 * The local issuer's ES256 signing key: a private JWK created on first boot,
 * owner-readable only, with the RFC 7638 thumbprint as its `kid`.
 */
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type KeyObject,
} from "jose";
import { readJsonFile, writeJsonFileExclusive } from "./files.js";

export const LOCAL_TOKEN_ALG = "ES256";

export interface LocalKeys {
  kid: string;
  privateKey: CryptoKey | KeyObject;
  /** What the JWKS route serves. */
  publicJwk: JWK;
}

function isPrivateEcJwk(v: unknown): v is JWK & { kty: "EC"; crv: string; x: string; y: string; d: string } {
  if (typeof v !== "object" || v === null) return false;
  const j = v as Record<string, unknown>;
  return (
    j["kty"] === "EC" &&
    typeof j["crv"] === "string" &&
    typeof j["x"] === "string" &&
    typeof j["y"] === "string" &&
    typeof j["d"] === "string"
  );
}

function publicPart(jwk: JWK, kid: string): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, alg: LOCAL_TOKEN_ALG, use: "sig" };
}

async function fromStoredJwk(stored: JWK): Promise<LocalKeys> {
  const kid = stored.kid ?? (await calculateJwkThumbprint(stored));
  const privateKey = await importJWK(stored, LOCAL_TOKEN_ALG);
  if (privateKey instanceof Uint8Array) throw new Error("signing key must be an EC key pair, not a secret");
  return { kid, privateKey, publicJwk: publicPart(stored, kid) };
}

/** Load the signing key, creating it when absent. Anything else in the file is refused, never overwritten. */
export async function loadOrCreateSigningKey(keyFile: string): Promise<LocalKeys> {
  const existing = await readJsonFile(keyFile);
  if (existing !== null) {
    if (!isPrivateEcJwk(existing)) throw new Error(`${keyFile} is not a private EC JWK`);
    return fromStoredJwk(existing);
  }

  const { privateKey } = await generateKeyPair(LOCAL_TOKEN_ALG, { extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(jwk);
  const stored: JWK = { ...jwk, kid, alg: LOCAL_TOKEN_ALG, use: "sig" };
  delete stored.ext;
  delete stored.key_ops;

  if (!(await writeJsonFileExclusive(keyFile, stored, 0o600))) {
    // Another boot created it between our read and write; theirs wins.
    const theirs = await readJsonFile(keyFile);
    if (!isPrivateEcJwk(theirs)) throw new Error(`${keyFile} is not a private EC JWK`);
    return fromStoredJwk(theirs);
  }
  return { kid, privateKey, publicJwk: publicPart(stored, kid) };
}

export function publicJwks(keys: LocalKeys): JSONWebKeySet {
  return { keys: [keys.publicJwk] };
}

interface AccessTokenClaims {
  /** Becomes `sub`. */
  alias: string;
  /** Becomes `preferred_username`. No email is minted: a local account's address is unverified profile data. */
  username: string;
  displayName: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

/** A node-signed access token, whoever signed the person in: sub, preferred_username, name, token_use. */
export async function signAccessToken(keys: LocalKeys, claims: AccessTokenClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    name: claims.displayName,
    preferred_username: claims.username,
    token_use: "access",
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: LOCAL_TOKEN_ALG, kid: keys.kid, typ: "JWT" })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setSubject(claims.alias)
    .setIssuedAt(now)
    .setExpirationTime(now + claims.ttlSeconds)
    .sign(keys.privateKey);
}
