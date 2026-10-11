/**
 * Binds a Y.Doc to its document actor: the epoch-gated sync handshake, live
 * updates both ways, awareness, run frames and AI co-author turns. Reconnects
 * with backoff until access is revoked, the document or the membership ends,
 * or the provider is destroyed.
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { CoauthorActivity, CoauthorError } from "@stuga/protocol/api/ai-turn";
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
import {
  Opcode,
  CloseCode,
  TEXT_SCHEMA_VERSION,
  type DocResetPayload,
  type DocStatePayload,
  type PersistDegradedPayload,
  type TitleChangedPayload,
} from "@stuga/protocol/wire/opcodes";
import { forceReload } from "./forced-reload";
import { wsBase } from "./ws-base";
import { SocketLiveness } from "./socket-liveness";
import { cachedSocketTicket, ensureSocketTicket, forgetSocketTicket, socketTicketRefused } from "../lib/session/tickets";
import { rememberRestore } from "../document/restore-notice";

/** Why a socket closed for good: access withdrawn, the document deleted, or the person's membership of its workspace over. */
export type SyncEnding = "revoked" | "deleted" | "removed";

/** The close codes that end syncing, and what each means to the page. */
const ENDINGS: ReadonlyMap<number, SyncEnding> = new Map([
  [CloseCode.ACCESS_REVOKED, "revoked"],
  [CloseCode.DOC_DELETED, "deleted"],
  [CloseCode.MEMBERSHIP_ENDED, "removed"],
]);

/** The code a socket the page gave up on is closed with, as a dropped connection would be. */
const ABNORMAL_CLOSURE = 1006;

/** Observers only: none of them changes what is sent, retried or buffered. */
interface ProviderEvents {
  onStatus?: (status: "connecting" | "open" | "reconnecting" | SyncEnding) => void;
  /** Once: the first handshake completed. */
  onSynced?: () => void;
  /** The handshake finished on the current socket; again after each reconnect. */
  onSyncDone?: () => void;
  onWriteRejected?: (payload: WriteRejectedPayload) => void;
  /** What this page may do now: after each handshake, and whenever the lock, the trash or the write tier moves. */
  onDocState?: (state: DocStatePayload) => void;
  /** Someone renamed the document. */
  onTitleChanged?: (payload: TitleChangedPayload) => void;
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
  onStatus?: (status: CoauthorActivity) => void;
  onDone: (error?: CoauthorError) => void;
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
  /**
   * The comments may have changed: someone changed them, or this tab was away
   * and may have missed it. A slot for the same reason as `runListener`.
   */
  public commentsListener: (() => void) | null = null;
  private awarenessKeepalive: ReturnType<typeof setInterval> | null = null;
  /** The current socket's heartbeat, which notices a dead link while nothing is typed. */
  private liveness: SocketLiveness | null = null;
  // Typing moves the caret on every keystroke; awareness sends are coalesced to one per window.
  private awarenessThrottle: ReturnType<typeof setTimeout> | null = null;
  private awarenessPendingClients: Set<number> = new Set();
  private awarenessLastSent = 0;
  private static readonly AWARENESS_THROTTLE_MS = 150;
  private visibilityBound: (() => void) | null = null;
  private networkBound: (() => void) | null = null;
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

