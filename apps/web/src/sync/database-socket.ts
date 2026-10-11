/**
 * The live channel for a database: presence, run frames for the review banner
 * and the grid's ghost overlay, and DB_CHANGED nudges to refetch. It carries no
 * CRDT, so an open socket is the working state. Every transition, including
 * giving up, reaches `onStatus`, because with the channel down the grid serves
 * stale rows and proposals never paint.
 */
import type {
  DatabaseChangedPayload,
  DatabaseRunDecidedPayload,
  DatabaseRunUpdatedPayload,
} from "@stuga/protocol/wire/db-socket";
import { decodeFrame, decodeJson } from "@stuga/protocol/wire/frame";
import { CloseCode, Opcode } from "@stuga/protocol/wire/opcodes";
import { wsBase } from "./ws-base";
import { SocketLiveness } from "./socket-liveness";
import { cachedSocketTicket, ensureSocketTicket, forgetSocketTicket } from "../lib/session/tickets";

type DatabaseSocketEvent =
  | { type: "run_updated"; payload: DatabaseRunUpdatedPayload }
  | { type: "run_decided"; payload: DatabaseRunDecidedPayload }
  | { type: "changed"; payload: DatabaseChangedPayload };

type DatabaseSocketListener = (evt: DatabaseSocketEvent) => void;

/** "gave_up", "deleted" and "removed" are terminal: only a reload reconnects. */
type DatabaseSocketStatus = "open" | "down" | "gave_up" | "deleted" | "removed";

/** The close codes that end the channel for good, and what each means to the page. */
const ENDINGS: ReadonlyMap<number, "deleted" | "removed"> = new Map([
  [CloseCode.DOC_DELETED, "deleted"],
  [CloseCode.MEMBERSHIP_ENDED, "removed"],
]);

/** The code a socket the page gave up on is closed with, as a dropped connection would be. */
const ABNORMAL_CLOSURE = 1006;
/** Consecutive failed connects before giving up, so a revoked reader or a trashed database is not polled forever. */
const MAX_CONSECUTIVE_FAILURES = 20;

export class DatabaseSocket {
  /** Slots rather than constructor events: the runs context and the page mount after the socket exists. */
  runListener: DatabaseSocketListener | null = null;
  changedListener: ((payload: DatabaseChangedPayload) => void) | null = null;
  onStatus: ((status: DatabaseSocketStatus) => void) | null = null;

  private ws: WebSocket | null = null;
  private backoff = 1000;
  private liveness: SocketLiveness | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private failures = 0;
  /** Bumped by every connect and by destroy(); an attempt that finishes its ticket wait superseded opens nothing. */
  private connectSeq = 0;

  constructor(private readonly docId: string) {
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onNetworkChange);
      window.addEventListener("offline", this.onNetworkChange);
    }
    this.connect();
  }

  private wsUrl(ticket: string): string {
    // The ticket is the whole credential, and it names the workspace it opens.
    return `${wsBase()}/ws/${this.docId}?ticket=${encodeURIComponent(ticket)}`;
  }

  /** Synchronous with a ticket in hand, so a drop reconnects with no round trip; only a due mint goes async. */
  private connect(): void {
    if (this.destroyed) return;
    const seq = ++this.connectSeq;
    const ready = cachedSocketTicket(this.docId);
    if (ready !== null) {
      this.openSocket(ready);
      return;
    }
    void ensureSocketTicket(this.docId)
      .catch(() => null)
      .then((minted) => {
        if (this.destroyed || seq !== this.connectSeq) return;
        // No ticket: the upgrade is refused and the status path reports it.
        this.openSocket(minted ?? "");
      });
  }

  private openSocket(token: string): void {
    const ws = new WebSocket(this.wsUrl(token));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.failures = 0;
      this.onStatus?.("open");
      // Its frames are all small, so probes count from the start.
      this.liveness = new SocketLiveness(ws, () => this.abandonSocket(ws));
    };
    ws.onmessage = (ev) => {
      this.liveness?.heard();
      if (typeof ev.data === "string") return; // heartbeat PONG
      const frame = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
      if (!frame) return;
      switch (frame.opcode) {
        case Opcode.DB_RUN_UPDATED:
          this.runListener?.({ type: "run_updated", payload: decodeJson<DatabaseRunUpdatedPayload>(frame.payload) });
          break;
        case Opcode.DB_RUN_DECIDED:
          this.runListener?.({ type: "run_decided", payload: decodeJson<DatabaseRunDecidedPayload>(frame.payload) });
          break;
        case Opcode.DB_CHANGED:
          this.changedListener?.(decodeJson<DatabaseChangedPayload>(frame.payload));
          break;
        default:
          break;
      }
    };
    ws.onclose = (ev) => this.onClose(ev.code);
    ws.onerror = () => ws.close();
  }

  private onClose(code: number): void {
    const ending = ENDINGS.get(code);
    if (ending) {
      this.clearTimers();
      if (!this.destroyed) this.onStatus?.(ending);
      // Inert from here, as after destroy(): nothing is left to reconnect to.
      this.destroyed = true;
      return;
    }
    // A new role: a fresh ticket, at once, so the reach it brings applies now.
    if (code === CloseCode.ROLE_CHANGED) {
      forgetSocketTicket(this.docId);
      this.backoff = 0;
    }
    this.scheduleReconnect();
  }

  /** Stopped answering: closed as far as the page is concerned, without waiting for a dead link to say so. */
  private abandonSocket(ws: WebSocket): void {
    if (ws !== this.ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.onClose(ABNORMAL_CLOSURE);
  }

  /** The browser says the network went or came back: ask the open socket, or retry now. */
  private onNetworkChange = (): void => {
    if (this.destroyed) return;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      this.liveness?.probe();
      return;
    }
    if (navigator.onLine && this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.backoff = 1000;
      this.connect();
    }
  };

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.destroyed) return;
    if (++this.failures > MAX_CONSECUTIVE_FAILURES) {
      this.onStatus?.("gave_up");
      return;
    }
    this.onStatus?.("down");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(Math.max(this.backoff * 2, 1000), 30_000);
  }

  private clearTimers(): void {
    this.liveness?.stop();
    this.liveness = null;
  }

  destroy(): void {
    this.destroyed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onNetworkChange);
      window.removeEventListener("offline", this.onNetworkChange);
    }
    // Opening the database again asks for a ticket again.
    forgetSocketTicket(this.docId);
    // Also abandons an attempt still waiting on a ticket.
    this.connectSeq += 1;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.runListener = null;
    this.changedListener = null;
    this.onStatus = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
