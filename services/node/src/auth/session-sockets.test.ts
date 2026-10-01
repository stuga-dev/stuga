import { describe, expect, it } from "vitest";
import { createSessionSockets, SESSION_ENDED_CLOSE_CODE, TRY_AGAIN_CLOSE_CODE } from "./session-sockets.js";

/** A server socket as far as this needs one: whether it is closed, and how it was. */
function socket() {
  const s = {
    closed: null as { code: number; reason: string } | null,
    close(code?: number, reason?: string) {
      s.closed ??= { code: code ?? 1000, reason: reason ?? "" };
    },
  };
  return s;
}

/** Each upgrade response stands for its socket. */
function harness() {
  const of = new Map<Response, ReturnType<typeof socket>>();
  const sockets = createSessionSockets((res) => of.get(res)!);
  const open = (sid: string, alias: string) => {
    const s = socket();
    const res = new Response(null);
    of.set(res, s);
    sockets.track(sid, alias, res, "remote");
    return s;
  };
  return { sockets, open };
}

describe("the sockets a sign-in has open", () => {
  it("close with 4401 when the sign-in ends, and no others", async () => {
    const { sockets, open } = harness();
    const a1 = open("s1", "liv");
    const a2 = open("s1", "liv");
    const other = open("s2", "liv");
    expect(sockets.closeSessions(["s1"])).toBe(2);
    expect(a1.closed).toEqual({ code: SESSION_ENDED_CLOSE_CODE, reason: "signed out" });
    expect(a2.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
    expect(other.closed).toBeNull();
    // Already gone: nothing more to close.
    expect(sockets.closeSessions(["s1"])).toBe(0);
  });

  it("close for every sign-in of an account, and nobody else's", async () => {
    const { sockets, open } = harness();
    const mine = [open("s1", "liv"), open("s2", "liv")];
    const theirs = open("s3", "bo");
    expect(sockets.closeAccount("liv")).toBe(2);
    expect(mine.every((s) => s.closed?.code === SESSION_ENDED_CLOSE_CODE)).toBe(true);
    expect(theirs.closed).toBeNull();
  });

  it("forget a socket that closed on its own", async () => {
    const { sockets, open } = harness();
    const gone = open("s1", "liv");
    gone.close(1000, "tab closed");
    const live = open("s1", "liv");
    expect(sockets.closeSessions(["s1"])).toBe(1);
    expect(gone.closed).toEqual({ code: 1000, reason: "tab closed" });
    expect(live.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
  });

  it("close on a sweep once their sign-in has ended by itself, and keep the live ones", async () => {
    const { sockets, open } = harness();
    const ended = open("s1", "liv");
    const live = open("s2", "liv");
    const asked: string[] = [];
    const n = await sockets.sweep(async (s) => {
      asked.push(`${s.sessionId}:${s.alias}:${s.arrival}`);
      return s.sessionId === "s2";
    });
    expect(n).toBe(1);
    expect(asked).toEqual(["s1:liv:remote", "s2:liv:remote"]);
    expect(ended.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
    expect(live.closed).toBeNull();
  });
});

describe("each message a socket sends", () => {
  /** Sockets whose sign-in ends when `ends` says, read through a counted, controllable lookup. */
  function gated(recheckMs = 5_000) {
    let now = 1_000_000;
    let ends: number | null = now + 3_600_000;
    let reads = 0;
    let hold: Promise<void> | null = null;
    let failing = false;
    const of = new Map<Response, ReturnType<typeof socket> & { gate?: import("@stuga/runtime").InboundGate | null }>();
    const sockets = createSessionSockets({
      socketOf: (res) => of.get(res)!,
      now: () => now,
      recheckMs,
      liveUntil: async () => {
        reads++;
        if (hold) await hold;
        if (failing) throw new Error("connection refused");
        return ends === null || ends <= now ? null : new Date(ends);
      },
    });
    const open = (sid: string) => {
      const s = Object.assign(socket(), { gate: null as import("@stuga/runtime").InboundGate | null });
      const res = new Response(null);
      of.set(res, s);
      sockets.track(sid, "liv", res, "remote");
      return s;
    };
    return {
      sockets,
      open,
      advance: (ms: number) => void (now += ms),
      end: (at: number | null) => void (ends = at),
      endsIn: (ms: number) => void (ends = now + ms),
      reads: () => reads,
      failReads: () => void (failing = true),
      holdReads: () => {
        let release!: () => void;
        hold = new Promise((r) => (release = r));
        return () => {
          hold = null;
          release();
        };
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("goes on at once while the last read of its sign-in vouches for it, reading again once that is old", async () => {
    const g = gated();
    const s = g.open("s1");
    const got: number[] = [];
    // The first message reads the sign-in: the upgrade knew it was on, not until when.
    s.gate!.admit(() => got.push(1));
    await flush();
    expect(got).toEqual([1]);
    expect(g.reads()).toBe(1);
    s.gate!.admit(() => got.push(2));
    expect(got).toEqual([1, 2]);
    g.advance(5_000);
    s.gate!.admit(() => got.push(3));
    await flush();
    expect(got).toEqual([1, 2, 3]);
    expect(g.reads()).toBe(2);
    // That read vouches for the next five seconds.
    s.gate!.admit(() => got.push(4));
    expect(got).toEqual([1, 2, 3, 4]);
    expect(g.reads()).toBe(2);
  });

  it("is refused on a socket opened just before its sign-in's end, once that end has passed", async () => {
    const g = gated();
    g.endsIn(1_000);
    const s = g.open("s1");
    g.advance(1_000);
    const got: number[] = [];
    s.gate!.admit(() => got.push(1));
    await flush();
    expect(got).toEqual([]);
    expect(s.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
  });

  it("is dropped when a route ends the sign-in while its read is out, though the read found it on", async () => {
    const g = gated();
    const s = g.open("s1");
    const release = g.holdReads();
    const got: number[] = [];
    s.gate!.admit(() => got.push(1));
    await flush();
    g.sockets.closeSessions(["s1"]);
    release();
    await flush();
    await flush();
    expect(got).toEqual([]);
    expect(s.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
  });

  it("is dropped, and the socket closed to be opened again, when the sign-in cannot be read", async () => {
    const g = gated();
    const s = g.open("s1");
    g.failReads();
    const got: number[] = [];
    s.gate!.admit(() => got.push(1));
    await flush();
    await flush();
    expect(got).toEqual([]);
    expect(s.closed?.code).toBe(TRY_AGAIN_CLOSE_CODE);
  });

  it("is dropped, and the socket closed with 4401, once the sign-in has ended", async () => {
    const g = gated();
    const s = g.open("s1");
    g.end(null);
    g.advance(5_000);
    const got: number[] = [];
    s.gate!.admit(() => got.push(1));
    s.gate!.admit(() => got.push(2));
    await flush();
    expect(got).toEqual([]);
    expect(s.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
    s.gate!.admit(() => got.push(3));
    await flush();
    expect(got).toEqual([]);
  });

  it("is never taken past the sign-in's end, which a read learns, however recent the read", async () => {
    const g = gated();
    const s = g.open("s1");
    g.endsIn(5_000 + 1_000);
    g.advance(5_000);
    s.gate!.admit(() => {});
    await flush();
    expect(g.reads()).toBe(1);
    // The read said the sign-in ends in a second: past that, the next message reads again, and is refused.
    g.advance(1_000);
    const got: number[] = [];
    s.gate!.admit(() => got.push(1));
    await flush();
    expect(got).toEqual([]);
    expect(s.closed?.code).toBe(SESSION_ENDED_CLOSE_CODE);
  });

  it("waits behind a read in flight, each socket's in order, and one read serves every socket of the sign-in", async () => {
    const g = gated();
    const a = g.open("s1");
    const b = g.open("s1");
    g.advance(5_000);
    const release = g.holdReads();
    const got: string[] = [];
    a.gate!.admit(() => got.push("a1"));
    b.gate!.admit(() => got.push("b1"));
    a.gate!.admit(() => got.push("a2"));
    await flush();
    expect(got).toEqual([]);
    release();
    await flush();
    await flush();
    // Each socket's own in order; one read for both.
    expect(got.filter((m) => m.startsWith("a"))).toEqual(["a1", "a2"]);
    expect(got).toContain("b1");
    expect(g.reads()).toBe(1);
  });

  it("goes nowhere once a route has closed the socket", async () => {
    const g = gated();
    const s = g.open("s1");
    g.sockets.closeSessions(["s1"]);
    const got: number[] = [];
    s.gate!.admit(() => got.push(1));
    await flush();
    expect(got).toEqual([]);
  });

  it("passes as before when the sign-in cannot be read: no gate is set", () => {
    const of = new Map<Response, ReturnType<typeof socket> & { gate?: import("@stuga/runtime").InboundGate | null }>();
    const sockets = createSessionSockets((res) => of.get(res)!);
    const s = Object.assign(socket(), { gate: undefined as import("@stuga/runtime").InboundGate | null | undefined });
    const res = new Response(null);
    of.set(res, s);
    sockets.track("s1", "liv", res, "remote");
    expect(s.gate).toBeUndefined();
  });
});
