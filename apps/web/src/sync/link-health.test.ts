/**
 * Event sequences over the link-health model. The invariants, in rank order:
 * missing receipts beat an open-looking socket; green needs a handshake; a slow
 * first load is quiet; no phase claims the work is saved; a server that says it
 * cannot store is never green.
 */
import { describe, expect, it } from "vitest";
import {
  RECOVERY_FLASH_MS,
  SHOW_RECONNECT_LABEL_AFTER_MS,
  STRANDED_ESCALATION_MS,
  UNDURABLE_ESCALATION_MS,
  advance,
  newLinkHealth,
  readout,
  wantsTicks,
  type LinkEvent,
  type LinkHealth,
} from "./link-health";

const T = 500_000;

/** Fold a sequence of events over a fresh model. */
function run(...events: LinkEvent[]): LinkHealth {
  return events.reduce(advance, newLinkHealth());
}

/** The handshake completed at T — a healthy, settled link. */
const healthy = (): LinkHealth => run({ kind: "handshake", at: T });

/** Healthy, then the socket visibly dropped at T. */
const outage = (): LinkHealth => run({ kind: "handshake", at: T }, { kind: "transport-lost", at: T });

/** Healthy transport and handshake, but the server reported it cannot store. */
const undurable = (): LinkHealth => run({ kind: "handshake", at: T }, { kind: "persist-degraded", at: T });

describe("evidence ranking", () => {
  it("reports at-risk while the transport still claims to be up and synced", () => {
    const h = advance(healthy(), { kind: "edit-stranded", at: T });
    const r = readout(h, /* transportUp */ true, T + 1);
    expect(r.phase).toBe("at-risk");
    expect(r.tone).toBe("warning");
    expect(r.label).toBe("Changes are waiting for connection");
    expect(r.persistent).toBe(true);
  });

  it("escalates stranded edits on elapsed time alone", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "transport-lost", at: T },
      { kind: "edit-stranded", at: T },
    );
    expect(readout(h, false, T + STRANDED_ESCALATION_MS - 1).phase).toBe("at-risk");
    const loud = readout(h, false, T + STRANDED_ESCALATION_MS);
    expect(loud.phase).toBe("prolonged");
    expect(loud.tone).toBe("error");
    expect(loud.label).toBe("Changes are not reaching the server");
  });

  it("lets revocation outrank even stranded edits", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "edit-stranded", at: T },
      { kind: "access-revoked" },
    );
    expect(readout(h, true, T + 1).phase).toBe("revoked");
  });

  it("never lets a reopened socket clear stranded edits by itself", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "edit-stranded", at: T },
      { kind: "transport-lost", at: T + 100 },
    );
    expect(readout(h, true, T + 200).phase).toBe("at-risk");
  });
});

describe("green requires a handshake, not an open transport", () => {
  it("stays at connecting on a brand-new open socket", () => {
    const r = readout(newLinkHealth(), true, T);
    expect(r.phase).toBe("connecting");
    expect(r.tone).not.toBe("success");
  });

  it("goes green once the handshake lands, as a bare dot", () => {
    const r = readout(healthy(), true, T);
    expect(r.phase).toBe("connected");
    expect(r.tone).toBe("success");
    expect(r.label).toBeNull();
    expect(r.expanded).toBe(false);
  });

  it("leaves green the instant the transport drops, before any retry", () => {
    expect(readout(outage(), false, T).tone).toBe("warning");
  });

  it("does not go green again until the NEW socket finishes its own handshake", () => {
    const h = outage();
    expect(readout(h, true, T).phase).toBe("reconnecting");
    expect(readout(advance(h, { kind: "handshake", at: T + 50 }), true, T + 50).phase).toBe("recovered");
  });
});

describe("quiet first load vs. visible outage", () => {
  it("stays quiet during a slow first load, however long it takes", () => {
    const r = readout(newLinkHealth(), false, T + 60_000);
    expect(r.phase).toBe("connecting");
    expect(r.tone).toBe("neutral");
    expect(r.expanded).toBe(false);
    expect(r.label).toBeNull();
  });

  it("shows a silent dot for a blip and a label once it lingers", () => {
    const h = outage();
    const blip = readout(h, false, T + SHOW_RECONNECT_LABEL_AFTER_MS - 1);
    expect(blip.phase).toBe("reconnecting");
    expect(blip.label).toBeNull();
    expect(blip.expanded).toBe(false);

    const lingering = readout(h, false, T + SHOW_RECONNECT_LABEL_AFTER_MS);
    expect(lingering.phase).toBe("delayed");
    expect(lingering.label).toBe("Reconnecting");
    expect(lingering.expanded).toBe(true);
  });

  it("times the whole outage, not the gap since the last failed retry", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "transport-lost", at: T },
      { kind: "transport-lost", at: T + 2_000 },
      { kind: "transport-lost", at: T + 4_000 },
    );
    expect(h.troubleSince).toBe(T);
    expect(readout(h, false, T + SHOW_RECONNECT_LABEL_AFTER_MS).phase).toBe("delayed");
  });

  it("starts a fresh clock for an outage that follows a recovery", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "transport-lost", at: T },
      { kind: "handshake", at: T + 1_000 },
      { kind: "transport-lost", at: T + 8_000 },
    );
    expect(h.troubleSince).toBe(T + 8_000);
  });
});

