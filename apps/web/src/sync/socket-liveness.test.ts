// @vitest-environment jsdom
/** The heartbeat that notices a dead link while nothing is typed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_DEADLINE_MS, PROBE_EVERY_MS, SocketLiveness } from "./socket-liveness";

/** A socket that records what it was sent; `dead` makes send() throw, as a closed one does. */
function socket() {
  const sent: unknown[] = [];
  return { sent, dead: false, bufferedAmount: 0, send(data: unknown) { if (this.dead) throw new Error("closed"); sent.push(data); } };
}

let hidden = false;
let watches: SocketLiveness[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  watches = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  for (const w of watches) w.stop();
  vi.useRealTimers();
});

function watch(opts?: { answerable?: boolean }) {
  const ws = socket();
  const onDead = vi.fn();
  const w = new SocketLiveness(ws as unknown as WebSocket, onDead, opts);
  watches.push(w);
  return { ws, onDead, w };
}

describe("an idle socket", () => {
  it("is asked on a cadence and kept while it answers", () => {
    const { ws, onDead, w } = watch();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PROBE_EVERY_MS);
      w.heard();
    }
    expect(ws.sent).toEqual(["ping", "ping", "ping", "ping", "ping"]);
    vi.advanceTimersByTime(PROBE_DEADLINE_MS);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("is given up within a probe and its deadline once it stops answering", () => {
    const { onDead } = watch();
    vi.advanceTimersByTime(PROBE_EVERY_MS + PROBE_DEADLINE_MS - 1);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDead).toHaveBeenCalledTimes(1);
    // Once: the watch stops itself.
    vi.advanceTimersByTime(PROBE_EVERY_MS * 10);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("waits for a large edit to finish uploading before it expects an answer", () => {
    const { ws, onDead, w } = watch();
    ws.bufferedAmount = 500_000;
    vi.advanceTimersByTime(PROBE_EVERY_MS + PROBE_DEADLINE_MS);
    expect(onDead).not.toHaveBeenCalled();
    ws.bufferedAmount = 0;
    w.probe();
    vi.advanceTimersByTime(PROBE_DEADLINE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("counts any inbound frame as an answer", () => {
    const { onDead, w } = watch();
    vi.advanceTimersByTime(PROBE_EVERY_MS + 100);
    w.heard();
    vi.advanceTimersByTime(PROBE_DEADLINE_MS);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("is given up at once when it cannot even send", () => {
    const { ws, onDead, w } = watch();
    ws.dead = true;
    w.probe();
    expect(onDead).toHaveBeenCalledTimes(1);
  });
});

describe("asking out of turn", () => {
  it("answers a network change within the deadline, not the cadence", () => {
    const { onDead, w } = watch();
    vi.advanceTimersByTime(1_000);
    w.probe();
    vi.advanceTimersByTime(PROBE_DEADLINE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("cannot postpone a verdict by asking again", () => {
    const { onDead, w } = watch();
    w.probe();
    vi.advanceTimersByTime(PROBE_DEADLINE_MS - 1);
    w.probe();
    vi.advanceTimersByTime(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });
});

describe("when an answer may lag", () => {
  it("keeps the socket warm without a deadline until answers are expected", () => {
    const { ws, onDead, w } = watch({ answerable: false });
    vi.advanceTimersByTime(PROBE_EVERY_MS * 3);
    expect(ws.sent.length).toBe(3);
    expect(onDead).not.toHaveBeenCalled();
    w.expectAnswers();
    vi.advanceTimersByTime(PROBE_EVERY_MS + PROBE_DEADLINE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("still gives up on a minute of silence, as during a first sync that never ends", () => {
    const { onDead } = watch({ answerable: false });
    vi.advanceTimersByTime(60_000);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PROBE_EVERY_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("passes no verdict from a hidden tab, whose timers run late", () => {
    const { onDead } = watch();
    hidden = true;
    vi.advanceTimersByTime(PROBE_EVERY_MS * 12);
    expect(onDead).not.toHaveBeenCalled();
  });
});
