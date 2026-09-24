/** The session's token set: persisted, renewed, and ended here. */
import { readStored, removeStored, writeStored } from "../storage";
import { authRequest } from "./auth-request";
import { AuthError, StorageBlockedError } from "./errors";
import { noteSignOut } from "./provider";
import { clearMediaTicket } from "./tickets";
import { setActiveWorkspace } from "./workspace-pointer";

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

const SESSION_KEY = "stuga_session";

export function getToken(): string | null {
  return getTokenSet()?.accessToken ?? null;
}

/** False when the write did not persist. */
function storeTokens(t: TokenSet): boolean {
  return writeStored("local", SESSION_KEY, JSON.stringify(t));
}

export interface Session {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/**
 * Persist a local sign-in or sign-up. Throws when storage refuses it: the caller
 * navigates into the app next, which would find no token and loop back to /login.
 */
export function setSession(t: Session): void {
  const stored = storeTokens({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: Date.now() + t.expiresIn * 1000,
  });
  if (!stored) throw new StorageBlockedError();
}

function getTokenSet(): TokenSet | null {
  const raw = readStored("local", SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    // Unreadable: signed out, rather than a throw from every authed request.
    removeStored("local", SESSION_KEY);
    return null;
  }
}

export function clearTokens(): void {
  removeStored("local", SESSION_KEY);
  // The workspace pointer belongs to the session, not to the browser.
  setActiveWorkspace(null);
}

/**
 * The shape shared by /auth/login, /auth/register, /auth/refresh and the
 * identity provider's steps, which add where the sign-in was headed.
 */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  return_to?: string;
}

export async function authPost(path: string, body: Record<string, unknown>): Promise<TokenResponse> {
  const json = await authRequest<Partial<TokenResponse>>(path, body);
  if (!json?.access_token || typeof json.expires_in !== "number") {
    throw new AuthError(200, "The server returned an unusable session.");
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    ...(typeof json.return_to === "string" ? { return_to: json.return_to } : {}),
  };
}

/** Renew this long before expiry, so a request sent at the edge still arrives with a valid token. */
const RENEW_MARGIN_MS = 60_000;

/** A refusal ends the session; an unreachable node says nothing about it, so the session is kept. */
type RenewOutcome =
  | { kind: "renewed"; tokens: TokenResponse }
  | { kind: "refused" }
  | { kind: "unreachable" };

/** The node reports a dead grant as 400 and a rejected one as 401/403; anything else is transient. */
function refusedStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

async function refresh(refreshToken: string): Promise<RenewOutcome> {
  try {
    return { kind: "renewed", tokens: await authPost("/auth/refresh", { refresh_token: refreshToken }) };
  } catch (err) {
    if (err instanceof AuthError && refusedStatus(err.status)) return { kind: "refused" };
    return { kind: "unreachable" };
  }
}

const REFRESH_LOCK = "stuga_token_refresh";

/**
 * Hold the origin-wide lock so two tabs never present one refresh token: the node
 * reads a second presentation as a replay and signs the account out everywhere.
 * Without `navigator.locks` (plain HTTP on a LAN) it runs unlocked, and the
 * node's rotation grace window covers the race.
 */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) return fn();
  try {
    return await locks.request(REFRESH_LOCK, fn);
  } catch {
    return fn();
  }
}

/** The renewal in flight; concurrent callers share it. */
let renewal: Promise<string | null> | null = null;

/** A fresh access token, renewing first when needed; null without a session. */
export async function ensureFreshToken(): Promise<string | null> {
  const ts = getTokenSet();
  if (!ts) return null;
  if (Date.now() < ts.expiresAt - RENEW_MARGIN_MS) return ts.accessToken;
  if (!ts.refreshToken) return null;
  renewal ??= renew()
    // Never rejects: every caller is about to send a request.
    .catch(() => getToken())
    .finally(() => {
      renewal = null;
    });
  return renewal;
}

/** Re-reads the token set once the lock is held: the tab ahead may already have renewed it. */
async function renew(): Promise<string | null> {
  return withRefreshLock(async () => {
    const ts = getTokenSet();
    if (!ts) return null;
    if (Date.now() < ts.expiresAt - RENEW_MARGIN_MS) return ts.accessToken;
    if (!ts.refreshToken) return null;

    const outcome = await refresh(ts.refreshToken);
    if (outcome.kind === "refused") {
      clearTokens();
      return null;
    }
    if (outcome.kind === "unreachable") {
      // Keep the session; if the token has expired, its request's 401 ends it.
      return ts.accessToken;
    }
    const json = outcome.tokens;
    const next: TokenSet = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? ts.refreshToken,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    storeTokens(next);
    return next.accessToken;
  });
}

/**
 * Sign out: drop the session, the media cookie and the provider hint, and
 * revoke the session at the node (a keepalive request navigation does not wait
 * for). The provider's own session is left alone: it is not this node's, so
 * the next sign-in through it asks which account to use instead.
 */
export function logout(): void {
  const ts = getTokenSet();
  const token = ts?.accessToken;
  clearMediaTicket();
  clearTokens();
  noteSignOut();
  if (token) {
    void fetch("/auth/logout", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ refresh_token: ts?.refreshToken ?? null }),
    }).catch(() => {
      /* a missed revoke expires on its own */
    });
  }
  location.href = "/login";
}
