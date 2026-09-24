/**
 * Destinations stashed across a redirect: through sign-in, and through
 * workspace onboarding. Only relative same-origin paths are kept, so a stash
 * cannot become an open redirect, and never the page doing the redirecting,
 * which would loop.
 */
import { readStored, takeStored, writeStored } from "../storage";

const LOGIN_RETURN_KEY = "stuga_login_return";
const WORKSPACE_RETURN_KEY = "stuga_workspace_return";

/** The node's own cap on a destination it carries through a sign-in. */
const MAX_RETURN_CHARS = 2048;

/**
 * `refused` holds exact paths, and prefixes ending in "/" for pages whose path
 * carries a token. The same rules as the node's safeReturnTo.
 */
function usableReturn(raw: string | null, refused: readonly string[]): string | null {
  if (!raw || raw.length > MAX_RETURN_CHARS) return null;
  // A browser reads "/\host" as "//host", another origin.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // A browser drops a tab or newline from a URL, so "/\t/host" would also become "//host".
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = raw.split(/[?#]/)[0]!;
  return refused.some((r) => (r.endsWith("/") ? path.startsWith(r) : path === r)) ? null : raw;
}

/** The pages a sign-in passes through, which are never a destination; a reset link works once. */
const AUTH_PAGES = ["/login", "/auth/complete", "/auth/first-visit", "/reset/"];

/** Consume the post-login destination, or "/". */
export function takeLoginReturn(): string {
  return usableReturn(takeStored("session", LOGIN_RETURN_KEY), AUTH_PAGES) ?? "/";
}

/** The post-login destination, or "/", left in place: a sign-in through the provider spends it only once it is done. */
export function peekLoginReturn(): string {
  return usableReturn(readStored("session", LOGIN_RETURN_KEY), AUTH_PAGES) ?? "/";
}

/** A destination the node handed back, held to the same rules as a stashed one. */
export function safeReturn(path: string | undefined): string {
  return usableReturn(path ?? null, AUTH_PAGES) ?? "/";
}

/** A stashed destination held to the same rules, or null when it is not one. */
export function usableDestination(path: string | null): string | null {
  return usableReturn(path, AUTH_PAGES);
}

/** Remember where to go after signing in. An auth page is ignored, so it cannot clobber a real destination. */
export function rememberLoginReturn(path: string): void {
  if (usableReturn(path, AUTH_PAGES)) writeStored("session", LOGIN_RETURN_KEY, path);
}

/** Consume the destination that sent a member of no workspace to onboarding, or "/". */
export function takeWorkspaceReturn(): string {
  return usableReturn(takeStored("session", WORKSPACE_RETURN_KEY), ["/onboarding"]) ?? "/";
}

export function rememberWorkspaceReturn(path: string): void {
  if (usableReturn(path, ["/onboarding"])) writeStored("session", WORKSPACE_RETURN_KEY, path);
}

/**
 * Strict on purpose: tokens are a prefix plus base64url, only /join links carry
 * one (share links at /s/ are another flow), and nothing is percent-decoded, so
 * a hostile path cannot become a token this app posts to /auth/register.
 */
const JOIN_TOKEN = /^\/join\/([A-Za-z0-9_-]+)/;

/** The invite token of a /join destination, or null. */
export function inviteTokenIn(path: string | null | undefined): string | null {
  return JOIN_TOKEN.exec(usableReturn(path ?? null, AUTH_PAGES) ?? "")?.[1] ?? null;
}

/** The invite token of the /join link that sent this visitor to sign in. Read without consuming the stash. */
export function pendingInviteToken(): string | null {
  return inviteTokenIn(readStored("session", LOGIN_RETURN_KEY));
}
