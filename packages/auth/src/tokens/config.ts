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
  /** How long a session on the node's own network lasts unused; each renewal starts it again. */
  refreshTokenTtlSeconds: number;
  /**
   * At the remote address: how long a session lasts unused, and how long it lasts at all from the
   * sign-in that began it (one through the identity provider has its own, shorter, limit). Renewal
   * never moves the second. Defaults: REMOTE_SESSION_DEFAULTS.
   */
  remoteRefreshTokenTtlSeconds?: number;
  remoteSessionMaxSeconds?: number;
  remoteProviderSessionMaxSeconds?: number;
  /**
   * How long a rotated refresh token may still be presented without counting as
   * a replay (which revokes every session). Two tabs renewing at once, or a lost
   * renewal response, look like a replay; inside this window the node issues a
   * sibling session instead. 0 means strict one-use.
   */
  refreshRotationGraceSeconds: number;
}

/** Seven days unused, thirty days in all, twelve hours for a sign-in through the identity provider. */
export const REMOTE_SESSION_DEFAULTS = {
  remoteRefreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  remoteSessionMaxSeconds: 30 * 24 * 60 * 60,
  remoteProviderSessionMaxSeconds: 12 * 60 * 60,
} as const;
