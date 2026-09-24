// @vitest-environment jsdom
/** Socket bookkeeping: sockets are counted over the provider's whole lifetime, since `this.ws` shows only the newest. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import {
  decodeAwareness,
  decodeFrame,
  encodeAwareness,
  encodeBinary,
  encodeEmpty,
  encodeEpoch,
} from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";

// A ticket is always in hand, so the constructor opens a socket synchronously.
vi.mock("../lib/session/tickets", () => ({
  cachedSocketTicket: () => "test-ticket",
  ensureSocketTicket: async () => "test-ticket",
}));

/** Every socket the provider has constructed during a test. */
let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }

  /** Drive the handshake far enough that the provider installs its timers. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** A close the provider did not initiate (network drop, server restart). */
  dropped(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Deliver a server→client binary frame. */
  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }

  /** Opcodes this socket has sent, in order. */
  opcodes(): number[] {
    return this.sent
      .filter((d): d is ArrayBufferLike | ArrayBufferView => typeof d !== "string")
      .map((d) => new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer)[0]!);
  }
}

/** Sockets never closed. */
function liveSockets(): FakeSocket[] {
  return sockets.filter((s) => s.readyState !== FakeSocket.CLOSED);
}

let hidden = false;
let StugaProvider: typeof import("./stuga-provider").StugaProvider;

beforeEach(async () => {
  vi.useFakeTimers();
  sockets = [];
  hidden = false;
  vi.stubGlobal("WebSocket", FakeSocket);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  ({ StugaProvider } = await import("./stuga-provider"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Fire visibilitychange the way the browser would. */
function foreground(): void {
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("teardown during backoff", () => {
  it("does not open a socket after destroy()", () => {
    const p = new StugaProvider("doc1", "alice");
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();

    sockets[0]!.dropped();
    expect(sockets).toHaveLength(1);

    p.destroy();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
    expect(liveSockets()).toHaveLength(0);
  });

  it("reconnects when it is not destroyed", () => {
    new StugaProvider("doc1", "alice");
    sockets[0]!.open();
    sockets[0]!.dropped();

    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(liveSockets()).toHaveLength(1);
  });
});

describe("foregrounding a tab", () => {
  it("reconnects immediately without racing the queued retry", () => {
    new StugaProvider("doc1", "alice");
    sockets[0]!.open();

    hidden = true;
    sockets[0]!.dropped();
    expect(sockets).toHaveLength(1);

    foreground();
    vi.advanceTimersByTime(0);
    expect(sockets).toHaveLength(2);

    // The retry the drop queued must not also fire.
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(2);
    expect(liveSockets()).toHaveLength(1);
  });

  it("leaves a healthy socket connected", () => {
    new StugaProvider("doc1", "alice");
    sockets[0]!.open();
    const before = sockets[0]!.sent.length;

    hidden = true;
    foreground();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(FakeSocket.OPEN);
    expect(sockets[0]!.sent.length).toBeGreaterThan(before);
  });

  it("backs off progressively instead of hammering", () => {
    new StugaProvider("doc1", "alice");
    sockets[0]!.open();
    sockets[0]!.dropped();

    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);

    sockets[1]!.dropped();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
  });
});

describe("presence teardown", () => {
  /** A peer fed the provider's awareness frames as the actor relays them, so tests assert on what it sees. */
  function peer(): { awareness: Awareness; absorb: (socket: FakeSocket) => void; sees: () => number[] } {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    let cursor = 0;
    return {
      awareness,
      absorb(socket) {
        for (const raw of socket.sent.slice(cursor)) {
          cursor++;
          if (typeof raw === "string") continue;
          const bytes = new Uint8Array(
            raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer,
          );
          const frame = decodeFrame(bytes);
          if (frame?.opcode !== Opcode.AWARENESS) continue;
          const decoded = decodeAwareness(frame.payload);
          if (decoded?.yjsAwareness) applyAwarenessUpdate(awareness, decoded.yjsAwareness, "remote");
        }
      },
      /** Remote clientIDs this peer currently believes are present. */
      sees() {
        return [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
      },
    };
  }

  it("removes the departing tab's cursor on destroy()", () => {
    const p = new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();
    p.awareness.setLocalStateField("user", { name: "alice", color: "#f00" });

    const collaborator = peer();
    collaborator.absorb(ws);
    expect(collaborator.sees()).toContain(p.doc.clientID);

    p.destroy();
    collaborator.absorb(ws);
    expect(collaborator.sees()).not.toContain(p.doc.clientID);
  });

  it("removes the cursor on a real unload, where effect cleanups never run", () => {
    const p = new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();
    p.awareness.setLocalStateField("user", { name: "alice" });

    const collaborator = peer();
    collaborator.absorb(ws);
    expect(collaborator.sees()).toContain(p.doc.clientID);

    window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: false }));
    collaborator.absorb(ws);
    expect(collaborator.sees()).not.toContain(p.doc.clientID);
  });

  it("keeps presence intact across a bfcache freeze", () => {
    const p = new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();
    p.awareness.setLocalStateField("user", { name: "alice" });

    const collaborator = peer();
    collaborator.absorb(ws);

    window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));
    collaborator.absorb(ws);
    expect(collaborator.sees()).toContain(p.doc.clientID);
  });

  it("answers a newly seen peer so the newcomer learns we are here", () => {
    const p = new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();
    p.awareness.setLocalStateField("user", { name: "alice" });

    const latecomer = peer();
    latecomer.absorb(ws);
    const before = ws.sent.length;

    latecomer.awareness.setLocalStateField("user", { name: "bob" });
    ws.deliver(
      encodeAwareness(
        { alias: "bob" },
        encodeAwarenessUpdate(latecomer.awareness, [latecomer.awareness.clientID]),
      ),
    );

    expect(ws.sent.length).toBeGreaterThan(before);
    latecomer.absorb(ws);
    expect(latecomer.sees()).toContain(p.doc.clientID);
  });

  it("does not answer a known peer's ordinary caret traffic", () => {
    const p = new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();
    p.awareness.setLocalStateField("user", { name: "alice" });

    const other = peer();
    other.awareness.setLocalStateField("user", { name: "bob" });
    const announce = () =>
      ws.deliver(
        encodeAwareness({ alias: "bob" }, encodeAwarenessUpdate(other.awareness, [other.awareness.clientID])),
      );
    announce(); // first sighting — a reply is expected here
    const afterIntroduction = ws.sent.length;

    other.awareness.setLocalStateField("user", { name: "bob", cursor: 12 });
    announce();
    expect(ws.sent.length).toBe(afterIntroduction);
  });
});

