/** One token verifier per node, against its own signing key: sessions never depend on the network. */
import { createLocalJWKSet } from "jose";
import type { AuthConfig } from "./config.js";
import { LOCAL_TOKEN_ALG, publicJwks, type LocalKeys } from "./keys.js";
import { verifyClaims, type Principal } from "./verify.js";

/**
 * Where a token is presented, which is where it must have been issued: the node's own listener on
 * its network, or its remote address at `origin`. A token's `aud` names one or the other, so a
 * session signed in on one is refused on the other.
 */
export type TokenArrival = { arrival: "local" } | { arrival: "remote"; origin: string };

/** The `aud` a token issued at `where` carries. */
export function audienceFor(cfg: Pick<AuthConfig, "audience">, where: TokenArrival): string {
  return where.arrival === "remote" ? where.origin : cfg.audience;
}

export interface TokenVerifier {
  /** Throws AuthError, also for a token issued at the other listener. */
  verify(token: string, where: TokenArrival): Promise<Principal>;
}

export function createVerifier(cfg: Pick<AuthConfig, "issuer" | "audience">, keys: LocalKeys): TokenVerifier {
  const keySet = createLocalJWKSet(publicJwks(keys));
  return {
    verify: (token, where) => verifyClaims(token, { issuer: cfg.issuer, audience: audienceFor(cfg, where) }, keySet, [LOCAL_TOKEN_ALG]),
  };
}
