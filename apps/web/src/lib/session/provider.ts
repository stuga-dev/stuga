/**
 * Sign-in through the node's identity provider. The node runs the exchange
 * itself; the browser only follows the address /auth/oidc/start returns, and
 * comes back to /auth/complete, /auth/first-visit, or with ?provider= on the
 * page that started it.
 */
import { readStored, removeStored, writeStored } from "../storage";
import { nodeUnclaimed, providerLabel } from "./auth-config";
import { authRequest } from "./auth-request";
import { usableDestination } from "./return-path";
import { AuthError } from "./errors";

/** Set by a sign-in through the provider, so the login page can try one without a prompt. */
const HINT_KEY = "stuga_sso_hint";
/**
 * Set by signing out, so the next sign-in through the provider asks which
 * account to use: the provider still has its own session, and would otherwise
 * hand back the identity that just signed out.
 */
const SELECT_ACCOUNT_KEY = "stuga_sso_select_account";
/** Marks a link to the provider under way in this tab, so a flow that expires at the node still comes back to Profile. */
const LINK_PENDING_KEY = "stuga_sso_link_pending";
/** Marks a silent attempt across its round trip, so its failure shows no banner and is not retried. */
const SILENT_KEY = "stuga_sso_silent";
/** When this tab last tried: a session the node keeps refusing must not become a sign-in loop across page loads. */
const SILENT_AT_KEY = "stuga_sso_silent_at";
const SILENT_SPACING_MS = 60_000;

/** Held in memory, so a page load tries at most once even when storage refuses the mark. */
let silentTried = false;

export function hasSsoHint(): boolean {
  return readStored("local", HINT_KEY) === "1";
}

/** A sign-in through the provider succeeded: the next one may be silent, and any choice of account after a sign-out is made. */
export function setSsoHint(): void {
  writeStored("local", HINT_KEY, "1");
  removeStored("local", SELECT_ACCOUNT_KEY);
}

/** On a failed silent attempt, and on sign-out: otherwise the login page would sign straight back in. */
export function clearSsoHint(): void {
  removeStored("local", HINT_KEY);
}

/** Signing out: no silent sign-in, and the next sign-in through the provider asks for the account. */
export function noteSignOut(): void {
  clearSsoHint();
  writeStored("local", SELECT_ACCOUNT_KEY, "1");
}

/** Whether the next "Continue with" should ask the provider which account to use. */
export function selectAccountDue(): boolean {
  return readStored("local", SELECT_ACCOUNT_KEY) !== null;
}

/** Leaving to link the provider from `returnTo`, where its outcome is announced. */
export function markLinkPending(returnTo: string): void {
  writeStored("session", LINK_PENDING_KEY, returnTo);
}

/**
 * Where a link this tab left for would have come back to, when it has not come
 * back yet; null otherwise. Read in render; spent by clearLinkPending.
 */
export function pendingLinkReturn(): string | null {
  return usableDestination(readStored("session", LINK_PENDING_KEY));
}

export function clearLinkPending(): void {
  removeStored("session", LINK_PENDING_KEY);
}

/** Whether the round trip landing here was a silent attempt. Read in render; spent by clearSilentAttempt. */
export function peekSilentAttempt(): boolean {
  return readStored("session", SILENT_KEY) !== null;
}

export function clearSilentAttempt(): void {
  removeStored("session", SILENT_KEY);
}

/**
 * Whether the login page should first try a sign-in with no prompt: someone
 * signed in through the provider here before, nobody is signed in now, and no
 * attempt has run in this page load, come back from one, or left this tab in
 * the last minute.
 */
export function silentSignInDue(page: { signedIn: boolean; failedReturn: boolean; silentReturn: boolean }): boolean {
  return (
    !silentTried &&
    !page.signedIn &&
    !page.failedReturn &&
    !page.silentReturn &&
    Date.now() - Number(readStored("session", SILENT_AT_KEY) ?? 0) >= SILENT_SPACING_MS &&
    hasSsoHint() &&
    providerLabel() !== null &&
    // The owner sets a node up with a password; the node refuses the provider until then.
    !nodeUnclaimed()
  );
}

/**
 * Leave for the provider. `returnTo` is where to land afterwards; `bearer`
 * links the provider to that signed-in account instead of signing in.
 * `select_account` asks the provider which account to use; `none` asks it
 * nothing, and replaces this page in the history, so Back never lands on a
 * sign-in that is half done.
 */
export async function startProviderSignIn(opts: {
  prompt?: "none" | "select_account";
  returnTo: string;
  bearer?: string;
}): Promise<void> {
  if (opts.prompt === "none") {
    // StrictMode runs the effect that calls this twice; the second finds the attempt under way.
    if (silentTried) return;
    silentTried = true;
    writeStored("session", SILENT_AT_KEY, String(Date.now()));
  }
  const body: Record<string, unknown> = { return_to: opts.returnTo };
  if (opts.prompt) body.prompt = opts.prompt;
  const res = await authRequest<{ url?: unknown }>("/auth/oidc/start", body, opts.bearer);
  if (typeof res?.url !== "string") throw new AuthError(200, "The server returned no sign-in address.");
  if (opts.prompt === "none") {
    writeStored("session", SILENT_KEY, "1");
    window.location.replace(res.url);
    return;
  }
  if (opts.prompt === "select_account") removeStored("local", SELECT_ACCOUNT_KEY);
  window.location.assign(res.url);
}

/** A value the node put in this page's fragment, which no server or log ever sees. */
export function fragmentParam(name: string): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(name);
}

/** Drop the fragment from the address bar and the history entry, so the one-time value is not left lying around. */
export function stripFragment(): void {
  if (!window.location.hash) return;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

export function resetSilentAttemptForTest(): void {
  silentTried = false;
}
