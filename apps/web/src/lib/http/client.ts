/**
 * The HTTP client. Every authenticated request carries `authHeaders()` and every
 * response passes `observeResponse()`. Paths are same-origin: the node serves the
 * SPA and the API together.
 */
import type { DatabaseImportError } from "@stuga/protocol/databases/types";
import { REAUTH_HEADER, confirmIdentity, reauthMethods } from "../session/reauth";
import { clearTokens, ensureFreshToken, getToken } from "../session/tokens";
import { getActiveWorkspace, setActiveWorkspace } from "../session/workspace-pointer";
import { t } from "../../i18n/i18n";
import { presentServerMessage } from "./server-messages";

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
 * sign-in page reads the dead token and bounces back), except the one that asks
 * for a confirmation, whose session is fine; on the no-membership marker drop
 * the workspace pointer and go to onboarding.
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
  if (status === 401 && !header(REAUTH_HEADER)) {
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
    // A caller's own abort is left as a cancel; the deadline and a failed connection become ApiErrors.
    if (callerSignal?.aborted) throw e;
    if (deadline.aborted) {
      const err = new Error(t("errors.client.timeout"), { cause: e }) as ApiError;
      err.code = "timeout";
      throw err;
    }
    throw networkFailure(e);
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
  /** With `reauth_required`: how this person can confirm it is them. */
  methods?: string[];
}

/** A request that never reached the node: the browser's own words ("Failed to fetch", "Load failed") stay in `cause`. */
export function networkFailure(cause?: unknown): ApiError {
  const err = new Error(t("errors.client.offline"), { cause }) as ApiError;
  err.code = "network";
  return err;
}

/** An Error's own message, else `fallback`. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Prose for a failure whose body carries no message of its own. */
function genericFailure(status: number): string {
  if (status === 503 || status === 502 || status === 504) {
    // What a node with an unreachable database returns, so it claims nothing about stored work.
    return t("errors.client.unavailable");
  }
  if (status >= 500) return t("errors.client.serverError");
  if (status === 413) return t("errors.client.tooLarge");
  if (status === 429) return t("errors.client.tooManyRequests");
  if (status === 401 || status === 403) return t("errors.client.noAccess");
  if (status === 404) return t("errors.client.gone");
  return t("errors.client.failed");
}

type FailureBody = { error?: string; message?: string; errors?: unknown; methods?: unknown } | null;

/**
 * The node's JSON `{ error }` (or `{ error: code, message }`) as an ApiError; anything else, such as a proxy's HTML 502, gets
 * generic prose. The message is in the reader's language; `code` keeps the node's raw text for code that branches on it.
 */
export function failureFrom(path: string, method: string, status: number, body: FailureBody): ApiError {
  if (import.meta.env.DEV) {
    console.warn(`api ${method} ${path} → ${status}`, body ?? "(no body)");
  }
  const sentence = body?.message ?? body?.error;
  const message =
    body?.error === "reauth_required" ? t("errors.client.reauth") : sentence ? presentServerMessage(sentence) : genericFailure(status);
  const err = new Error(message) as ApiError;
  err.status = status;
  if (body?.error) err.code = body.error;
  if (Array.isArray(body?.methods)) err.methods = body.methods.filter((m): m is string => typeof m === "string");
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
  const method = (init?.method ?? "GET").toUpperCase();
  let res = await authedFetch(path, { ...init, headers });
  // A change that takes a recent confirmation: confirm, then send it once more.
  if (res.status === 401 && res.headers.get(REAUTH_HEADER)) {
    const refused = await apiFailure(path, method, res);
    if (!(await confirmIdentity(reauthMethods(refused) ?? []))) throw refused;
    res = await authedFetch(path, { ...init, headers });
  }
  if (!res.ok) throw await apiFailure(path, method, res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