describe("recovery", () => {
  it("treats a completed handshake as delivery of the stranded edits", () => {
    let h = run(
      { kind: "handshake", at: T },
      { kind: "transport-lost", at: T },
      { kind: "edit-stranded", at: T },
    );
    expect(h.stranded).toBe(true);

    h = advance(h, { kind: "handshake", at: T + 5_000 });
    expect(h.stranded).toBe(false);
    expect(h.troubleSince).toBeNull();
    expect(readout(h, true, T + 5_000).tone).toBe("success");
  });

  it("confirms recovery briefly, then collapses back to a dot", () => {
    let h = advance(outage(), { kind: "handshake", at: T + 4_000 });
    const flash = readout(h, true, T + 4_000);
    expect(flash.phase).toBe("recovered");
    expect(flash.label).toBe("Connected");

    h = advance(h, { kind: "clock", at: T + 4_000 + RECOVERY_FLASH_MS });
    expect(h.flashUntil).toBeNull();
    expect(readout(h, true, T + 9_000).phase).toBe("connected");
  });

  it("does not flash a confirmation on an ordinary first open", () => {
    expect(healthy().flashUntil).toBeNull();
    expect(readout(healthy(), true, T).expanded).toBe(false);
  });

  it("clears stranded edits on receipts, and says so", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "edit-stranded", at: T },
      { kind: "edits-confirmed", at: T + 6_000 },
    );
    expect(h.stranded).toBe(false);
    expect(readout(h, true, T + 6_000).phase).toBe("recovered");
  });

  it("ignores receipts when nothing was outstanding", () => {
    const h = healthy();
    expect(advance(h, { kind: "edits-confirmed", at: T + 1 })).toBe(h);
  });
});

describe("a refused write is not a network problem", () => {
  it("stops waiting for a receipt that will never come, without claiming recovery", () => {
    let h = advance(healthy(), { kind: "edit-stranded", at: T });
    expect(readout(h, true, T).phase).toBe("at-risk");

    h = advance(h, { kind: "write-refused" });
    expect(readout(h, true, T).phase).toBe("connected");
    expect(h.flashUntil).toBeNull();
  });

  it("is a no-op when no edit was outstanding", () => {
    const h = healthy();
    expect(advance(h, { kind: "write-refused" })).toBe(h);
  });
});

describe("pre-handshake edits are not alarming", () => {
  it("ignores a stranded edit before anything has ever synced", () => {
    const h = advance(newLinkHealth(), { kind: "edit-stranded", at: T });
    expect(h.stranded).toBe(false);
    expect(readout(h, false, T).phase).toBe("connecting");
  });

  it("starts the trouble clock itself when no visible loss preceded it", () => {
    expect(advance(healthy(), { kind: "edit-stranded", at: T }).troubleSince).toBe(T);
  });

  it("keeps the original timestamp while the user keeps typing", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "transport-lost", at: T },
      { kind: "edit-stranded", at: T },
      { kind: "edit-stranded", at: T + 3_000 },
    );
    expect(h.troubleSince).toBe(T);
  });
});

describe("wantsTicks", () => {
  it("runs no clock on a settled healthy link", () => {
    expect(wantsTicks(healthy(), true)).toBe(false);
  });

  it("runs while an outage, a stranded edit, or a flash is live", () => {
    expect(wantsTicks(outage(), false)).toBe(true);
    // transportUp=true on purpose: the dead-but-open case is time-driven.
    expect(wantsTicks(advance(healthy(), { kind: "edit-stranded", at: T }), true)).toBe(true);
    expect(wantsTicks(advance(outage(), { kind: "handshake", at: T + 1 }), true)).toBe(true);
  });

  it("stops once access is revoked — nothing can change again", () => {
    expect(wantsTicks(advance(healthy(), { kind: "access-revoked" }), false)).toBe(false);
  });
});

describe("per-document lifecycle", () => {
  it("makes revocation terminal within a document", () => {
    let h = advance(healthy(), { kind: "access-revoked" });
    h = advance(h, { kind: "handshake", at: T + 100 });
    expect(readout(h, true, T + 100).phase).toBe("revoked");
    h = advance(h, { kind: "edits-confirmed", at: T + 200 });
    expect(readout(h, true, T + 200).phase).toBe("revoked");
    expect(readout(newLinkHealth(), true, T + 300).phase).toBe("connecting");
  });

  it("reads a reset model as a quiet first load, not a stale outage", () => {
    const stale = [
      advance(healthy(), { kind: "access-revoked" }),
      advance(outage(), { kind: "edit-stranded", at: T }),
    ];
    for (const prev of stale) {
      expect(readout(prev, true, T + 60_000).phase).not.toBe("connecting");
    }
    const fresh = readout(newLinkHealth(), false, T + 60_000);
    expect(fresh.phase).toBe("connecting");
    expect(fresh.expanded).toBe(false);
  });
});

