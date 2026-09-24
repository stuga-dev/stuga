import { describe, expect, it } from "vitest";
import {
  FAILURES_BEFORE_NOTICE,
  HEALTHY_POLL_MS,
  TROUBLED_POLL_MS,
  newNodeHealth,
  notice,
  observe,
  pollDelay,
  type NodeHealth,
  type Probe,
} from "./node-health";

/** Fold a sequence of probes over a fresh model. */
function run(...probes: Probe[]): NodeHealth {
  return probes.reduce(observe, newNodeHealth());
}

describe("when the notice appears", () => {
  it("says nothing before anything has been probed", () => {
    expect(notice(newNodeHealth())).toBeNull();
  });

  it("stays quiet through a single failure", () => {
    expect(notice(run("unready"))).toBeNull();
    expect(notice(run("unreachable"))).toBeNull();
  });

  it("speaks up once the trouble outlives a retry", () => {
    expect(notice(run("unready", "unready"))).not.toBeNull();
    expect(run("unready", "unready").failures).toBe(FAILURES_BEFORE_NOTICE);
  });

  it("clears on the first success, with no streak to earn back", () => {
    const recovered = run("unready", "unready", "unready", "ok");
    expect(notice(recovered)).toBeNull();
    expect(recovered.failures).toBe(0);
  });

  it("does not let a success and a failure cancel out into silence", () => {
    expect(notice(run("unready", "ok", "unready"))).toBeNull();
  });
});

describe("the browser's own network is not evidence about the server", () => {
  it("never accuses the server while the browser is offline", () => {
    expect(notice(run("offline", "offline", "offline"))).toBeNull();
  });

  it("clears a pending count when the browser goes offline mid-outage", () => {
    const h = run("unreachable", "offline");
    expect(h.failures).toBe(0);
    expect(notice(h)).toBeNull();
  });
});

describe("a 200 that never reached the node", () => {
  it("is not counted as health, however many times it repeats", () => {
    const h = run("opaque", "opaque", "opaque");
    expect(h.last).toBe("opaque");
    expect(notice(h)).toBeNull();
  });

  it("is not counted as a failure either", () => {
    expect(run("opaque", "opaque").failures).toBe(0);
  });

  it("stops accusing, without counting as health, after a confirmed outage", () => {
    const h = run("unready", "unready");
    expect(notice(h)).not.toBeNull();
    expect(notice(observe(h, "opaque"))).toBeNull();
  });
});

describe("the two failures read differently", () => {
  it("names the database when the node itself reports not-ready", () => {
    const n = notice(run("unready", "unready"))!;
    expect(n.status).toBe("error");
    expect(n.title).toMatch(/database/i);
  });

  it("blames only the connection when nothing answered", () => {
    const n = notice(run("unreachable", "unreachable"))!;
    expect(n.status).toBe("warning");
    expect(n.title).not.toMatch(/database/i);
  });

  it("keeps the node's own verdict when a later probe merely hears nothing", () => {
    const h = run("unready", "unready", "unreachable");
    expect(h.failures).toBe(3);
    expect(notice(h)!.title).toMatch(/database/i);
  });

  it("adopts the node's verdict when it arrives after silence", () => {
    const h = run("unreachable", "unreachable", "unready");
    expect(notice(h)!.title).toMatch(/database/i);
  });

  it("forgets the old verdict once the outage ends", () => {
    const h = run("unready", "unready", "ok", "unreachable", "unreachable");
    expect(notice(h)!.title).not.toMatch(/database/i);
  });

  it("leaves any claim about stored work to the document's own indicator", () => {
    const forbidden = /saved|persisted|durable|stored your|were not stored/i;
    for (const h of [run("unready", "unready"), run("unreachable", "unreachable")]) {
      const n = notice(h)!;
      expect(n.title).not.toMatch(forbidden);
      expect(n.description).not.toMatch(forbidden);
    }
  });
});

describe("probe cadence", () => {
  it("polls lazily while healthy and quickly once troubled", () => {
    expect(pollDelay(newNodeHealth())).toBe(HEALTHY_POLL_MS);
    expect(pollDelay(run("ok"))).toBe(HEALTHY_POLL_MS);
    expect(pollDelay(run("unready"))).toBe(TROUBLED_POLL_MS);
  });

  it("goes back to the lazy cadence as soon as it recovers", () => {
    expect(pollDelay(run("unready", "unready", "ok"))).toBe(HEALTHY_POLL_MS);
  });

  it("speeds up on the first failure, so the notice is one retry away", () => {
    expect(notice(run("unreachable"))).toBeNull();
    expect(pollDelay(run("unreachable"))).toBe(TROUBLED_POLL_MS);
  });
});
