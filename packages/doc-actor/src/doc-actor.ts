/**
 * DocActor — one actor per document: the authoritative Yjs CRDT, its sockets,
 * its run ledger and its co-author. Every request from the node names the
 * document with `?docId=`; the node authenticates and authorizes before
 * forwarding, so the control routes trust their caller.
 */
import * as Y from "yjs";
import { snapshotKey } from "@stuga/protocol/domain/limits";
import { decodeAwareness, decodeEpoch, decodeFrame, encodeBinary, encodeEmpty, encodeEpoch, encodeJson } from "@stuga/protocol/wire/frame";
import { CloseCode, Opcode, type PersistDegradedPayload } from "@stuga/protocol/wire/opcodes";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { applyCitedStrEdits, yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { SocketPair, upgradeResponse, type Actor, type ActorState } from "@stuga/runtime";
import { Refusals } from "./audit.js";
import { CoAuthor } from "./coauthor/turn.js";
import type { DocActorEnv } from "./env.js";
import { RunLedger } from "./ledger/run-store.js";
import {
  handleRunAck,
  handleRunDecide,
  handleRunDetail,
  handleRunList,
  handleRunPropose,
  handleRunRevert,
} from "./ledger/routes.js";
import { Peers, parseSession, safeSend, type DocSocket, type SessionMeta } from "./session.js";
import { DocStore } from "./store/doc-store.js";
import { recoverHead, restoreToVersion } from "./store/head.js";
import { judgeWrite, RateLimiter } from "./sync/gates.js";

const MAX_WS_FRAME_BYTES = 8 * 1024 * 1024;

type Route = { method?: "POST"; handle: (req: Request, url: URL) => Promise<Response> };

export class DocActor implements Actor<SessionMeta> {
  private readonly peers: Peers;
  private readonly store: DocStore;
  private readonly refusals: Refusals;
  private readonly ledger: RunLedger;
  private readonly coauthor: CoAuthor;
  private readonly rate = new RateLimiter();
  private readonly routes: Record<string, Route>;
  /** Set by /destroy; every entry point is inert afterwards. */
  private destroyed = false;

  constructor(
    private readonly state: ActorState<SessionMeta>,
    private readonly env: DocActorEnv,
  ) {
    this.peers = new Peers(state);
    this.store = new DocStore(state.storage, env, this.peers);
    this.refusals = new Refusals(env.jobs, () => this.store.docId);
    this.ledger = new RunLedger(state.storage, env, this.store, this.peers);
    this.coauthor = new CoAuthor(env, this.ledger, this.refusals, this.rate);
    this.routes = {
      "/connect": { handle: (req, url) => this.connect(req, url) },
      "/revoke": { handle: async (_req, url) => this.revoke(url) },
      "/version-content": { handle: async (_req, url) => this.versionContent(url) },
      "/markdown": { handle: async (_req, url) => this.markdown(url) },
      "/runs": { handle: async (_req, url) => handleRunList(this.ledger, url) },
      "/runs/detail": { handle: async (_req, url) => handleRunDetail(this.ledger, url) },
      "/runs/propose": { method: "POST", handle: (req) => handleRunPropose(this.ledger, req) },
      "/runs/decide": { method: "POST", handle: (req) => handleRunDecide(this.ledger, req) },
      "/runs/revert": { method: "POST", handle: (req) => handleRunRevert(this.ledger, req) },
      "/runs/ack": { method: "POST", handle: (req) => handleRunAck(this.ledger, req) },
      "/apply-edits": { method: "POST", handle: (req) => this.applyEdits(req) },
      "/restore": { handle: async (_req, url) => this.restore(url) },
      "/recover": { method: "POST", handle: (req) => this.recover(req) },
      "/set-locked": { handle: async (_req, url) => this.setLocked(url) },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/destroy") return this.destroy();
    if (this.destroyed) return Response.json({ error: "document deleted" }, { status: 410 });
    const route = this.routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    if (route.method && req.method !== route.method) return new Response("method not allowed", { status: 405 });
    const docId = url.searchParams.get("docId");
    if (!docId) return new Response("docId required", { status: 400 });
    this.store.docId = docId;
    return route.handle(req, url);
  }

  // ---- control routes ------------------------------------------------------

  /**
   * Re-apply a changed ACL to open sockets. `writer` is repeated per principal of
   * the new writer set; `writersStated` is required so a request that lost its
   * writer list is refused rather than read as "nobody may write".
   */
  private revoke(url: URL): Response {
    if (!url.searchParams.has("writersStated")) return new Response("writersStated required", { status: 400 });
    const allowed = new Set(url.searchParams.getAll("principal"));
    const writers = new Set(url.searchParams.getAll("writer"));
    for (const ws of this.peers.applyAcl(allowed, writers)) {
      // Flip the editor now rather than at the next refused keystroke.
      this.refusals.reject(ws, "acl", "Your access to this document is now view-only.", "notice");
    }
    return new Response(null, { status: 204 });
  }

  /** A historical snapshot as Markdown, through the same serializer as the live baseline so unchanged text diffs equal. */
  private async versionContent(url: URL): Promise<Response> {
    const seq = Number(url.searchParams.get("seq"));
    if (!Number.isFinite(seq)) return new Response("bad request", { status: 400 });
    const obj = await this.env.snapshots.get(snapshotKey(this.store.docId, seq));
    if (!obj) return new Response("version not found", { status: 404 });
    const tmp = new Y.Doc();
    Y.applyUpdate(tmp, new Uint8Array(await obj.arrayBuffer()), "preview");
    return Response.json({ seq, text: yXmlFragmentToMarkdown(tmp.getXmlFragment("default")) });
  }

  /** The live document as Markdown; with `agent=`, as that agent's own pending hunks leave it. */
  private async markdown(url: URL): Promise<Response> {
    await this.store.ensureLoaded();
    const agentAlias = url.searchParams.get("agent");
    if (!agentAlias) return Response.json({ markdown: this.store.markdown() });
    const view = await this.ledger.projectionFor(agentAlias);
    if (view.runId && view.pending.length > 0) {
      return Response.json({ markdown: view.markdown, run_id: view.runId, pending: view.pending.length });
    }
    return Response.json({ markdown: view.markdown });
  }

  /**
   * Apply surgical edits with no review step: the Markdown import seed. The
   * edits apply to the live markdown (a stale find is skipped) and merge against
   * it, so concurrent edits elsewhere survive.
   */
  private async applyEdits(req: Request): Promise<Response> {
    await this.store.ensureLoaded();
    const body = (await req.json().catch(() => null)) as {
      str_edits?: Array<{ old_string: string; new_string: string }>;
      citations?: AiCitation[];
      agent?: string;
    } | null;
    if (!body || !Array.isArray(body.str_edits) || body.str_edits.length === 0) {
      return Response.json({ error: "no edits" }, { status: 400 });
    }
    const current = this.store.markdown();
    const next = applyCitedStrEdits(current, body.str_edits, body.citations ?? []);
    if (next === current) return Response.json({ applied: false, seq: this.store.seq });
    await this.store.commitMarkdown(next, current, { agent: body.agent || "agent" }, "headless-large");
    return Response.json({ applied: true, seq: this.store.seq });
  }

  /**
   * Destroy this document's actor state after its row is gone. Sockets close
   * first, then the actor latches, so neither a queued frame nor the close
   * callbacks those closes trigger can write the document back.
   */
  private async destroy(): Promise<Response> {
    if (!this.destroyed) {
      for (const ws of this.peers.all()) {
        try {
          ws.close(4404, "document deleted");
        } catch {
          /* already closing */
        }
      }
      this.destroyed = true;
      await this.store.destroy();
      this.ledger.reset();
    }
    return Response.json({ destroyed: true });
  }

  /** Roll back to a version, written as a new head seq; every client is reset to resync. */
  private async restore(url: URL): Promise<Response> {
    const seq = Number(url.searchParams.get("seq"));
    if (!Number.isFinite(seq)) return new Response("bad request", { status: 400 });
    const newSeq = await restoreToVersion(this.store, this.env, this.peers, seq);
    if (newSeq === null) return new Response("version not found", { status: 404 });
    return Response.json({ restored: seq, seq: newSeq });
  }

  /** Rebuild an unreadable head, on an operator's request; the node forwards `docs.search_text` as fallback material. */
  private async recover(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { fallback_markdown?: string } | null;
    const result = await recoverHead(this.store, this.env, this.peers, body?.fallback_markdown ?? "");
    if (result.status !== 200) return Response.json({ recovered: false, error: result.error }, { status: result.status });
    return Response.json({ recovered: true, seq: result.seq, epoch: result.epoch, from: result.from, stranded: result.stranded });
  }

  /**
   * Mirror the lock flag. Locking tells every socket with a "locked" refusal so
   * editors flip read-only at once; unlocking sends nothing, the caller's own
   * menu lowers the flag.
   */
  private async setLocked(url: URL): Promise<Response> {
    await this.store.ensureLoaded();
    await this.store.setLocked(url.searchParams.get("locked") === "1");
    if (this.store.locked) {
      for (const ws of this.peers.all()) {
        this.refusals.reject(ws, "locked", "This document was locked; it is now read-only.", "notice");
      }
    }
    return Response.json({ locked: this.store.locked });
  }

  private async connect(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const meta = parseSession(url);
    if (!meta) return new Response("connect requires alias, write, principal and workspaceId", { status: 400 });
    await this.store.ensureLoaded();

    const pair = new SocketPair<SessionMeta>();
    this.state.acceptWebSocket(pair.server, meta);
    if (meta.agent) console.info("ws agent connected", { docId: this.store.docId, agent: meta.agent, canWrite: meta.canWrite });
    this.peers.logConnectionCounts(this.store.docId, "connect");

    // The epoch goes first: a client must know the rollback generation before it
    // decides what to send, and the provider will not answer SYNC_STEP_1 without
    // it. A raw send, so a failure fails the upgrade instead of a silently stuck tab.
    pair.server.send(encodeBinary(Opcode.DOCUMENT_EPOCH, encodeEpoch(this.store.epoch)));
    pair.server.send(encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(this.store.doc)));
    // Arms only if hydration replayed an unflushed log.
    await this.store.armAlarms();
    return upgradeResponse(pair.client);
  }

  // ---- socket entry points -------------------------------------------------

  /** Runs outside the lock: a turn holds the lock for its whole length, so a queued cancel would arrive too late. */
  interceptWebSocketMessage(ws: DocSocket, message: ArrayBuffer | string): boolean {
    if (this.destroyed || typeof message === "string") return false;
    if (decodeFrame(message)?.opcode !== Opcode.AI_CANCEL) return false;
    this.coauthor.cancel(ws);
    return true;
  }

  async webSocketMessage(ws: DocSocket, message: ArrayBuffer | string): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.onMessage(ws, message);
    } catch (err) {
      this.handlerThrew("webSocketMessage", err);
    }
  }

  async webSocketClose(ws: DocSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    if (this.destroyed) return;
    try {
      this.peers.logConnectionCounts(this.store.docId, "disconnect", ws);
      // A revoked socket's departure is not a reason to persist anything on its behalf.
      if (code !== CloseCode.ACCESS_REVOKED && this.store.isDirty) await this.store.flush("eviction");
    } catch (err) {
      this.handlerThrew("webSocketClose", err);
    }
  }

  async webSocketError(): Promise<void> {
    if (this.destroyed) return;
    try {
      if (this.store.isDirty) await this.store.flush("error");
    } catch (err) {
      this.handlerThrew("webSocketError", err);
    }
  }

  /**
   * The flush backstop, never a keepalive. It routinely fires on a fresh instance
   * after a headless write, so it must not gate on in-memory `dirty`: flush
   * rehydrates first and decides.
   */
  async alarm(): Promise<void> {
    if (this.destroyed) return;
    await this.store.flush("timer");
    await this.store.armAlarms();
  }

  /** A socket handler's throw reaches no client; log enough state to tell a dead socket from a storage failure. */
  private handlerThrew(handler: string, err: unknown): void {
    console.error("DocActor socket handler threw", {
      handler,
      docId: this.store.docId,
      seq: this.store.seq,
      epoch: this.store.epoch,
      dirty: this.store.isDirty,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  private async onMessage(ws: DocSocket, message: ArrayBuffer | string): Promise<void> {
    // Binary only; heartbeat strings are answered by the host before they get here.
    if (typeof message === "string") {
      ws.close(1003, "binary frames required");
      return;
    }
    if (message.byteLength > MAX_WS_FRAME_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    const store = this.store;
    await store.ensureLoaded();
    const frame = decodeFrame(message);
    if (!frame) return;

    switch (frame.opcode) {
      case Opcode.SYNC_STEP_1: {
        safeSend(ws, encodeBinary(Opcode.SYNC_STEP_2, Y.encodeStateAsUpdate(store.doc, frame.payload)));
        safeSend(ws, encodeEmpty(Opcode.SYNC_DONE));
        // The degraded flag is edge-triggered, so a socket arriving mid-outage is told here.
        if (store.persistDegraded) {
          safeSend(ws, encodeJson(Opcode.PERSIST_DEGRADED, { degraded: true } satisfies PersistDegradedPayload));
        }
        // After SYNC_DONE, so the client has a document to render the run diff against.
        if (!ws.meta.agentAuth) await this.ledger.sendOpenRunsTo(ws);
        break;
      }
      case Opcode.DOCUMENT_EPOCH_ACK: {
        const claimed = decodeEpoch(frame.payload);
        if (claimed === store.epoch) {
          ws.meta.epochAcked = true;
          break;
        }
        console.warn("ws epoch ack mismatch", { docId: store.docId, alias: ws.meta.alias, claimed, current: store.epoch });
        this.refusals.reject(ws, "epoch", "This document was restored to an earlier version; reloading.");
        this.peers.resetSocket(ws, "epoch mismatch");
        break;
      }
      case Opcode.SYNC_STEP_2:
      case Opcode.UPDATE: {
        const verdict = judgeWrite(frame.opcode, frame.payload, ws, {
          docId: store.docId,
          locked: store.locked,
          epoch: store.epoch,
          doc: store.doc,
          rate: this.rate,
        });
        if (verdict.verdict === "ack") {
          safeSend(ws, encodeEmpty(Opcode.UPDATE_ACK));
          break;
        }
        if (verdict.verdict === "refuse") {
          this.refusals.reject(ws, verdict.kind, verdict.message, verdict.notice ? "notice" : "attempt");
          if (verdict.resetReason) this.peers.resetSocket(ws, verdict.resetReason);
          break;
        }
        store.applyFromClient(frame.payload, { alias: ws.meta.alias, agent: ws.meta.agent });
        // UPDATE_ACK means received and broadcast, not durable.
        await store.maybePersistPending();
        safeSend(ws, encodeEmpty(Opcode.UPDATE_ACK));
        this.peers.broadcast(encodeBinary(Opcode.UPDATE, frame.payload), ws);
        break;
      }
      case Opcode.AWARENESS:
        if (decodeAwareness(frame.payload)) this.peers.broadcast(message, ws);
        break;
      case Opcode.AI_REQUEST:
        await this.coauthor.handleRequest(ws, frame.payload);
        break;
      default:
        break;
    }
  }
}
