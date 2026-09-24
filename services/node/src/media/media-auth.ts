/**
 * Who may read a stored image. `<img src>` cannot send an Authorization header,
 * so the browser carries a short-lived HttpOnly cookie: an HMAC over alias,
 * workspace and expiry that only the media route consults. The workspace in the
 * ticket selects the tenant's key prefix. Within one workspace a ticket unlocks
 * any hash its holder can name; there is no hash-to-document index to narrow it.
 */
import { constantTimeEqual } from "@stuga/auth";
import { b64urlDecodeText, b64urlEncodeText, signTicket } from "../auth/signed-ticket.js";
import { isKeySafeWorkspaceId } from "./media.js";

/** Cookie name for the media read ticket. */
export const MEDIA_COOKIE = "stuga_media";

/** Short, so losing access bites within a working session; the SPA re-mints well before it lapses. */
export const MEDIA_TICKET_TTL_SECONDS = 2 * 60 * 60;

/** Aliases are identity-provider subjects (a UUID); anything near this is not one. */
const MAX_ALIAS_LENGTH = 256;

/** The key-derivation label: a media ticket verifies as nothing else. Changing it invalidates every ticket. */
const MEDIA_TICKET_DOMAIN = "stuga/media-ticket/v1";

async function sign(secret: string, payload: string): Promise<string> {
  return signTicket(secret, MEDIA_TICKET_DOMAIN, payload);
}

export interface MediaTicket {
  alias: string;
  /** The tenant whose media prefix this ticket reads. */
  workspaceId: string;
  /** Epoch SECONDS at which the ticket stops verifying. */
  expiresAt: number;
}

/**
 * Mint the cookie value for `alias` acting in `workspaceId`. The caller must
 * have established membership: this signs whatever it is handed.
 */
export async function mintMediaTicket(
  secret: string,
  alias: string,
  workspaceId: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = MEDIA_TICKET_TTL_SECONDS,
): Promise<{ value: string; expiresAt: number }> {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${b64urlEncodeText(alias)}.${b64urlEncodeText(workspaceId)}.${expiresAt}`;
  return { value: `${payload}.${await sign(secret, payload)}`, expiresAt };
}

/** Verify a ticket. Returns null for anything not currently valid. */
export async function verifyMediaTicket(
  secret: string,
  value: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<MediaTicket | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [aliasPart, wsPart, expPart, signature] = parts as [string, string, string, string];
  const expiresAt = Number(expPart);
  // Before hashing, so an expired ticket is indistinguishable from a forged one.
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return null;
  const expected = await sign(secret, `${aliasPart}.${wsPart}.${expPart}`);
  if (!constantTimeEqual(expected, signature)) return null;
  const alias = b64urlDecodeText(aliasPart);
  const workspaceId = b64urlDecodeText(wsPart);
  if (!alias || alias.length > MAX_ALIAS_LENGTH) return null;
  // The workspace becomes a blob key segment.
  if (!workspaceId || !isKeySafeWorkspaceId(workspaceId)) return null;
  return { alias, workspaceId, expiresAt };
}

/** Read one cookie out of a request's Cookie header. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

export interface CookieEnv {
  /** "None" only for an app served from a different site than the node. */
  mediaCookieSameSite: "Lax" | "Strict" | "None";
}

/** `Cross-Origin-Resource-Policy` for a served image; it must permit what the cookie's SameSite permits. */
export function mediaCorp(env: CookieEnv): "same-site" | "cross-origin" {
  return env.mediaCookieSameSite === "None" ? "cross-origin" : "same-site";
}

/**
 * The Set-Cookie for a minted ticket. `Secure` is dropped on plain http, where a
 * browser would not keep it, and SameSite=None then falls back to Lax.
 */
export function mediaCookieHeader(req: Request, env: CookieEnv, value: string, maxAgeSeconds: number): string {
  const secure = new URL(req.url).protocol === "https:";
  const declared = env.mediaCookieSameSite;
  const attrs = [
    `${MEDIA_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=${secure || declared !== "None" ? declared : "Lax"}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Set-Cookie that removes the ticket (sign-out). */
export function clearMediaCookieHeader(req: Request, env: CookieEnv): string {
  return mediaCookieHeader(req, env, "", 0);
}
