/**
 * The node as an OpenID Connect relying party, running the authorization-code
 * flow itself: PKCE S256, `state` and `nonce` on the way out; on the way back
 * one code exchange and one id_token check, after which the provider is done.
 * The provider's tokens are never kept and never become a credential here.
 */
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { isEmailShaped } from "@stuga/protocol/domain/username";
import { constantTimeEqual, randomBase64url } from "../crypto.js";
import { DEFAULT_TIMEOUT_MS, ProviderError, fetchProviderMetadata, type ProviderMetadata } from "./discovery.js";

/** One provider as the node is registered with it. */
export interface ProviderClient {
  issuer: string;
  clientId: string;
  /** Null for a public client, which PKCE alone protects. */
  clientSecret?: string | null;
  /** Space-separated; must include `openid`. */
  scopes: string;
}

/** What a start hands the caller to keep until the callback. */
export interface AuthorizationStart {
  /** The provider's authorization endpoint, with every parameter set. */
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The person an id_token vouches for. Everything but `sub` is a hint, shape-checked and capped. */
export interface ProviderIdentity {
  sub: string;
  preferredUsername: string | null;
  name: string | null;
  email: string | null;
}

/** The OpenID Connect `prompt` values a sign-in may send. */
export type AuthorizationPrompt = "none" | "select_account";

export interface RelyingParty {
  /**
   * Build the authorization request. `prompt`: "none" for a silent answer, "select_account" to have the
   * provider ask which account rather than reuse its session. Throws ProviderError when discovery fails
   * and no earlier answer is cached.
   */
  start(client: ProviderClient, request: { redirectUri: string; prompt?: AuthorizationPrompt }): Promise<AuthorizationStart>;
  /** Redeem the code and verify the id_token against what `start` returned. Throws ProviderError. */
  finish(
    client: ProviderClient,
    response: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
  ): Promise<ProviderIdentity>;
}

/** Signature algorithms an id_token may use: asymmetric only, so neither `none` nor a secret-keyed HS* ever passes. */
const ASYMMETRIC_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];

/** How long a discovery document is trusted before it is fetched again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** An id_token older than a sign-in can take was not minted for this one. */
const MAX_ID_TOKEN_AGE_S = 10 * 60;

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The algorithms the provider advertises that the node accepts; RS256, the specification's default, when it says nothing. */
function allowedAlgorithms(meta: ProviderMetadata): string[] {
  const advertised = meta.id_token_signing_alg_values_supported;
  if (!advertised) return ["RS256"];
  const usable = advertised.filter((a) => ASYMMETRIC_ALGS.includes(a));
  if (usable.length === 0) throw new ProviderError("id_token_alg", "the provider signs id_tokens with no algorithm the node accepts");
  return usable;
}

/** application/x-www-form-urlencoded, as RFC 6749 §2.3.1 asks of Basic credentials. */
function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