  /** The write tier the last DOC_STATE named; a change means the held ticket names an old one. */
  private canWrite: boolean | null = null;

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
      // The browser's word on the network is a hint, never a verdict: a node on this computer works offline.
      this.networkBound = () => this.onNetworkChange();
      window.addEventListener("online", this.networkBound);
      window.addEventListener("offline", this.networkBound);
    }
    this.connect();
  }

  private wsUrl(ticket: string): string {
    // The ticket is the whole credential, and it names the workspace it opens. `schema`: the node types
    // this build's editor can read; a page older than the node's text is told to reload.
    return `${wsBase()}/ws/${this.docId}?ticket=${encodeURIComponent(ticket)}&schema=${TEXT_SCHEMA_VERSION}`;
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
        // Refused outright, as after a new role took the document away: as final as a revoked socket.
        if (minted === null && socketTicketRefused(this.docId)) {
          this.shouldReconnect = false;
          this.events.onStatus?.("revoked");
          return;
        }
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
      // Probes go unanswered behind a large first sync, so they count only once it is done.
      this.liveness = new SocketLiveness(ws, () => this.abandonSocket(ws), { answerable: false });
    };
    ws.onmessage = (ev) => {
      this.liveness?.heard();
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
          forceReload();
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
        this.liveness?.expectAnswers();
        this.emitStatus(this.events.onSyncDone, "onSyncDone");
        if (!this.synced) {
          this.synced = true;
          this.events.onSynced?.();
        } else {
          // Back after a drop: a comment made meanwhile sent its word to no one here.
          this.emitStatus(this.commentsListener ?? undefined, "commentsListener");
        }
        break;
      case Opcode.COMMENTS_CHANGED:
        this.emitStatus(this.commentsListener ?? undefined, "commentsListener");
        break;
      case Opcode.TITLE_CHANGED:
        this.events.onTitleChanged?.(decodeJson<TitleChangedPayload>(frame.payload));
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
        // A restore says who did it, for the reloaded page to tell.
        if (frame.payload.byteLength > 0) {
          try {
            const notice = decodeJson<Partial<DocResetPayload>>(frame.payload);
            if (notice.restored) rememberRestore(this.docId, notice.restored);
          } catch {
            /* the reload matters, the notice does not */
          }
        }
        this.shouldReconnect = false;
        forceReload();
        break;
      }
      case Opcode.WRITE_REJECTED: {
        // A refused update gets no ack; without this reset the indicator would blame the network.
        this.resetAckTracking();
        this.events.onWriteRejected?.(decodeJson<WriteRejectedPayload>(frame.payload));
        break;
      }
      case Opcode.DOC_STATE: {
        const state = decodeJson<DocStatePayload>(frame.payload);
        if (this.canWrite !== null && state.can_write !== this.canWrite) forgetSocketTicket(this.docId);
        this.canWrite = state.can_write;
        this.events.onDocState?.(state);
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
    this.liveness?.stop();
    this.liveness = null;
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
      const error: CoauthorError = { code: "dropped" };
      turn.onDone(error);
      turn.onEdits({ staged: 0, applied: 0, run_id: null, cross_docs: [], error, notices: [] });
    }
    const ending = ENDINGS.get(code);
    if (ending) {
      this.shouldReconnect = false;
      this.events.onStatus?.(ending);
      return;
    }
    if (code === CloseCode.DOC_RESET) {
      this.shouldReconnect = false;
      forceReload();
      return;
    }
    if (!this.shouldReconnect) return;
    this.events.onStatus?.("reconnecting");
    // Sent on this socket with no receipt, so they may never have arrived: unsent until the handshake re-delivers them.
    if (this.pendingAcks > 0 && !this.ackOverdue) {
      this.ackOverdue = true;
      this.emitStatus(this.events.onLocalUpdateDropped, "onLocalUpdateDropped");
    }
    // A new role: a fresh ticket, at once, so the reach it brings applies now.
    if (code === CloseCode.ROLE_CHANGED) {
      forgetSocketTicket(this.docId);
      this.scheduleReconnect(0);
      return;
    }
    this.scheduleReconnect(this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  /**
   * A socket that stopped answering. A dead link can take a minute to report its
   * close, so the page treats it as closed now and the socket is left to finish
   * on its own, unheard.
   */
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
    if (ws.readyState === WebSocket.OPEN) this.liveness?.probe();
  }

  /**
   * The browser says the network went or came back. Going: ask the open socket,
   * which answers at once if the link still works. Coming back: a socket waiting
   * out its backoff tries now.
   */
  private onNetworkChange(): void {
    if (!this.shouldReconnect) return;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      this.liveness?.probe();
      return;
    }
    if (navigator.onLine && (!ws || ws.readyState === WebSocket.CLOSED)) {
      this.backoff = 1000;
      this.scheduleReconnect(0);
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
    // Opening the document again asks for a ticket again, with whatever tier the person has by then.
    forgetSocketTicket(this.docId);
    this.resetAckTracking();
    if (this.visibilityBound && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityBound);
      this.visibilityBound = null;
    }
    if (this.pageHideBound && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.pageHideBound);
      this.pageHideBound = null;
    }
    if (this.networkBound && typeof window !== "undefined") {
      window.removeEventListener("online", this.networkBound);
      window.removeEventListener("offline", this.networkBound);
      this.networkBound = null;
    }
    if (this.awarenessKeepalive) clearInterval(this.awarenessKeepalive);
    this.liveness?.stop();
    this.liveness = null;
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