describe("the durability axis", () => {
  it("refuses to paint green over a server that cannot store", () => {
    const r = readout(undurable(), /* transportUp */ true, T + 1);
    expect(r.phase).toBe("undurable");
    expect(r.tone).toBe("warning");
    expect(r.persistent).toBe(true);
    expect(r.expanded).toBe(true);
  });

  it("escalates on elapsed time alone, with the transport never faltering", () => {
    const h = undurable();
    expect(readout(h, true, T + UNDURABLE_ESCALATION_MS - 1).phase).toBe("undurable");
    const loud = readout(h, true, T + UNDURABLE_ESCALATION_MS);
    expect(loud.phase).toBe("undurable-prolonged");
    expect(loud.tone).toBe("error");
  });

  it("does not restart the escalation clock when the server repeats itself", () => {
    const h = advance(undurable(), { kind: "persist-degraded", at: T + UNDURABLE_ESCALATION_MS });
    expect(readout(h, true, T + UNDURABLE_ESCALATION_MS).phase).toBe("undurable-prolonged");
  });

  it("ranks stranded edits above it — no receipt at all is the worse news", () => {
    const h = advance(undurable(), { kind: "edit-stranded", at: T });
    expect(readout(h, true, T + 1).phase).toBe("at-risk");
  });

  it("outranks a transport outage, because the server is the stronger source", () => {
    const h = advance(undurable(), { kind: "transport-lost", at: T });
    expect(readout(h, false, T + SHOW_RECONNECT_LABEL_AFTER_MS).phase).toBe("undurable");
  });

  it("clears only on the server's word", () => {
    const h = advance(undurable(), { kind: "persist-recovered" });
    expect(readout(h, true, T + 1).phase).toBe("connected");
  });

  it("clears on a handshake, which is how the level is re-asked", () => {
    // The server broadcasts only transitions, so a tab reconnecting after the fix would never hear it.
    const h = advance(undurable(), { kind: "handshake", at: T + 1 });
    expect(readout(h, true, T + 2).phase).not.toBe("undurable");
  });

  it("is re-asserted by the frame the server sends right after that handshake", () => {
    const h = run(
      { kind: "handshake", at: T },
      { kind: "persist-degraded", at: T },
      { kind: "handshake", at: T + 1 },
      { kind: "persist-degraded", at: T + 1 },
    );
    expect(readout(h, true, T + 2).phase).toBe("undurable");
  });

  it("keeps the clock running, since nothing else would make it tick", () => {
    expect(wantsTicks(undurable(), true)).toBe(true);
  });

  it("yields to revocation, which makes the question moot", () => {
    const h = advance(undurable(), { kind: "access-revoked" });
    expect(readout(h, false, T + 1).phase).toBe("revoked");
  });
});

describe("wording never overpromises", () => {
  it("never claims the work is saved, in any reachable phase", () => {
    const forbidden = /saved|persisted|durable|delivered|acknowledged|backed up/i;
    const states: LinkHealth[] = [
      newLinkHealth(),
      healthy(),
      outage(),
      advance(outage(), { kind: "edit-stranded", at: T }),
      advance(advance(outage(), { kind: "edit-stranded", at: T }), { kind: "handshake", at: T + 1 }),
      advance(healthy(), { kind: "access-revoked" }),
      undurable(),
    ];
    const seen = new Set<string>();
    for (const h of states) {
      for (const transportUp of [true, false]) {
        for (const at of [
          T,
          T + SHOW_RECONNECT_LABEL_AFTER_MS,
          T + STRANDED_ESCALATION_MS,
          T + UNDURABLE_ESCALATION_MS,
          T + 120_000,
        ]) {
          const { phase, label, srText } = readout(h, transportUp, at);
          seen.add(phase);
          expect(label ?? "").not.toMatch(forbidden);
          expect(srText).not.toMatch(forbidden);
        }
      }
    }
    // Fails when a phase is added that the sequences above never reach.
    expect(seen.size).toBeGreaterThanOrEqual(9);
  });

  it("says the tab is what keeps retrying, naming no workspace or product", () => {
    const stranded = advance(healthy(), { kind: "edit-stranded", at: T });
    for (const at of [T, T + STRANDED_ESCALATION_MS]) {
      expect(readout(stranded, true, at).srText).toContain("Keep this tab open");
      expect(readout(stranded, true, at).srText).not.toContain("Stuga");
    }
    expect(readout(outage(), false, T + SHOW_RECONNECT_LABEL_AFTER_MS).srText).toBe("Live updates are paused until the connection returns");
  });

  it("always exposes accessible text, even as a bare dot", () => {
    const r = readout(healthy(), true, T);
    expect(r.label).toBeNull();
    expect(r.srText.length).toBeGreaterThan(0);
  });
});
