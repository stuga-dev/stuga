/**
 * The sync sockets each person's sign-in has open, so that ending a sign-in closes them. Every
 * upgrade looks its session up (./context.ts), so a closed socket cannot open again on the ticket
 * in hand; this closes the ones already open, with SESSION_ENDED_CLOSE_CODE: at once when a route
 * ends the sign-in, and on `sweep` for one that ended otherwise (its fixed end, its idle expiry, or
 * a revocation that landed while the socket was opening). In memory: a restart drops every socket
 * anyway.
 *
 * Every message a socket sends is checked against its sign-in first (its gate): against when the
 * sign-in was last read to end, and, once that read is RECHECK_MS old, against the database again,
 * before the message goes on. A new sign-in's first message reads it, so no message is taken past a
 * sign-in's end, and one that ended any other way is caught within RECHECK_MS of its next message;
 * the messages behind a check wait, in order. One read serves every socket of the sign-in. A read
 * that fails closes the sockets with TRY_AGAIN_CLOSE_CODE, and the browser opens them again through
 * the upgrade's own check.
 */
import type { CredentialArrival, PresentedSession } from "@stuga/db";
import { serverSocketOf, type InboundGate } from "@stuga/runtime";

/** What a socket closed this way reports to the browser: sign in again. */
export const SESSION_ENDED_CLOSE_CODE = 4401;

/** What a socket closed because its sign-in could not be read reports: open it again later. */
export const TRY_AGAIN_CLOSE_CODE = 1013;

/** How long a read of a sign-in vouches for the messages that follow it. */
export const RECHECK_MS = 5_000;

/** The part of a server socket this needs. */
interface Closable {
  closed: unknown;
  close(code?: number, reason?: string): void;
  /** Set here when the sign-in's end can be read. */
  gate?: InboundGate | null;
}

export interface SessionSockets {
  /** Note the socket an upgrade response for a person's session `sid` of `alias`, signed in at `arrival`, carries. */
  track(sid: string, alias: string, upgrade: Response, arrival: CredentialArrival): void;
  /** Close every socket the sessions opened; how many were open. */
  closeSessions(sids: Iterable<string>): number;
  /** Close every socket any of the account's sessions opened; how many were open. */
  closeAccount(alias: string): number;
  /** Close the sockets of every tracked sign-in `isLive` says has ended; how many were open. */
  sweep(isLive: (session: PresentedSession) => Promise<boolean>): Promise<number>;
}

export interface SessionSocketsOptions {
  socketOf?: (upgrade: Response) => Closable;
  /**
   * Until when a sign-in is on unless something ends it sooner, read from the database; null once it
   * has ended. Without it, sockets are closed by routes and the sweep only.
   */
  liveUntil?: (session: PresentedSession) => Promise<Date | null>;
  now?: () => number;
  recheckMs?: number;
}

interface Entry {
  alias: string;
  arrival: CredentialArrival;
  sockets: Set<Closable>;
  /** Messages are let through without a read until then: the last read's time plus RECHECK_MS, or the sign-in's end; 0 before the first read. */
  knownUntil: number;
  /** The read in flight, which every socket of the sign-in waits on. */
  reading: Promise<boolean> | null;
}

export function createSessionSockets(options: SessionSocketsOptions | ((upgrade: Response) => Closable) = {}): SessionSockets {
  const opts: SessionSocketsOptions = typeof options === "function" ? { socketOf: options } : options;
  const socketOf = opts.socketOf ?? serverSocketOf;
  const now = opts.now ?? Date.now;
  const recheckMs = opts.recheckMs ?? RECHECK_MS;
  const bySession = new Map<string, Entry>();

  /** Drop the sockets that have closed on their own since; a session left with none goes too. */
  function prune(sid: string): void {
    const entry = bySession.get(sid);
    if (!entry) return;
    for (const socket of entry.sockets) if (socket.closed) entry.sockets.delete(socket);
    if (entry.sockets.size === 0) bySession.delete(sid);
  }

  function close(sid: string, code = SESSION_ENDED_CLOSE_CODE, reason = "signed out"): number {
    const entry = bySession.get(sid);
    bySession.delete(sid);
    let n = 0;
    for (const socket of entry?.sockets ?? []) {
      if (socket.closed) continue;
      socket.close(code, reason);
      n++;
    }
    return n;
  }

  /**
   * Read the sign-in again, once for all its sockets: false, with its sockets closed, when it has
   * ended or cannot be read.
   */
  function reread(sid: string, entry: Entry, liveUntil: NonNullable<SessionSocketsOptions["liveUntil"]>): Promise<boolean> {
    entry.reading ??= liveUntil({ sessionId: sid, alias: entry.alias, arrival: entry.arrival })
      .then((until): "live" | "ended" => {
        if (until === null || until.getTime() <= now()) return "ended";
        entry.knownUntil = Math.min(now() + recheckMs, until.getTime());
        return "live";
      })
      // A read that fails vouches for nothing: the sockets close, and open again through the upgrade's check.
      .catch((): "unread" => "unread")
      .then((read) => {
        entry.reading = null;
        if (read === "ended") close(sid);
        else if (read === "unread") close(sid, TRY_AGAIN_CLOSE_CODE, "try again");
        return read === "live";
      });
    return entry.reading;
  }

  /** The gate of one socket of `sid`: messages in order, each once the sign-in is known to be on. */
  function gateFor(sid: string, entry: Entry, socket: Closable, liveUntil: NonNullable<SessionSocketsOptions["liveUntil"]>): InboundGate {
    const waiting: Array<() => void> = [];
    let draining = false;
    async function drain(): Promise<void> {
      draining = true;
      try {
        while (waiting.length > 0) {
          if (socket.closed || bySession.get(sid) !== entry) {
            waiting.length = 0;
            return;
          }
          if (now() >= entry.knownUntil && !(await reread(sid, entry, liveUntil))) {
            waiting.length = 0;
            return;
          }
          // A route may have ended the sign-in while the read was out, with the read already past it.
          if (socket.closed || bySession.get(sid) !== entry) {
            waiting.length = 0;
            return;
          }
          waiting.shift()!();
        }
      } finally {
        draining = false;
      }
    }
    return {
      admit(deliver) {
        if (socket.closed) return;
        if (!draining && waiting.length === 0 && now() < entry.knownUntil) {
          deliver();
          return;
        }
        waiting.push(deliver);
        if (!draining) void drain();
      },
    };
  }

  return {
    track(sid, alias, upgrade, arrival) {
      prune(sid);
      // A sign-in new here vouches for nothing yet: the upgrade's check knows it is on, not until when.
      const entry = bySession.get(sid) ?? { alias, arrival, sockets: new Set<Closable>(), knownUntil: 0, reading: null };
      const socket = socketOf(upgrade);
      if (opts.liveUntil) socket.gate = gateFor(sid, entry, socket, opts.liveUntil);
      entry.sockets.add(socket);
      bySession.set(sid, entry);
    },
    closeSessions(sids) {
      let n = 0;
      for (const sid of sids) n += close(sid);
      return n;
    },
    closeAccount(alias) {
      let n = 0;
      for (const [sid, entry] of bySession) if (entry.alias === alias) n += close(sid);
      return n;
    },
    async sweep(isLive) {
      let n = 0;
      for (const sid of bySession.keys()) {
        prune(sid);
        const entry = bySession.get(sid);
        if (!entry) continue;
        if (!(await isLive({ sessionId: sid, alias: entry.alias, arrival: entry.arrival }))) n += close(sid);
      }
      return n;
    },
  };
}
