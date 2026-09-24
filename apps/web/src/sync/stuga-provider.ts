/**
 * Binds a Y.Doc to its document actor: the epoch-gated sync handshake, live
 * updates both ways, awareness, run frames and AI co-author turns. Reconnects
 * with backoff until access is revoked or the provider is destroyed.
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type {
  AiRequest,
  AiResponseChunk,
  AiEditsPayload,
  WriteRejectedPayload,
  RunUpdatedPayload,
  RunDecidedPayload,
} from "@stuga/protocol/wire/doc-socket";
import {
  decodeFrame,
  encodeBinary,
  encodeEmpty,
  encodeJson,
  encodeAwareness,
  decodeJson,
  decodeAwareness,
  encodeEpoch,
  decodeEpoch,
} from "@stuga/protocol/wire/frame";
import { Opcode, CloseCode, Heartbeat, type PersistDegradedPayload } from "@stuga/protocol/wire/opcodes";
import { wsBase } from "./ws-base";
import { cachedSocketTicket, ensureSocketTicket } from "../lib/session/tickets";

/** Observers only: none of them changes what is sent, retried or buffered. */
interface ProviderEvents {
  onStatus?: (status: "connecting" | "open" | "reconnecting" | "revoked") => void;
  /** Once: the first handshake completed. */
  onSynced?: () => void;
  /** The handshake finished on the current socket; again after each reconnect. */
  onSyncDone?: () => void;
  onWriteRejected?: (payload: WriteRejectedPayload) => void;
  /**
   * A level, not an edge: sent on each transition and at handshake while
   * degraded. The only signal for a server that acks updates it cannot store.
   */
  onPersistDegraded?: (payload: PersistDegradedPayload) => void;
  /** A local update had no socket, or no receipt in time. It stays in the Y.Doc for the next handshake. */
  onLocalUpdateDropped?: () => void;
  /** Receipts arrived for everything outstanding. */
  onLocalUpdatesAcked?: () => void;
}

type RunEvent =
  | { type: "updated"; payload: RunUpdatedPayload }
  | { type: "decided"; payload: RunDecidedPayload };

interface AiTurnHandlers {
  onChunk: (chunk: string) => void;
  /** What the agent is doing before it streams prose. */
  onStatus?: (status: string) => void;
  onDone: (error?: string) => void;
  onEdits: (payload: AiEditsPayload) => void;
}