describe("the rollback-generation fence", () => {
  /** The state vector a server sends to open its side of the handshake. */
  const serverStep1 = () => encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(new Y.Doc()));

  it("answers SYNC_STEP_1 only after the epoch is settled", () => {
    new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();

    ws.deliver(encodeBinary(Opcode.DOCUMENT_EPOCH, encodeEpoch(3)));
    expect(ws.opcodes()).toContain(Opcode.DOCUMENT_EPOCH_ACK);
    expect(ws.opcodes()).toContain(Opcode.SYNC_STEP_1);

    ws.deliver(serverStep1());
    expect(ws.opcodes()).toContain(Opcode.SYNC_STEP_2);
  });

  it("stays silent when the server never announces an epoch", () => {
    new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();

    ws.deliver(serverStep1());
    expect(ws.opcodes()).not.toContain(Opcode.SYNC_STEP_2);
  });

  it("stays silent when the announced epoch was malformed", () => {
    new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();

    // Wrong width.
    ws.deliver(encodeBinary(Opcode.DOCUMENT_EPOCH, new Uint8Array([1, 0, 0])));
    expect(ws.opcodes()).not.toContain(Opcode.DOCUMENT_EPOCH_ACK);

    ws.deliver(serverStep1());
    expect(ws.opcodes()).not.toContain(Opcode.SYNC_STEP_2);
  });

  it("acks once per socket, not once per epoch frame", () => {
    new StugaProvider("doc1", "alice");
    const ws = sockets[0]!;
    ws.open();

    const epoch = encodeBinary(Opcode.DOCUMENT_EPOCH, encodeEpoch(3));
    ws.deliver(epoch);
    ws.deliver(epoch);
    expect(ws.opcodes().filter((o) => o === Opcode.DOCUMENT_EPOCH_ACK)).toHaveLength(1);
  });

  it("re-runs the handshake on a reconnect", () => {
    new StugaProvider("doc1", "alice");
    sockets[0]!.open();
    sockets[0]!.deliver(encodeBinary(Opcode.DOCUMENT_EPOCH, encodeEpoch(3)));
    sockets[0]!.deliver(encodeEmpty(Opcode.SYNC_DONE));
    sockets[0]!.dropped();

    vi.advanceTimersByTime(1_000);
    const next = sockets[1]!;
    next.open();
    expect(next.opcodes()).not.toContain(Opcode.SYNC_STEP_1);
    next.deliver(encodeBinary(Opcode.DOCUMENT_EPOCH, encodeEpoch(3)));
    expect(next.opcodes()).toContain(Opcode.SYNC_STEP_1);
  });
});

describe("terminal closes", () => {
  it("never reconnects after access is revoked", () => {
    const statuses: string[] = [];
    new StugaProvider("doc1", "alice", { onStatus: (s) => statuses.push(s) });
    sockets[0]!.open();

    sockets[0]!.dropped(4403); // CloseCode.ACCESS_REVOKED
    vi.advanceTimersByTime(120_000);

    expect(sockets).toHaveLength(1);
    expect(statuses).toContain("revoked");
  });

  it("stays down on foreground after revocation", () => {
    new StugaProvider("doc1", "alice");
    sockets[0]!.open();
    sockets[0]!.dropped(4403);

    foreground();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });
});
