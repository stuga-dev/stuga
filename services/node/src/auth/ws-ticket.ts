/**
 * The credential a browser opens one sync socket with. `new WebSocket()` sets no
 * headers, so it travels in the URL, which reaches logs and history; a ticket is
 * therefore bound to one document, one principal in one workspace, one write
 * tier, the sign-in and the listener it was minted at, and minutes.
 *
 * A ticket is not an authorization: every upgrade re-evaluates the ACL against
 * principals resolved live, and `canWrite` is a ceiling on that answer, never a
 * grant. A promotion to writer reaches an open tab at its next mint.
 */
import { constantTimeEqual } from "@stuga/auth";
import type { CredentialArrival } from "@stuga/db";
import { b64urlDecodeText, b64urlEncodeText, signTicket } from "./signed-ticket.js";

/** Covers a dropped socket's whole reconnect backoff (capped at 30 s) on the ticket in hand. */
const WS_TICKET_TTL_SECONDS = 5 * 60;

/** Per listener: a ticket minted at one never opens a socket at the other. */
const wsTicketDomain = (arrival: CredentialArrival): string => `stuga/ws-ticket/v2/${arrival}`;

const MAX_ALIAS_LENGTH = 256;
const MAX_ID_LENGTH = 256;

export interface WsTicket {
  alias: string;
  /** The tenant this socket opens in. */
  workspaceId: string;
  /** The one document this ticket opens a socket on. */
  docId: string;
  /** The write tier the ACL granted at mint time: a ceiling at connect, never a grant. */
  canWrite: boolean;
  /** The sign-in the ticket was minted for: every upgrade finds it still on. */
  sid: string;
  /** The listener it was minted at, the only one it opens a socket at. */
  arrival: CredentialArrival;
  /** Epoch seconds at which the ticket stops verifying. */
  expiresAt: number;
}

/**
 * Mint a ticket. The caller must already have established that `alias` may read
 * `docId` in `workspaceId` and that `canWrite` is what the ACL says: this signs
 * whatever it is handed.
 */
export function mintWsTicket(
  secret: string,
  ticket: Omit<WsTicket, "expiresAt">,
  nowMs: number = Date.now(),
  ttlSeconds: number = WS_TICKET_TTL_SECONDS,
): { value: string; expiresAt: number } {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = [
    "ws2",
    b64urlEncodeText(ticket.alias),
    b64urlEncodeText(ticket.workspaceId),
    b64urlEncodeText(ticket.docId),
    ticket.canWrite ? "w" : "r",
    b64urlEncodeText(ticket.sid),
    expiresAt,
  ].join(".");
  return { value: `${payload}.${signTicket(secret, wsTicketDomain(ticket.arrival), payload)}`, expiresAt };
}

/** The ticket, or null for anything not currently valid at `arrival`; every refusal looks the same. */
export function verifyWsTicket(
  secret: string,
  value: string | null | undefined,
  arrival: CredentialArrival,
  nowMs: number = Date.now(),
): WsTicket | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 8 || parts[0] !== "ws2") return null;
  const [, aliasPart, wsPart, docPart, writePart, sidPart, expPart, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (writePart !== "w" && writePart !== "r") return null;
  const expiresAt = Number(expPart);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return null;
  const expected = signTicket(secret, wsTicketDomain(arrival), parts.slice(0, 7).join("."));
  if (!constantTimeEqual(expected, signature)) return null;
  const alias = b64urlDecodeText(aliasPart);
  const workspaceId = b64urlDecodeText(wsPart);
  const docId = b64urlDecodeText(docPart);
  const sid = b64urlDecodeText(sidPart);
  if (!alias || alias.length > MAX_ALIAS_LENGTH) return null;
  if (!workspaceId || workspaceId.length > MAX_ID_LENGTH) return null;
  if (!docId || docId.length > MAX_ID_LENGTH) return null;
  if (!sid || sid.length > MAX_ID_LENGTH) return null;
  return { alias, workspaceId, docId, canWrite: writePart === "w", sid, arrival, expiresAt };
}
