import { describe, expect, it } from "vitest";
import { createSessionSockets, SESSION_ENDED_CLOSE_CODE } from "./session-sockets.js";

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
