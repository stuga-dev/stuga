/**
 * A person's access token, wherever a request presents one: verified for the listener it arrived on
 * (its `aud` names the one that issued it), then the sign-in it names (`sid`) looked up, on both
 * listeners, so a session that was signed out, revoked or renewed past its end is refused at once
 * rather than when the token runs out. The two routes that read a person's token, the request
 * context (./context.ts) and the identity routes' own `bearerSession`, both come through here.
 */
import { AuthError, type TokenVerifier } from "@stuga/auth";
import type { CredentialArrival, PresentedSession } from "@stuga/db";
import { arrivalOf, tokenArrival } from "../http/arrival.js";

export interface PersonToken {
  alias: string;
  /** The sign-in the token was minted for. */
  sid: string;
  /** The listener it was presented at, and so issued at. */
  arrival: CredentialArrival;
}

/** The token's claims, checked for this listener's audience; the session is not looked up. Throws AuthError. */
export async function personTokenClaims(verifier: TokenVerifier, req: Request, token: string): Promise<PersonToken> {
  const { alias, sid } = await verifier.verify(token, tokenArrival(req));
  return { alias, sid, arrival: arrivalOf(req) };
}

export interface PersonTokenDeps {
  verifier: TokenVerifier;
  sessionIsLive(session: PresentedSession): Promise<boolean>;
}

/** The token's claims, once its session is found live. Throws AuthError. */
export async function verifyPersonToken(deps: PersonTokenDeps, req: Request, token: string): Promise<PersonToken> {
  const claims = await personTokenClaims(deps.verifier, req, token);
  if (!(await deps.sessionIsLive({ sessionId: claims.sid, alias: claims.alias, arrival: claims.arrival }))) {
    throw new AuthError("this session has ended");
  }
  return claims;
}
