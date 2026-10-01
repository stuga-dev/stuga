/**
 * The sync sockets each person's sign-in has open, so that ending a sign-in closes them. Every
 * upgrade looks its session up (./context.ts), so a closed socket cannot open again on the ticket
 * in hand; this closes the ones already open, with SESSION_ENDED_CLOSE_CODE: at once when a route
 * ends the sign-in, and on `sweep` for one that ended otherwise (its fixed end, its idle expiry, or
 * a revocation that landed while the socket was opening). In memory: a restart drops every socket
 * anyway.
 */
import type { CredentialArrival, PresentedSession } from "@stuga/db";
import { serverSocketOf } from "@stuga/runtime";

/** What a socket closed this way reports to the browser: sign in again. */
export const SESSION_ENDED_CLOSE_CODE = 4401;

/** The part of a server socket this needs. */
interface Closable {
  closed: unknown;
  close(code?: number, reason?: string): void;
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

export function createSessionSockets(socketOf: (upgrade: Response) => Closable = serverSocketOf): SessionSockets {
  const bySession = new Map<string, { alias: string; arrival: CredentialArrival; sockets: Set<Closable> }>();

  /** Drop the sockets that have closed on their own since; a session left with none goes too. */
  function prune(sid: string): void {
    const entry = bySession.get(sid);
    if (!entry) return;
    for (const socket of entry.sockets) if (socket.closed) entry.sockets.delete(socket);
    if (entry.sockets.size === 0) bySession.delete(sid);
  }

  function close(sid: string): number {
    const entry = bySession.get(sid);
    bySession.delete(sid);
    let n = 0;
    for (const socket of entry?.sockets ?? []) {
      if (socket.closed) continue;
      socket.close(SESSION_ENDED_CLOSE_CODE, "signed out");
      n++;
    }
    return n;
  }

  return {
    track(sid, alias, upgrade, arrival) {
      prune(sid);
      const entry = bySession.get(sid) ?? { alias, arrival, sockets: new Set<Closable>() };
      entry.sockets.add(socketOf(upgrade));
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
