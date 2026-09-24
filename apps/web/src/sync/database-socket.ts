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
import { Heartbeat, Opcode } from "@stuga/protocol/wire/opcodes";
import { wsBase } from "./ws-base";
import { cachedSocketTicket, ensureSocketTicket } from "../lib/session/tickets";

type DatabaseSocketEvent =
  | { type: "run_updated"; payload: DatabaseRunUpdatedPayload }
  | { type: "run_decided"; payload: DatabaseRunDecidedPayload }
  | { type: "changed"; payload: DatabaseChangedPayload };

type DatabaseSocketListener = (evt: DatabaseSocketEvent) => void;

/** "gave_up" is terminal: only a reload reconnects. */
type DatabaseSocketStatus = "open" | "down" | "gave_up";

const LIVENESS_SILENCE_MS = 60_000;
/** Consecutive failed connects before giving up, so a revoked reader or a trashed database is not polled forever. */
const MAX_CONSECUTIVE_FAILURES = 20;

export class DatabaseSocket {
  /** Slots rather than constructor events: the runs context and the page mount after the socket exists. */
  runListener: DatabaseSocketListener | null = null;
  changedListener: ((payload: DatabaseChangedPayload) => void) | null = null;
  onStatus: ((status: DatabaseSocketStatus) => void) | null = null;

  private ws: WebSocket | null = null;
  private backoff = 1000;
  private lastInbound = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private failures = 0;
  /** Bumped by every connect and by destroy(); an attempt that finishes its ticket wait superseded opens nothing. */
  private connectSeq = 0;

  constructor(private readonly docId: string) {
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
      this.lastInbound = Date.now();
      this.onStatus?.("open");
      // The host answers PING itself, keeping the socket and presence alive without waking the actor.
      this.heartbeat = setInterval(() => {
        try {
          this.ws?.send(Heartbeat.PING);
        } catch {
          /* socket gone */
        }
      }, 25_000);
      // Reap a half-open socket only while visible: hidden tabs throttle timers, so a healthy socket looks silent.
      this.liveness = setInterval(() => {
        const hidden = typeof document !== "undefined" && document.hidden;
        if (!hidden && Date.now() - this.lastInbound > LIVENESS_SILENCE_MS) {
          try {
            this.ws?.close();
          } catch {
            /* already gone */
          }
        }
      }, 15_000);
    };
    ws.onmessage = (ev) => {
      this.lastInbound = Date.now();
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
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.destroyed) return;
    if (++this.failures > MAX_CONSECUTIVE_FAILURES) {
      this.onStatus?.("gave_up");
      return;
    }
    this.onStatus?.("down");
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.liveness) clearInterval(this.liveness);
    this.heartbeat = null;
    this.liveness = null;
  }

  destroy(): void {
    this.destroyed = true;
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
