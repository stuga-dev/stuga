/**
 * Who may read a stored image. `<img src>` cannot send an Authorization header,
 * so the browser carries a short-lived HttpOnly cookie: an HMAC over alias,
 * workspace, the sign-in it was minted for and expiry that only the media route
 * consults, signed for the listener that minted it. The workspace in the
 * ticket selects the tenant's key prefix. Within one workspace a ticket unlocks
 * any hash its holder can name; there is no hash-to-document index to narrow it.
 */
import { constantTimeEqual } from "@stuga/auth";
import type { CredentialArrival } from "@stuga/db";
import { b64urlDecodeText, b64urlEncodeText, signTicket } from "../auth/signed-ticket.js";
import { isKeySafeWorkspaceId } from "./media.js";

/**
 * Cookie name for the media read ticket: `__Host-` on https, so the browser holds it to this very
 * origin (Secure, Path=/, no Domain), which no other name on the same site can set or read. Plain
 * http cannot carry the prefix.
 */
export function mediaCookieName(req: Request): string {
  return new URL(req.url).protocol === "https:" ? "__Host-stuga_media" : "stuga_media";
}

/** Short, so losing access bites within a working session; the SPA re-mints well before it lapses. */
export const MEDIA_TICKET_TTL_SECONDS = 2 * 60 * 60;

/** Aliases are identity-provider subjects (a UUID); anything near this is not one. */
const MAX_ALIAS_LENGTH = 256;

/**
 * The key-derivation label, per listener: a media ticket verifies as nothing else, and only where it was
 * minted. Changing it invalidates every ticket.
 */
const mediaTicketDomain = (arrival: CredentialArrival): string => `stuga/media-ticket/v2/${arrival}`;

async function sign(secret: string, arrival: CredentialArrival, payload: string): Promise<string> {
  return signTicket(secret, mediaTicketDomain(arrival), payload);
}

export interface MediaTicket {
  alias: string;
  /** The tenant whose media prefix this ticket reads. */
  workspaceId: string;
  /** The person's sign-in it was minted for; null for an agent's key, which is good at either address. */
  sid: string | null;
  /** Epoch SECONDS at which the ticket stops verifying. */
  expiresAt: number;
}

/**
 * Mint the cookie value for `alias` acting in `workspaceId`. The caller must
 * have established membership: this signs whatever it is handed.
 */
export async function mintMediaTicket(
  secret: string,
  ticket: { alias: string; workspaceId: string; sid: string | null; arrival: CredentialArrival },
  nowMs: number = Date.now(),
  ttlSeconds: number = MEDIA_TICKET_TTL_SECONDS,
): Promise<{ value: string; expiresAt: number }> {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${b64urlEncodeText(ticket.alias)}.${b64urlEncodeText(ticket.workspaceId)}.${b64urlEncodeText(ticket.sid ?? "")}.${expiresAt}`;
  return { value: `${payload}.${await sign(secret, ticket.arrival, payload)}`, expiresAt };
}

/** Verify a ticket presented at `arrival`. Returns null for anything not currently valid there. */
export async function verifyMediaTicket(
  secret: string,
  value: string | null | undefined,
  arrival: CredentialArrival,
  nowMs: number = Date.now(),
): Promise<MediaTicket | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const [aliasPart, wsPart, sidPart, expPart, signature] = parts as [string, string, string, string, string];
  const expiresAt = Number(expPart);
  // Before hashing, so an expired ticket is indistinguishable from a forged one.
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return null;
  const expected = await sign(secret, arrival, `${aliasPart}.${wsPart}.${sidPart}.${expPart}`);
  if (!constantTimeEqual(expected, signature)) return null;
  const alias = b64urlDecodeText(aliasPart);
  const workspaceId = b64urlDecodeText(wsPart);
  const sid = b64urlDecodeText(sidPart);
  if (!alias || alias.length > MAX_ALIAS_LENGTH) return null;
  // The workspace becomes a blob key segment.
  if (!workspaceId || !isKeySafeWorkspaceId(workspaceId)) return null;
  if (sid === null || sid.length > MAX_ALIAS_LENGTH) return null;
  return { alias, workspaceId, sid: sid || null, expiresAt };
}

/** The media ticket the request carries, under the name its scheme gives it. */
export function readMediaCookie(req: Request): string | null {
  return readCookie(req, mediaCookieName(req));
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

/**
 * `Cross-Origin-Resource-Policy` for a served image: this origin only, since each of the node's
 * addresses holds its own cookie. It must permit what the cookie's SameSite permits.
 */
export function mediaCorp(env: CookieEnv): "same-origin" | "cross-origin" {
  return env.mediaCookieSameSite === "None" ? "cross-origin" : "same-origin";
}

/**
 * The Set-Cookie for a minted ticket. `Secure` is dropped on plain http, where a
 * browser would not keep it, and SameSite=None then falls back to Lax.
 */
export function mediaCookieHeader(req: Request, env: CookieEnv, value: string, maxAgeSeconds: number): string {
  const secure = new URL(req.url).protocol === "https:";
  const declared = env.mediaCookieSameSite;
  const attrs = [
    `${mediaCookieName(req)}=${value}`,
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
