/**
 * Passkeys, at the remote address only (/auth/config's `passkey`): signing in, by the button or from
 * the browser's autofill on the username field, confirming a session, and adding one. The node signs
 * every challenge; this only carries it to the browser and back.
 */
import {
  WebAuthnAbortService,
  WebAuthnError,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { authConfig } from "./auth-config";
import { authRequest } from "./auth-request";
import { AuthError } from "./errors";
import { authPost, ensureFreshToken, type Session } from "./tokens";
import { t } from "../../i18n/i18n";

/** Passkeys are offered here: the node says so (its remote address), and this browser has WebAuthn. */
export function passkeysOffered(): boolean {
  return authConfig().passkey && browserSupportsWebAuthn();
}

/** Whether the browser offers passkeys among the username field's autofill. */
export function passkeyAutofillAvailable(): Promise<boolean> {
  return passkeysOffered() ? browserSupportsWebAuthnAutofill().catch(() => false) : Promise.resolve(false);
}

/** A ceremony the person ended, or that another took over: nothing to say about it. */
export class PasskeyCancelled extends Error {
  constructor() {
    super(t("auth.errors.passkeyCancelled"));
    this.name = "PasskeyCancelled";
  }
}

/** The browser's failure as one of ours: a cancel, an authenticator holding one already, or a plain refusal. */
function fromBrowser(err: unknown): Error {
  if (err instanceof WebAuthnError) {
    if (err.code === "ERROR_CEREMONY_ABORTED") return new PasskeyCancelled();
    if (err.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return new AuthError(409, "passkey_exists");
  }
  if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) return new PasskeyCancelled();
  return err instanceof Error ? err : new Error(String(err));
}

async function bearer(): Promise<string> {
  const token = await ensureFreshToken();
  if (!token) throw new AuthError(401, "invalid_token");
  return token;
}

async function requestOptions(purpose: "sign-in" | "reauth", token?: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const res = await authRequest<{ publicKey: PublicKeyCredentialRequestOptionsJSON }>("/auth/passkey/options", { purpose }, token);
  if (!res?.publicKey) throw new AuthError(200, t("auth.errors.noPasskeyChallenge"));
  return res.publicKey;
}

/**
 * Sign in with a passkey: `autofill` waits for the person to pick one in the username field's
 * suggestions (and is cancelled by any other ceremony, such as the button's), otherwise the browser
 * asks at once. Throws PasskeyCancelled when the prompt closes.
 */
export async function signInWithPasskey(opts: { autofill?: boolean } = {}): Promise<Session> {
  const optionsJSON = await requestOptions("sign-in");
  let credential;
  try {
    credential = await startAuthentication({ optionsJSON, useBrowserAutofill: opts.autofill === true });
  } catch (err) {
    throw fromBrowser(err);
  }
  const tokens = await authPost("/auth/passkey/sign-in", { credential });
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in };
}

/** Stop a waiting autofill sign-in, as leaving the page does. */
export function cancelPasskeyAutofill(): void {
  WebAuthnAbortService.cancelCeremony();
}

/** Confirm it's you with a passkey of this account: the session counts as confirmed for five minutes. */
export async function confirmWithPasskey(): Promise<void> {
  const token = await bearer();
  const optionsJSON = await requestOptions("reauth", token);
  let credential;
  try {
    credential = await startAuthentication({ optionsJSON });
  } catch (err) {
    throw fromBrowser(err);
  }
  await authRequest("/auth/passkey/sign-in", { credential }, token);
}

/** What the node named a passkey just added. */
export interface AddedPasskey {
  id: string;
  name: string;
  synced: boolean;
}

/**
 * Add a passkey for this address from the signed-in session, which must have been confirmed in the
 * last five minutes: the node answers reauth_required otherwise, which the caller confirms and retries
 * (lib/session/reauth.ts withConfirmation).
 */
export async function addPasskey(): Promise<AddedPasskey> {
  const token = await bearer();
  const res = await authRequest<{ publicKey: PublicKeyCredentialCreationOptionsJSON }>("/auth/passkey/options", { purpose: "add" }, token);
  if (!res?.publicKey) throw new AuthError(200, t("auth.errors.noPasskeyChallenge"));
  let credential;
  try {
    credential = await startRegistration({ optionsJSON: res.publicKey });
  } catch (err) {
    throw fromBrowser(err);
  }
  const added = await authRequest<AddedPasskey>("/auth/passkey/add", { credential }, token);
  if (!added) throw new AuthError(200, t("auth.errors.passkeyNotAddedByServer"));
  return added;
}
