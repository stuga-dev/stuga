/** Answers, bodies, cookies and redirects the sign-in endpoints share. */
import { constantTimeEqual, sha256Hex } from "@stuga/auth";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function fail(status: number, error: string, message?: string): Response {
  return json({ error, message: message ?? error }, status);
}

/** A 302 to a path on this node: every redirect the sign-in endpoints give is relative. */
export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } });
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

/** The pages a sign-in must never come back to: it would land where it started, or on an endpoint. */
function isSignInPath(path: string): boolean {
  const p = path.replace(/\/+$/, "") || "/";
  return p === "/login" || p === "/auth" || p.startsWith("/auth/");
}

/**
 * Where to send the browser after a sign-in: a path on this node, kept only
 * when it cannot leave it (no `//host`, no `/\host`, no control characters)
 * and is not a sign-in page. Anything else is `/`.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  const base = "http://node.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return "/";
  }
  if (url.origin !== base || isSignInPath(url.pathname)) return "/";
  return raw;
}

/** Add `param` (already encoded, `key=value`) to a path's query, ahead of any fragment. */
export function withQuery(path: string, param: string): string {
  const hash = path.indexOf("#");
  const [head, tail] = hash >= 0 ? [path.slice(0, hash), path.slice(hash)] : [path, ""];
  return `${head}${head.includes("?") ? "&" : "?"}${param}${tail}`;
}

/**
 * The cookie that ties a sign-in to the browser that started it (login CSRF,
 * RFC 6749 §10.12). On https it carries the `__Host-` prefix, which a browser
 * accepts only host-only, Secure and at Path=/, so another host under the same
 * parent domain can neither plant nor shadow it. Plain http has no such
 * guarantee, and keeps the plain name scoped to the sign-in endpoints.
 */
export function bindingCookieName(secure: boolean): string {
  return secure ? "__Host-stuga_signin" : "stuga_signin";
}

export function bindingCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [
    `${bindingCookieName(secure)}=${value}`,
    `Path=${secure ? "/" : "/auth/oidc"}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * The hash stored with a sign-in: of `name=value`, so a flow or ticket bound
 * under the `__Host-` name can never be matched by a plain cookie of the same value.
 */
export function bindingHash(value: string, secure: boolean): string {
  return sha256Hex(`${bindingCookieName(secure)}=${value}`);
}

/** Every value the request carries under `name`, in the order sent. */
function readCookies(req: Request, name: string): string[] {
  const values: string[] = [];
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/**
 * The binding value this browser presents on a sign-in of this scheme, or null
 * when it presents none, or more than one: a second cookie of that name was
 * planted by someone else, and which one is real cannot be told.
 */
export function readBinding(req: Request, secure: boolean): string | null {
  const values = readCookies(req, bindingCookieName(secure));
  return values.length === 1 && values[0] ? values[0] : null;
}

/** Whether this browser holds the cookie a stored sign-in was bound to. A missing cookie never matches. */
export function boundToBrowser(req: Request, stored: string, secure: boolean): boolean {
  const value = readBinding(req, secure);
  return value !== null && constantTimeEqual(bindingHash(value, secure), stored);
}