export class StugaProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private ws: WebSocket | null = null;
  /** Bumped by every connect and anything that invalidates one; a superseded attempt opens nothing. */
  private connectSeq = 0;
  private shouldReconnect = true;
  private backoff = 1000;
  /**
   * The pending backoff reconnect. Only `scheduleReconnect` sets it, cancelling
   * first, so at most one attempt is ever pending; calling `connect()` from
   * anywhere else can leave two live sockets.
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private synced = false;
  private aiTurn: AiTurnHandlers | null = null;
  /** A slot rather than a constructor event: the runs context mounts after the provider exists. */
  public runListener: ((evt: RunEvent) => void) | null = null;
  private awarenessKeepalive: ReturnType<typeof setInterval> | null = null;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastInbound = 0;
  // Typing moves the caret on every keystroke; awareness sends are coalesced to one per window.
  private awarenessThrottle: ReturnType<typeof setTimeout> | null = null;
  private awarenessPendingClients: Set<number> = new Set();
  private awarenessLastSent = 0;
  private static readonly AWARENESS_THROTTLE_MS = 150;
  // Well above the 25s heartbeat. Applied only while the tab is visible: hidden
  // tabs throttle timers to about once a minute, so a healthy socket looks silent.
  private static readonly LIVENESS_SILENCE_MS = 60_000;
  private visibilityBound: (() => void) | null = null;
  private pageHideBound: ((e: PageTransitionEvent) => void) | null = null;

  // Delivery receipts feed the connection indicator only. An UPDATE_ACK is the
  // one proof an edit arrived: readyState stays OPEN for a minute after the
  // network dies while send() discards the bytes.
  /** The actor acks inline, so a healthy link answers in tens of milliseconds. */
  private static readonly ACK_DEADLINE_MS = 5_000;
  /** Local updates sent with no UPDATE_ACK yet. */
  private pendingAcks = 0;
  /** Covers the oldest outstanding update. */
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /** A deadline lapsed; the transition is reported once. */
  private ackOverdue = false;

  /** Kept across reconnects: a different value on a later socket means the document was rolled back meanwhile. */
  private serverEpoch: number | null = null;
  /** Per socket. */
  private epochAccepted = false;
  /** Per socket; tells a refused epoch from a server that never sent one. */
  private epochFrameSeen = false;

  constructor(
    private readonly docId: string,
    private readonly alias: string,
    private readonly events: ProviderEvents = {},
    doc?: Y.Doc,
  ) {
    this.doc = doc ?? new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.doc.on("update", this.onLocalUpdate);
    this.awareness.on("update", this.onLocalAwareness);
    // Registered once, surviving reconnects; removed in destroy().
    if (typeof document !== "undefined") {
      this.visibilityBound = () => this.onVisibilityChange();
      document.addEventListener("visibilitychange", this.visibilityBound);
    }
    if (typeof window !== "undefined") {
      // pagehide, not beforeunload: it cannot be cancelled and it tells a bfcache freeze apart.
      this.pageHideBound = (e: PageTransitionEvent) => this.onPageHide(e);
      window.addEventListener("pagehide", this.pageHideBound);
    }
    this.connect();
  }

  private wsUrl(ticket: string): string {
    // The ticket is the whole credential, and it names the workspace it opens.
    return `${wsBase()}/ws/${this.docId}?ticket=${encodeURIComponent(ticket)}`;
  }

  /** Synchronous with a ticket in hand, so a drop reconnects with no round trip; only a due mint goes async. */
  private connect(): void {
    const seq = ++this.connectSeq;
    this.events.onStatus?.(this.synced ? "reconnecting" : "connecting");
    const ready = cachedSocketTicket(this.docId);
    if (ready !== null) {
      this.openSocket(ready);
      return;
    }
    void ensureSocketTicket(this.docId)
      .catch(() => null)
      .then((minted) => {
        if (seq !== this.connectSeq || !this.shouldReconnect) return;
        // No ticket: the upgrade is refused and the backoff path reports it.
        this.openSocket(minted ?? "");
      });
  }

  private openSocket(token: string): void {
    const ws = new WebSocket(this.wsUrl(token));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.lastInbound = Date.now();
      this.events.onStatus?.("open");
      // Updates outstanding on the dead socket are re-delivered by the handshake, not acked one by one.
      this.resetAckTracking();
      this.epochAccepted = false;
      this.epochFrameSeen = false;
      // No SYNC_STEP_1 yet: if the document was restored meanwhile, our state vector
      // would merge the rolled-back content back in. acceptEpoch() starts the handshake.
      this.sendAwareness();
      // Only with a peer present: an awareness frame wakes the actor, and a lone editor has no one to tell.
      this.awarenessKeepalive = setInterval(() => {
        if (this.awareness.getStates().size > 1) this.sendAwareness();
      }, 300_000);
      // The host answers PING without waking the actor; it keeps the socket warm and feeds the watchdog.
      this.heartbeat = setInterval(() => {
        try {
          this.ws?.send(Heartbeat.PING);
        } catch {
          /* socket gone */
        }
      }, 25_000);
      // Silence past the threshold is a half-open socket: close it and let backoff reconnect.
      this.liveness = setInterval(() => {
        const hidden = typeof document !== "undefined" && document.hidden;
        if (!hidden && Date.now() - this.lastInbound > StugaProvider.LIVENESS_SILENCE_MS) {
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
      this.onMessage(ev.data as ArrayBuffer);
    };
    ws.onclose = (ev) => this.onClose(ev.code);
    ws.onerror = () => ws.close();
  }

  /** Ack the generation and only then start the handshake, whose first frame carries our state. */
  private acceptEpoch(epoch: number): void {
    if (this.epochAccepted) return;
    this.epochAccepted = true;
    this.send(encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(epoch)));
    this.send(encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(this.doc)));
  }

  private onMessage(data: ArrayBuffer): void {
    const frame = decodeFrame(new Uint8Array(data));
    if (!frame) return;
    switch (frame.opcode) {
      case Opcode.DOCUMENT_EPOCH: {
        this.epochFrameSeen = true;
        const epoch = decodeEpoch(frame.payload);
        if (epoch === null) {
          // Neither ack nor sync: the server keeps this socket fenced.
          console.warn("[sync] ignoring a malformed document epoch");
          break;
        }
        // Restored while this tab held its own state: reload rather than send it.
        if (this.serverEpoch !== null && epoch !== this.serverEpoch) {
          this.shouldReconnect = false;
          location.reload();
          break;
        }
        this.serverEpoch = epoch;
        this.acceptEpoch(epoch);
        break;
      }
      case Opcode.SYNC_STEP_1:
        // Fails closed: our reply carries this tab's state, so it waits for an accepted epoch,
        // which the server always sends first. Unaccepted, the tab stays at "connecting".
        if (!this.epochAccepted) {
          if (!this.epochFrameSeen) {
            console.warn("[sync] refusing to sync: the server never announced a document epoch");
          }
          break;
        }
        this.send(encodeBinary(Opcode.SYNC_STEP_2, Y.encodeStateAsUpdate(this.doc, frame.payload)));
        // The actor acks SYNC_STEP_2 like an UPDATE, so arm a deadline to keep acks and sends 1:1.
        if (this.ws?.readyState === WebSocket.OPEN) this.armAckDeadline();
        break;
      case Opcode.SYNC_STEP_2:
      case Opcode.UPDATE:
        Y.applyUpdate(this.doc, frame.payload, this);
        break;
      case Opcode.AWARENESS:
        this.onRemoteAwareness(frame.payload);
        break;
      case Opcode.UPDATE_ACK:
        this.onUpdateAcked();
        break;
      case Opcode.SYNC_DONE:
        this.emitStatus(this.events.onSyncDone, "onSyncDone");
        if (!this.synced) {
          this.synced = true;
          this.events.onSynced?.();
        }
        break;
      case Opcode.AI_RESPONSE: {
        const chunk = decodeJson<AiResponseChunk>(frame.payload);
        if (chunk.chunk) this.aiTurn?.onChunk(chunk.chunk);
        if (chunk.status) this.aiTurn?.onStatus?.(chunk.status);
        if (chunk.done) {
          this.aiTurn?.onDone(chunk.error ?? undefined);
        }
        break;
      }
      case Opcode.AI_EDITS: {
        const payload = decodeJson<AiEditsPayload>(frame.payload);
        this.aiTurn?.onEdits(payload);
        this.aiTurn = null;
        break;
      }
      case Opcode.DOC_RESET: {
        // Rolled back: nothing is cached locally, so a reload re-syncs from the restored head.
        this.shouldReconnect = false;
        location.reload();
        break;
      }
      case Opcode.WRITE_REJECTED: {
        // A refused update gets no ack; without this reset the indicator would blame the network.
        this.resetAckTracking();
        this.events.onWriteRejected?.(decodeJson<WriteRejectedPayload>(frame.payload));
        break;
      }
      case Opcode.PERSIST_DEGRADED: {
        // Leaves ack bookkeeping alone: the updates were received; only storing them is in doubt.
        this.events.onPersistDegraded?.(decodeJson<PersistDegradedPayload>(frame.payload));
        break;
      }
      case Opcode.RUN_UPDATED: {
        this.emitRun({ type: "updated", payload: decodeJson<RunUpdatedPayload>(frame.payload) });
        break;
      }
      case Opcode.RUN_DECIDED: {
        this.emitRun({ type: "decided", payload: decodeJson<RunDecidedPayload>(frame.payload) });
        break;
      }
      default:
        break;
    }
  }

  /** A throwing observer is logged, never allowed to break sync. */
  private emitRun(evt: RunEvent): void {
    if (!this.runListener) return;
    try {
      this.runListener(evt);
    } catch (e) {
      console.error("[stuga-provider] runListener threw:", e);
    }
  }

  private onClose(code: number): void {
    if (this.awarenessKeepalive) {
      clearInterval(this.awarenessKeepalive);
      this.awarenessKeepalive = null;
    }
    if (this.awarenessThrottle !== null) {
      clearTimeout(this.awarenessThrottle);
      this.awarenessThrottle = null;
    }
    this.awarenessPendingClients.clear();
    if (this.liveness) {
      clearInterval(this.liveness);
      this.liveness = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // The reconnect handshake re-delivers outstanding edits; onLocalUpdate reports ones typed while down.
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    // The actor keys a co-author turn to the socket that asked, so it ends here.
    // Whatever it staged still reaches the review bar.
    if (this.aiTurn) {
      const turn = this.aiTurn;
      this.aiTurn = null;
      const message = "The connection dropped during this turn. Anything it staged will appear in the review bar.";
      turn.onDone(message);
      turn.onEdits({ staged: 0, run_id: null, cross_docs: [], error: message, notice: null });
    }
    if (code === CloseCode.ACCESS_REVOKED) {
      this.shouldReconnect = false;
      this.events.onStatus?.("revoked");
      return;
    }
    if (code === CloseCode.DOC_RESET) {
      this.shouldReconnect = false;
      location.reload();
      return;
    }
    if (!this.shouldReconnect) return;
    this.events.onStatus?.("reconnecting");
    this.scheduleReconnect(this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  /** Replaces any pending retry, so overlapping closes cannot stack up sockets. */
  private scheduleReconnect(delay: number): void {
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Also abandons an attempt still waiting on a ticket.
    this.connectSeq += 1;
  }

  /** Hidden-tab timers may have missed a dead socket: reconnect only if it is closed or silent. */
  private onVisibilityChange(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!this.shouldReconnect) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      // A closing socket's onclose schedules its own retry.
      if (ws?.readyState === WebSocket.CLOSING) return;
      // Now, replacing any queued backoff: the user is back, usually with the network.
      this.scheduleReconnect(0);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(Heartbeat.PING);
      } catch {
        /* socket gone */
      }
      if (Date.now() - this.lastInbound > StugaProvider.LIVENESS_SILENCE_MS) {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
      }
    }
  }

  /**
   * On a real unload, remove our cursor at once: effect cleanups do not run, and
   * peers would wait out y-protocols' 30s expiry. A bfcache freeze may be restored, so it is left alone.
   */
  private onPageHide(e: PageTransitionEvent): void {
    if (e.persisted) return;
    try {
      // Removing our own state flushes the goodbye through the awareness observer.
      removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    } catch {
      /* best-effort; the tab is going away regardless */
    }
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeBinary(Opcode.UPDATE, update) as Uint8Array<ArrayBuffer>);
      this.armAckDeadline();
      return;
    }
    // No socket: the update stays in the Y.Doc for the reconnect handshake.
    this.ackOverdue = true;
    this.emitStatus(this.events.onLocalUpdateDropped, "onLocalUpdateDropped");
  };

  /** One timer for all outstanding updates, not pushed out by later sends, so typing cannot hide a dead link. */
  private armAckDeadline(): void {
    this.pendingAcks++;
    if (this.ackTimer !== null) return;
    this.ackTimer = this.startAckTimer();
  }

  private startAckTimer(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.ackTimer = null;
      if (this.pendingAcks > 0 && !this.ackOverdue) {
        this.ackOverdue = true;
        this.emitStatus(this.events.onLocalUpdateDropped, "onLocalUpdateDropped");
      }
    }, StugaProvider.ACK_DEADLINE_MS);
  }

  /** Guarded: after a reset, a late ack from the previous socket can arrive with nothing outstanding. */
  private onUpdateAcked(): void {
    if (this.pendingAcks > 0) this.pendingAcks--;
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.pendingAcks > 0) {
      this.ackTimer = this.startAckTimer();
      return;
    }
    const wasOverdue = this.ackOverdue;
    this.ackOverdue = false;
    if (wasOverdue) this.emitStatus(this.events.onLocalUpdatesAcked, "onLocalUpdatesAcked");
  }

  /** For a dead socket or a refused write: those updates will never be acked one by one. */
  private resetAckTracking(): void {
    this.pendingAcks = 0;
    this.ackOverdue = false;
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  /** A throwing observer is logged, never allowed to affect editing, sync or reconnect. */
  private emitStatus(handler: (() => void) | undefined, which: string): void {
    if (!handler) return;
    try {
      handler();
    } catch (e) {
      console.error(`[stuga-provider] ${which} observer threw:`, e);
    }
  }

  /**
   * Caret moves are throttled with a leading and a trailing edge, so a single
   * move is instant and the resting position always arrives. A removal is never
   * throttled, or peers keep a ghost cursor.
   */
  private onLocalAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === "remote") return;

    if (removed.length > 0) {
      added.concat(updated).forEach((c) => this.awarenessPendingClients.add(c));
      removed.forEach((c) => this.awarenessPendingClients.add(c));
      this.flushAwareness();
      return;
    }

    for (const c of added) this.awarenessPendingClients.add(c);
    for (const c of updated) this.awarenessPendingClients.add(c);

    const sinceLast = Date.now() - this.awarenessLastSent;
    if (sinceLast >= StugaProvider.AWARENESS_THROTTLE_MS) {
      this.flushAwareness();
    } else if (this.awarenessThrottle === null) {
      this.awarenessThrottle = setTimeout(
        () => this.flushAwareness(),
        StugaProvider.AWARENESS_THROTTLE_MS - sinceLast,
      );
    }
  };

  private flushAwareness(): void {
    if (this.awarenessThrottle !== null) {
      clearTimeout(this.awarenessThrottle);
      this.awarenessThrottle = null;
    }
    if (this.awarenessPendingClients.size === 0) return;
    const changed = [...this.awarenessPendingClients];
    this.awarenessPendingClients.clear();
    this.awarenessLastSent = Date.now();
    const update = encodeAwarenessUpdate(this.awareness, changed);
    this.send(encodeAwareness({ alias: this.alias }, update));
  }

  private sendAwareness(): void {
    const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    this.send(encodeAwareness({ alias: this.alias }, update));
  }

  /** Arrivals, moves and departures alike: a departure is an update with a null state. */
  private onRemoteAwareness(payload: Uint8Array): void {
    const decoded = decodeAwareness(payload);
    if (!decoded) return;
    const knownBefore = new Set(this.awareness.getStates().keys());
    applyAwarenessUpdate(this.awareness, decoded.yjsAwareness, "remote");

    // The server replays no awareness to a late joiner, so answer a newly seen peer
    // with our state. Known ids never trigger a reply, so caret traffic cannot echo.
    for (const clientId of this.awareness.getStates().keys()) {
      if (clientId !== this.doc.clientID && !knownBefore.has(clientId)) {
        this.sendAwareness();
        return;
      }
    }
  }

  private send(frame: Uint8Array): void {
    // Protocol frames are always ArrayBuffer-backed.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame as Uint8Array<ArrayBuffer>);
  }

  sendAiRequest(req: AiRequest, handlers: AiTurnHandlers): void {
    this.aiTurn = handlers;
    this.send(encodeJson(Opcode.AI_REQUEST, req));
  }

  /** The turn still ends with `done` and AI_EDITS for what it staged, so the handlers stay armed. */
  cancelAiRequest(): void {
    if (this.aiTurn) this.send(encodeEmpty(Opcode.AI_CANCEL));
  }

  destroy(): void {
    this.shouldReconnect = false;
    this.cancelReconnect();
    this.resetAckTracking();
    if (this.visibilityBound && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityBound);
      this.visibilityBound = null;
    }
    if (this.pageHideBound && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.pageHideBound);
      this.pageHideBound = null;
    }
    if (this.awarenessKeepalive) clearInterval(this.awarenessKeepalive);
    if (this.liveness) clearInterval(this.liveness);
    if (this.heartbeat) clearInterval(this.heartbeat);
    // Before the goodbye, or a throttled caret send could land after it and resurrect the cursor.
    if (this.awarenessThrottle !== null) {
      clearTimeout(this.awarenessThrottle);
      this.awarenessThrottle = null;
    }
    this.awarenessPendingClients.clear();
    // Sent while the awareness observer is still attached.
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.doc.off("update", this.onLocalUpdate);
    this.awareness.off("update", this.onLocalAwareness);
    // Awareness holds an interval that keeps the Y.Doc alive. The Y.Doc itself belongs to whoever supplied it.
    this.awareness.destroy();
    this.ws?.close();
  }
}
