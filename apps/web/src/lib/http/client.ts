/**
 * The HTTP client. Every authenticated request carries `authHeaders()` and every
 * response passes `observeResponse()`. Paths are same-origin: the node serves the
 * SPA and the API together.
 */
import type { DatabaseImportError } from "@stuga/protocol/databases/types";
import { clearTokens, ensureFreshToken, getToken } from "../session/tokens";
import { getActiveWorkspace, setActiveWorkspace } from "../session/workspace-pointer";

let cachedAlias: string | null = null;
let cachedDisplayName: string | null = null;

/** The caller's display name from x-stuga-name, else the alias. */
export function getDisplayName(): string | null {
  return cachedDisplayName ?? cachedAlias;
}

/** The caller's alias from x-stuga-user, which server payloads are keyed on. Null until an authed response lands. */
export function getAlias(): string | null {
  return cachedAlias;
}

/** Bearer and workspace headers over `init`. A token renewal could not refresh is still sent, so its 401 ends the session. */
export async function authHeaders(init?: HeadersInit): Promise<Headers> {
  const headers = new Headers(init);
  const token = (await ensureFreshToken()) ?? getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ws = getActiveWorkspace();
  if (ws) headers.set("x-stuga-workspace", ws);
  return headers;
}

/** A stalled fetch never settles by itself. Long enough for a database restart. */
const REQUEST_TIMEOUT_MS = 90_000;

/** For requests bounded by a file's size rather than by the server. */
export const UPLOAD_TIMEOUT_MS = 300_000;

interface AuthedFetchInit extends RequestInit {
  timeoutMs?: number;
}

/**
 * Applied to every authed response, whatever carried it: capture the identity
 * headers; on a 401 drop the credentials before leaving for /login (or the
 * sign-in page reads the dead token and bounces back); on the no-membership
 * marker drop the workspace pointer and go to onboarding.
 */
export function observeResponse(status: number, header: (name: string) => string | null): void {
  const user = header("x-stuga-user");
  if (user) cachedAlias = user;
  const name = header("x-stuga-name");
  if (name) {
    try {
      cachedDisplayName = decodeURIComponent(name);
    } catch {
      cachedDisplayName = name;
    }
  }
  if (status === 401) {
    clearTokens();
    if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
  }
  if (header("x-stuga-workspace-required") && !window.location.pathname.startsWith("/onboarding")) {
    setActiveWorkspace(null);
    window.location.href = "/onboarding";
  }
}

export async function authedFetch(path: string, init: AuthedFetchInit = {}): Promise<Response> {
  const headers = await authHeaders(init.headers);
  const { timeoutMs, signal: callerSignal, ...rest } = init;
  const deadline = AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers, signal });
  } catch (e) {
    // The deadline becomes an ApiError; a caller's own abort is left as a cancel.
    if (deadline.aborted && !callerSignal?.aborted) {
      const err = new Error(`The server didn’t respond in time. It may be waking up — try again.`) as ApiError;
      err.code = "timeout";
      throw err;
    }
    throw e;
  }
  observeResponse(res.status, (n) => res.headers.get(n));
  return res;
}

/** An Error with the HTTP status, so callers can tell a refusal from a transient failure. */
export interface ApiError extends Error {
  status?: number;
  /** A 422 from an import commit: the row-level report. */
  report?: {
    rows_total: number;
    rows_failed: number;
    errors: DatabaseImportError[];
    errors_truncated: boolean;
    ignored_columns?: string[];
    notes?: string[];
    guessed_date_order?: "mdy" | "dmy";
    /** A refused commit keeps its staging, so a retry needs no second upload. */
    import_id?: string;
  };
  /** The body's raw `error`: a sentence on most routes, a machine code where one status has several outcomes. */
  code?: string;
}

/** An Error's own message, else `fallback`. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Prose for a failure whose body carries no message of its own. */
function genericFailure(status: number): string {
  if (status === 503 || status === 502 || status === 504) {
    // What a node with an unreachable database returns, so it claims nothing about stored work.
    return "The server isn’t responding right now. That didn’t go through — try again in a moment.";
  }
  if (status >= 500) return "Something went wrong on the server. Try again in a moment.";
  if (status === 413) return "That’s too large to send.";
  if (status === 429) return "Too many requests just now. Wait a moment and try again.";
  if (status === 401 || status === 403) return "You don’t have access to that.";
  if (status === 404) return "That isn’t here any more.";
  return "That didn’t work. Try again, and tell your administrator if it keeps happening.";
}

type FailureBody = { error?: string; message?: string; errors?: unknown } | null;

/** The node's JSON `{ error }` (or `{ error: code, message }`) as an ApiError; anything else, such as a proxy's HTML 502, gets generic prose. */
export function failureFrom(path: string, method: string, status: number, body: FailureBody): ApiError {
  if (import.meta.env.DEV) {
    console.warn(`api ${method} ${path} → ${status}`, body ?? "(no body)");
  }
  const err = new Error(body?.message ?? body?.error ?? genericFailure(status)) as ApiError;
  err.status = status;
  if (body?.error) err.code = body.error;
  if (body?.error === "import_validation_failed" && Array.isArray(body.errors)) err.report = body as unknown as ApiError["report"];
  return err;
}

export async function apiFailure(path: string, method: string, res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as FailureBody;
  return failureFrom(path, method, res.status, body);
}

export async function api<T>(path: string, init?: AuthedFetchInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await authedFetch(path, { ...init, headers });
  if (!res.ok) throw await apiFailure(path, (init?.method ?? "GET").toUpperCase(), res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
