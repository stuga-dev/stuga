/**
 * Passkeys (WebAuthn), through @simplewebauthn/server: the only place the node touches the library.
 * The relying party is one host, given by the caller (the remote address's hostname), never a
 * parent domain, and only its exact `https://` origin is accepted. Every passkey is discoverable and
 * verifies the person (`userVerification: "required"`); attestation is not asked for, so nothing is
 * fetched about the authenticator. A credential's backup eligibility (BE) is fixed at registration:
 * an assertion that reports another is refused, as is one that is backed up (BS) without being
 * eligible.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";

export type { AuthenticationResponseJSON, RegistrationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON };

/** Ed25519, ES256, RS256, in the order a browser should prefer them. */
export const PASSKEY_ALGORITHMS = [-8, -7, -257] as const;
export type PasskeyAlgorithmId = (typeof PASSKEY_ALGORITHMS)[number];

/** How long a ceremony may take, and a challenge last. */
export const PASSKEY_TIMEOUT_MS = 5 * 60 * 1000;

/** The longest credential id kept, base64url. */
export const MAX_CREDENTIAL_ID = 1400;

/** The relying party: one host, and the one origin it is served on. */
export interface PasskeySite {
  /** The hostname, lowercase, no port. */
  rpId: string;
  /** `https://<rpId>`, exactly; a test's `http://<name>.localhost:<port>`. */
  origin: string;
  /** Shown by the browser: the node's name. */
  rpName: string;
}

/** A credential id and the transports the browser may reach it by. */
export interface CredentialDescriptor {
  id: string;
  transports: string[];
}

/** Any reason a passkey response is refused: its detail is for the log, never the caller. */
export class PasskeyInvalid extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PasskeyInvalid";
  }
}

const enc = new TextEncoder();

/** A person's WebAuthn user handle: their alias, which is random and never changes (T6). */
export function userHandleOf(alias: string): string {
  return Buffer.from(alias, "utf8").toString("base64url");
}

/** The challenge a response signed, as the browser reported it (base64url), or null when it cannot be read. */
export function challengeOf(response: unknown): string | null {
  const data = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof data !== "string" || data.length > 8192) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

/** The text a challenge carried, from what challengeOf read; null when it is not base64url. */
export function challengeText(challenge: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(challenge)) return null;
  return Buffer.from(challenge, "base64url").toString("utf8");
}

/** Options for adding a passkey. `challenge` is the text to sign (a ticket the caller verifies later). */
export async function creationOptions(input: {
  site: PasskeySite;
  user: { alias: string; username: string; displayName: string };
  challenge: string;
  /** The person's passkeys at this host already, so an authenticator holding one says so. */
  exclude: CredentialDescriptor[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: input.site.rpName,
    rpID: input.site.rpId,
    userName: input.user.username,
    userID: enc.encode(input.user.alias),
    userDisplayName: input.user.displayName,
    challenge: input.challenge,
    timeout: PASSKEY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: input.exclude.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
  });
}

/** Options for signing in (no `allow`: any passkey for this host) or confirming (`allow`: the person's). */
export async function requestOptions(input: {
  site: PasskeySite;
  challenge: string;
  allow?: CredentialDescriptor[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.site.rpId,
    challenge: enc.encode(input.challenge),
    timeout: PASSKEY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: (input.allow ?? []).map((c) => ({ id: c.id, transports: c.transports })),
  });
}

/** A passkey just made, as the node keeps it. */
export interface CreatedPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  algorithm: PasskeyAlgorithmId;
  signCount: number;
  transports: string[];
  /** BE: it may be synced to other devices. Never changes. */
  backupEligible: boolean;
  /** BS: it is synced now. */
  synced: boolean;
}

