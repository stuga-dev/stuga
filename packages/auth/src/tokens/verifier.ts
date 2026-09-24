/** One token verifier per node, against its own signing key: sessions never depend on the network. */
import { createLocalJWKSet } from "jose";
import type { AuthConfig } from "./config.js";
import { LOCAL_TOKEN_ALG, publicJwks, type LocalKeys } from "./keys.js";
import { verifyClaims, type Principal } from "./verify.js";

export interface TokenVerifier {
  /** Throws AuthError. */
  verify(token: string): Promise<Principal>;
}

export function createVerifier(cfg: Pick<AuthConfig, "issuer" | "audience">, keys: LocalKeys): TokenVerifier {
  const keySet = createLocalJWKSet(publicJwks(keys));
  return { verify: (token) => verifyClaims(token, { issuer: cfg.issuer, audience: cfg.audience }, keySet, [LOCAL_TOKEN_ALG]) };
}
