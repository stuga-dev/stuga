/**
 * Short-lived, workspace-scoped credentials for the two transports that cannot
 * send an Authorization header: `<img>` loads (an HttpOnly cookie from
 * /api/media/ticket) and WebSockets (a ticket from /api/ws/ticket, since a URL
 * is no place for the access token). A workspace switch spends a held ticket.
 */
import { authHeaders } from "../http/client";
import { getActiveWorkspace } from "./workspace-pointer";

interface HeldTicket {
  value: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The workspace the server signed it for. */
  workspaceId: string;
}

interface TicketCache {
  /** A ticket in hand, or null. Never awaits. */
  cached(key: string): string | null;
  /** A usable ticket, minted when needed; a refusal is null, never a rejection. */
  ensure(key: string): Promise<string | null>;
  forget(key: string): void;
}

function createTicketCache(opts: {
  url: (key: string) => string;
  /** A ticket this close to expiry counts as spent, so a slow mint leaves no gap. */
  renewMarginMs: number;
  /** The ticket's value in the answer; null when unusable. */
  read: (body: Record<string, unknown>) => string | null;
}): TicketCache {
  const held = new Map<string, HeldTicket>();
  const inflight = new Map<string, Promise<string | null>>();

  function usable(key: string): HeldTicket | null {
    const ticket = held.get(key);
    if (!ticket) return null;
    if (ticket.expiresAt - Date.now() <= opts.renewMarginMs) return null;
    // No active workspace yet: the server's own answer stands.
    const active = getActiveWorkspace();
    if (active && active !== ticket.workspaceId) return null;
    return ticket;
  }

  async function mint(key: string): Promise<string | null> {
    const headers = await authHeaders();
    if (!headers.has("authorization")) return null;
    const res = await fetch(opts.url(key), { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const value = opts.read(body);
    if (value === null || typeof body.expires_at !== "number" || typeof body.workspace_id !== "string") return null;
    held.set(key, { value, expiresAt: body.expires_at * 1000, workspaceId: body.workspace_id });
    return value;
  }

  return {
    cached: (key) => usable(key)?.value ?? null,
    ensure(key) {
      const ready = usable(key);
      if (ready) return Promise.resolve(ready.value);
      let pending = inflight.get(key);
      if (!pending) {
        pending = mint(key)
          .then((value) => {
            if (value === null) held.delete(key);
            return value;
          })
          .catch(() => {
            held.delete(key);
            return null;
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, pending);
      }
      return pending;
    },
    forget: (key) => void held.delete(key),
  };
}

const socketTickets = createTicketCache({
  url: (docId) => `/api/ws/ticket?doc=${encodeURIComponent(docId)}`,
  renewMarginMs: 30_000,
  read: (body) => (typeof body.ticket === "string" ? body.ticket : null),
});

/** Synchronous, for the sockets' reconnect bookkeeping. */
export function cachedSocketTicket(docId: string): string | null {
  return socketTickets.cached(docId);
}

export function ensureSocketTicket(docId: string): Promise<string | null> {
  return socketTickets.ensure(docId);
}

/** The cookie is the credential; the cache only records that one is held. */
const MEDIA_KEY = "media";

const mediaTickets = createTicketCache({
  url: () => "/api/media/ticket",
  renewMarginMs: 10 * 60 * 1000,
  read: () => "",
});

const MEDIA_RENEW_INTERVAL_MS = 30 * 60 * 1000;

let mediaSessionStarted = false;

/** Resolves once a ticket is held or minting failed; never rejects, since broken images beat a blocked view. */
export async function ensureMediaTicket(): Promise<void> {
  await mediaTickets.ensure(MEDIA_KEY);
}

/** Keep the media ticket alive for the session. Idempotent; renews on foreground, since hidden tabs throttle timers. */
export function startMediaSession(): void {
  if (mediaSessionStarted) return;
  mediaSessionStarted = true;
  void ensureMediaTicket();
  setInterval(() => {
    if (document.visibilityState === "visible") void ensureMediaTicket();
  }, MEDIA_RENEW_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ensureMediaTicket();
  });
}

/** Drop the media ticket here and at the server, best-effort, so the cookie does not outlive the session. */
export function clearMediaTicket(): void {
  mediaTickets.forget(MEDIA_KEY);
  void fetch("/api/media/ticket", { method: "DELETE" }).catch(() => {});
}
