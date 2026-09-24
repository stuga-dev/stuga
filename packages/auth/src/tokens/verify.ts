/**
 * The claim rules for the node's own access tokens. Identity only: the
 * person's name, groups and ACLs are resolved from the database, never read from the token.
 */
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface ClaimRules {
  /** Expected `iss`. */
  issuer: string;
  /** Expected `aud`. */
  audience: string;
}

export interface Principal {
  /** The account's alias, from `sub`. */
  alias: string;
  claims: JWTPayload;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Verify signature, issuer, audience and expiry with `getKey`, and that it is an access token. */
export async function verifyClaims(
  token: string,
  rules: ClaimRules,
  getKey: JWTVerifyGetKey,
  algorithms: string[],
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: rules.issuer,
      audience: rules.audience,
      algorithms,
      clockTolerance: 5,
    }));
  } catch (err) {
    throw new AuthError(`token verification failed: ${(err as Error).message}`);
  }
  if (payload["token_use"] !== "access") {
    throw new AuthError(`expected token_use=access, got ${String(payload["token_use"])}`);
  }
  const alias = payload.sub;
  if (typeof alias !== "string" || alias.length === 0) throw new AuthError("missing sub claim");
  return { alias, claims: payload };
}

/** The bearer token from the Authorization header; query parameters and cookies are ignored. */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  const bearer = auth?.match(/^Bearer[ \t]+(\S+)[ \t]*$/i);
  return bearer ? bearer[1]! : null;
}