const KNOWN_TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The shape every response must have before the library sees it. */
function checkShape(response: unknown): asserts response is { id: string; rawId: string; type: string; response: Record<string, unknown> } {
  if (!isObject(response) || !isObject(response.response)) throw new PasskeyInvalid("not a credential");
  if (typeof response.id !== "string" || response.id.length === 0 || response.id.length > MAX_CREDENTIAL_ID) {
    throw new PasskeyInvalid("bad credential id");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(response.id) || response.rawId !== response.id) throw new PasskeyInvalid("bad credential id");
  if (response.type !== "public-key") throw new PasskeyInvalid("not a public key credential");
}

/**
 * Check a new passkey: made for this host at its own origin, signing `challenge` (as the response's
 * client data carries it, base64url, which the caller has checked is its own), with the person
 * verified, by an algorithm on the list. Throws PasskeyInvalid.
 */
export async function verifyCreation(input: { site: PasskeySite; response: unknown; challenge: string }): Promise<CreatedPasskey> {
  checkShape(input.response);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: input.challenge,
      expectedOrigin: input.site.origin,
      expectedRPID: input.site.rpId,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    });
  } catch (err) {
    throw new PasskeyInvalid(err instanceof Error ? err.message : String(err));
  }
  if (!verified.verified) throw new PasskeyInvalid("not verified");
  const info = verified.registrationInfo;
  if (!info.userVerified) throw new PasskeyInvalid("the person was not verified");
  if (info.credential.id !== input.response.id) throw new PasskeyInvalid("credential id mismatch");
  const key = decodeCredentialPublicKey(info.credential.publicKey);
  const algorithm = key.get(cose.COSEKEYS.alg);
  if (!PASSKEY_ALGORITHMS.includes(algorithm as PasskeyAlgorithmId)) throw new PasskeyInvalid("algorithm not allowed");
  const transports = (info.credential.transports ?? []).filter((t) => KNOWN_TRANSPORTS.has(t)).slice(0, 8);
  return {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    algorithm: algorithm as PasskeyAlgorithmId,
    signCount: info.credential.counter,
    transports,
    backupEligible: info.credentialDeviceType === "multiDevice",
    synced: info.credentialBackedUp,
  };
}

/** A stored passkey, as an assertion is checked against it. */
export interface StoredPasskey {
  credentialId: string;
  /** The alias it belongs to: the response's user handle must name it. */
  alias: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  backupEligible: boolean;
}

/**
 * Check a sign-in: by `stored`, for this host at its own origin, signing `challenge` (base64url, as
 * for verifyCreation), with the person
 * verified and the user handle naming the passkey's own account; its counter moved on unless both
 * are zero, and BE as at registration. Throws PasskeyInvalid. The counter and BS to store.
 */
export async function verifyAssertion(input: {
  site: PasskeySite;
  response: unknown;
  challenge: string;
  stored: StoredPasskey;
}): Promise<{ signCount: number; synced: boolean }> {
  checkShape(input.response);
  if (input.response.id !== input.stored.credentialId) throw new PasskeyInvalid("another credential");
  const handle = input.response.response.userHandle;
  if (typeof handle !== "string" || handle !== userHandleOf(input.stored.alias)) throw new PasskeyInvalid("user handle mismatch");
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: input.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: input.challenge,
      expectedOrigin: input.site.origin,
      expectedRPID: input.site.rpId,
      expectedType: "webauthn.get",
      requireUserVerification: true,
      credential: {
        id: input.stored.credentialId,
        publicKey: new Uint8Array(input.stored.publicKey),
        counter: input.stored.signCount,
        transports: input.stored.transports,
      },
    });
  } catch (err) {
    throw new PasskeyInvalid(err instanceof Error ? err.message : String(err));
  }
  if (!verified.verified) throw new PasskeyInvalid("not verified");
  const info = verified.authenticationInfo;
  if (!info.userVerified) throw new PasskeyInvalid("the person was not verified");
  if ((info.credentialDeviceType === "multiDevice") !== input.stored.backupEligible) {
    throw new PasskeyInvalid("backup eligibility changed");
  }
  return { signCount: info.newCounter, synced: info.credentialBackedUp };
}
