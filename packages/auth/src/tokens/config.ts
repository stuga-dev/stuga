/**
 * How the node signs people in: it is its own token issuer and needs no
 * network. An identity provider, when one is configured, only vouches for a
 * person once at sign-in; the session it leads to is still one of these tokens.
 */
export interface AuthConfig {
  /** Issuer claim on minted tokens: the node's public origin. */
  issuer: string;
  /** Audience claim on minted tokens. */
  audience: string;
  /** Path of the signing key (JWK, created on first boot if absent). */
  keyFile: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /**
   * How long a rotated refresh token may still be presented without counting as
   * a replay (which revokes every session). Two tabs renewing at once, or a lost
   * renewal response, look like a replay; inside this window the node issues a
   * sibling session instead. 0 means strict one-use.
   */
  refreshRotationGraceSeconds: number;
}
