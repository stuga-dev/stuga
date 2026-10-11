// @vitest-environment jsdom
/** The database channel notices a dead link while idle, and retries when the network is back. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_DEADLINE_MS, PROBE_EVERY_MS } from "./socket-liveness";

vi.mock("../lib/session/tickets", () => ({
  cachedSocketTicket: () => "test-ticket",
  ensureSocketTicket: async () => "test-ticket",
  forgetSocketTicket: () => {},
}));

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("not open");
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

let DatabaseSocket: typeof import("./database-socket").DatabaseSocket;
let channels: InstanceType<typeof DatabaseSocket>[] = [];

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(async () => {
  vi.useFakeTimers();
  sockets = [];
  channels = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  ({ DatabaseSocket } = await import("./database-socket"));
});

afterEach(() => {
  for (const c of channels) c.destroy();
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  vi.useRealTimers();
});

function channel() {
  const statuses: string[] = [];
  const c = new DatabaseSocket("db1");
  channels.push(c);
  c.onStatus = (s) => statuses.push(s);
  sockets[0]!.open();
  return statuses;
}

describe("the database channel", () => {
  it("is reported down when an idle socket stops answering", () => {
    const statuses = channel();
    vi.advanceTimersByTime(PROBE_EVERY_MS + PROBE_DEADLINE_MS);
    expect(statuses.at(-1)).toBe("down");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it("retries at once when the network is back, with one socket", () => {
    channel();
    sockets[0]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[1]!.close();
    expect(sockets).toHaveLength(2);
    setOnline(true);
    expect(sockets).toHaveLength(3);
    // The retry it replaced does not also fire.
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(3);
  });
});
