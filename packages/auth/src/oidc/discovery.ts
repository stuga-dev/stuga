/**
 * The identity provider's discovery document (OpenID Connect Discovery 1.0):
 * where to send a person, where to redeem a code, and which keys sign its id_tokens.
 */

/** A failure to talk to the identity provider, or an answer the node will not accept. */
export class ProviderError extends Error {
  /** A short tag for the log line; never carries a token or secret. */
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ProviderError";
    this.reason = reason;
  }
}

/** The fields the node reads from a discovery document. */
export interface ProviderMetadata {
  /** The provider's own spelling, which its id_tokens' `iss` must match exactly. */
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function stripOneSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/** An endpoint the document names: absolute http(s), and https whenever the issuer is. */
function endpoint(doc: Record<string, unknown>, name: string, issuerIsHttps: boolean): string {
  const raw = doc[name];
  if (typeof raw !== "string" || !raw) throw new ProviderError("discovery_incomplete", `the provider's discovery document has no ${name}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("discovery_invalid", `the provider's ${name} is not an absolute URL`);
  }
  if (url.protocol !== "https:" && (issuerIsHttps || url.protocol !== "http:")) {
    throw new ProviderError("discovery_invalid", `the provider's ${name} must be an https URL`);
  }
  return raw;
}

/**
 * Fetch and check `<issuer>/.well-known/openid-configuration`. The document's
 * `issuer` must be the one asked for (one trailing slash aside), it must offer
 * the authorization-code flow with PKCE S256 when it says what it offers, and
 * name all three endpoints. Throws ProviderError with a sentence an administrator can act on.
 */
export async function fetchProviderMetadata(issuer: string, opts: { timeoutMs?: number } = {}): Promise<ProviderMetadata> {
  const url = `${stripOneSlash(issuer)}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "did not answer in time" : "could not be reached";
    throw new ProviderError("discovery_unreachable", `the identity provider at ${url} ${why}`);
  }
  if (!res.ok) {
    throw new ProviderError("discovery_status", `the identity provider answered ${res.status} for ${url}`);
  }
  let doc: Record<string, unknown>;
  try {
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    doc = body as Record<string, unknown>;
  } catch {
    throw new ProviderError("discovery_invalid", `${url} is not a discovery document`);
  }

  const theirs = doc["issuer"];
  if (typeof theirs !== "string" || stripOneSlash(theirs) !== stripOneSlash(issuer)) {
    throw new ProviderError(
      "discovery_issuer",
      `the provider calls itself ${typeof theirs === "string" ? theirs : "nothing"}, not ${issuer}`,
    );
  }
  const responseTypes = stringList(doc["response_types_supported"]);
  if (responseTypes && !responseTypes.includes("code")) {
    throw new ProviderError("discovery_flow", "the provider does not offer the authorization-code flow");
  }
  const challengeMethods = stringList(doc["code_challenge_methods_supported"]);
  if (challengeMethods && !challengeMethods.includes("S256")) {
    throw new ProviderError("discovery_pkce", "the provider does not offer PKCE with S256");
  }
  const https = /^https:/i.test(theirs);
  const meta: ProviderMetadata = {
    issuer: theirs,
    authorization_endpoint: endpoint(doc, "authorization_endpoint", https),
    token_endpoint: endpoint(doc, "token_endpoint", https),
    jwks_uri: endpoint(doc, "jwks_uri", https),
  };
  const algs = stringList(doc["id_token_signing_alg_values_supported"]);
  if (algs) meta.id_token_signing_alg_values_supported = algs;
  const authMethods = stringList(doc["token_endpoint_auth_methods_supported"]);
  if (authMethods) meta.token_endpoint_auth_methods_supported = authMethods;
  return meta;
}