/** client_secret_basic unless the provider offers only client_secret_post; a public client sends its id alone. */
function clientAuth(meta: ProviderMetadata, client: ProviderClient): "client_secret_basic" | "client_secret_post" | "none" {
  if (!client.clientSecret) return "none";
  const offered = meta.token_endpoint_auth_methods_supported;
  if (offered && !offered.includes("client_secret_basic") && offered.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

/** A claim as display text: a control character is a word break, an invisible one is dropped; capped, null when empty. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, max).trim();
  return cleaned || null;
}

export function createRelyingParty(opts: { timeoutMs?: number; discoveryTtlMs?: number } = {}): RelyingParty {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts.discoveryTtlMs ?? DISCOVERY_TTL_MS;
  const documents = new Map<string, { meta: ProviderMetadata; fetchedAt: number }>();
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  /** The cached document while fresh; the last good one when a refresh fails, so a provider blip does not stop sign-ins. */
  async function discover(issuer: string): Promise<ProviderMetadata> {
    const cached = documents.get(issuer);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.meta;
    try {
      const meta = await fetchProviderMetadata(issuer, { timeoutMs });
      documents.set(issuer, { meta, fetchedAt: Date.now() });
      return meta;
    } catch (err) {
      if (cached) return cached.meta;
      throw err;
    }
  }

  function keySet(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    let set = keySets.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: timeoutMs, cooldownDuration: 30_000 });
      keySets.set(jwksUri, set);
    }
    return set;
  }

  async function redeem(meta: ProviderMetadata, client: ProviderClient, code: string, redirectUri: string, codeVerifier: string): Promise<string> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    const method = clientAuth(meta, client);
    if (method === "client_secret_basic") {
      const pair = `${formEncode(client.clientId)}:${formEncode(client.clientSecret!)}`;
      headers["authorization"] = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else if (method === "client_secret_post") {
      body.set("client_id", client.clientId);
      body.set("client_secret", client.clientSecret!);
    } else {
      body.set("client_id", client.clientId);
    }

    let res: Response;
    try {
      res = await fetch(meta.token_endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new ProviderError("token_unreachable", "the provider's token endpoint could not be reached");
    }
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      // The error code only: an error_description can echo what was sent.
      const code = typeof answer?.["error"] === "string" ? answer["error"].slice(0, 64) : String(res.status);
      throw new ProviderError(`token_${code}`, "the provider refused to redeem the authorization code");
    }
    const idToken = answer?.["id_token"];
    if (typeof idToken !== "string" || !idToken) throw new ProviderError("token_no_id_token", "the provider's answer carried no id_token");
    return idToken;
  }

  async function verifyIdToken(meta: ProviderMetadata, client: ProviderClient, idToken: string, nonce: string): Promise<JWTPayload> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, keySet(meta.jwks_uri), {
        issuer: meta.issuer,
        audience: client.clientId,
        algorithms: allowedAlgorithms(meta),
        requiredClaims: ["sub", "iat", "exp", "nonce"],
        maxTokenAge: MAX_ID_TOKEN_AGE_S,
        clockTolerance: 60,
      }));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("id_token_invalid", `the id_token did not verify: ${(err as Error).message}`);
    }
    // OpenID Connect Core §3.1.3.7: with several audiences the authorized party must be this client, and whenever it is named.
    const aud = payload.aud;
    if ((Array.isArray(aud) && aud.length > 1) || payload["azp"] !== undefined) {
      if (payload["azp"] !== client.clientId) throw new ProviderError("id_token_azp", "the id_token was issued to another client");
    }
    const claimed = payload["nonce"];
    if (typeof claimed !== "string" || !constantTimeEqual(claimed, nonce)) {
      throw new ProviderError("id_token_nonce", "the id_token answers a different sign-in");
    }
    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) {
      throw new ProviderError("id_token_sub", "the id_token names no usable subject");
    }
    return payload;
  }

  return {
    async start(client, request) {
      const meta = await discover(client.issuer);
      const state = randomBase64url(32);
      const nonce = randomBase64url(32);
      const codeVerifier = randomBase64url(32);
      const url = new URL(meta.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", request.redirectUri);
      url.searchParams.set("scope", client.scopes);
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      if (request.prompt) url.searchParams.set("prompt", request.prompt);
      return { url: url.toString(), state, nonce, codeVerifier };
    },

    async finish(client, response) {
      const meta = await discover(client.issuer);
      const idToken = await redeem(meta, client, response.code, response.redirectUri, response.codeVerifier);
      const payload = await verifyIdToken(meta, client, idToken, response.nonce);
      const email = text(payload["email"], 254);
      return {
        sub: payload.sub!,
        preferredUsername: text(payload["preferred_username"], 256),
        name: text(payload["name"], 200),
        // Unverified contact detail like any other; shape-checked because it can reach an SMTP envelope.
        email: email && isEmailShaped(email) ? email : null,
      };
    },
  };
}
