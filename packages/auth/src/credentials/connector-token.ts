/**
 * The tokens an OAuth grant hands a connector: `sto_` access tokens and `str_`
 * refresh tokens. Opaque random strings; only their sha-256 is stored.
 */
import { randomBase64url, sha256Hex } from "../crypto.js";

export type ConnectorTokenKind = "access" | "refresh";

const PREFIX: Record<ConnectorTokenKind, string> = { access: "sto_", refresh: "str_" };

/** Which kind a bearer string claims to be, so API keys and session JWTs never reach the token path. */
export function connectorTokenKind(token: string): ConnectorTokenKind | null {
  if (token.startsWith(PREFIX.access)) return "access";
  if (token.startsWith(PREFIX.refresh)) return "refresh";
  return null;
}

export function hashConnectorToken(token: string): string {
  return sha256Hex(token);
}

/** 32 random bytes behind the kind's prefix, with the stored hash. */
export function mintConnectorToken(kind: ConnectorTokenKind): { token: string; hash: string } {
  const token = `${PREFIX[kind]}${randomBase64url(32)}`;
  return { token, hash: hashConnectorToken(token) };
}
