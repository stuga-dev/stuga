// @vitest-environment jsdom
/** The document runs provider against a stubbed socket provider, fetch and overlay. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { StugaProvider } from "../sync/stuga-provider";
import { RUN_HUNK_EVENT, type RunHunkDecisionDetail } from "../editor/run-preview/plan";
import { AgentRunsProvider, previewKeyOf, useAgentRuns, type AgentRunsCtx } from "./agent-runs-context";

/** Records what the context hands the overlay and lets a test dictate what it painted. */
const overlay = vi.hoisted(() => ({
  calls: [] as Array<{ hunks: Array<{ runId: string; id: string; agent?: string }>; pendingKeys?: ReadonlySet<string> }>,
  anchored: [] as string[],
  unanchored: [] as string[],
  scrolled: [] as string[],
  last() {
    return this.calls[this.calls.length - 1]!;
  },
}));

vi.mock("../editor/run-preview/use-run-preview", () => ({
  useRunPreview: (
    _editor: unknown,
    _ydoc: unknown,
    hunks: Array<{ runId: string; id: string; agent?: string }>,
    pendingKeys?: ReadonlySet<string>,
  ) => {
    overlay.calls.push({ hunks, pendingKeys });
    return {
      anchored: overlay.anchored,
      unanchored: overlay.unanchored,
      scrollToHunk: (key: string) => {
        overlay.scrolled.push(key);
        return overlay.anchored.includes(key);
      },
      clearPreview: () => {},
    };
  },
}));

const ME = "me-sub";
const T0 = 1_700_000_000_000;

function hunk(id: string, status: AgentRunHunk["status"] = "pending"): AgentRunHunk {
  return { id, old_string: `old ${id}`, new_string: `new ${id}`, status, review: "review" };
}

function run(over: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: "run_a",
    doc_id: "d1",
    source: "connector",
    agent: "Claude (Connector)",
    agent_alias: "agent:claude",
    reviewer: ME,
    status: "open",
    hunks: [hunk("h1"), hunk("h2")],
    acknowledged: false,
    auto_applied: false,
    review_mode: "review",
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

let calls: FetchCall[];
let responder: (url: string, method: string) => unknown;
let container: HTMLDivElement;
let root: Root;
let latest: AgentRunsCtx;
/** The mutable listener slot the real StugaProvider exposes. */
let fakeProvider: { runListener: ((evt: never) => void) | null; doc: null };

function Probe() {
  latest = useAgentRuns();
  return null;
}

async function mount(docId = "d1"): Promise<void> {
  await act(async () => {
    root.render(
      <AgentRunsProvider provider={fakeProvider as unknown as StugaProvider} docId={docId}>
        <Probe />
      </AgentRunsProvider>,
    );
  });
}

/** Push a live frame through the slot the provider registered. */
async function emit(evt: unknown): Promise<void> {
  await act(async () => {
    (fakeProvider.runListener as unknown as (e: unknown) => void)(evt);
  });
}

/** A fetch that hangs until released, to inspect the optimistic state in between. */
function hangingFetch(): (body: unknown, status?: number) => void {
  let release: ((r: Response) => void) | null = null;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Promise<Response>((res) => {
      release = res;
    });
  }) as typeof fetch;
  return (body, status = 200) =>
    release!(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-stuga-user": ME },
      }),
    );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  overlay.calls = [];
  overlay.anchored = [];
  overlay.unanchored = [];
  overlay.scrolled = [];
  responder = () => ({ runs: [] });
  fakeProvider = { runListener: null, doc: null };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responder(url, method)), {
      status: 200,
      // The alias filter reads this header; without it no run is shown.
      headers: { "content-type": "application/json", "x-stuga-user": ME },
    });
  }) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("AgentRunsProvider", () => {
  it("fetches the ledger for the document and exposes only this reviewer's runs", async () => {
    responder = () => ({ runs: [run(), run({ id: "theirs", reviewer: "someone-else" })] });
    await mount();
    expect(calls[0]!.url).toBe("/api/docs/d1/runs?limit=20");
    expect(latest.runs.map((r) => r.id)).toEqual(["run_a"]);
    expect(latest.openRuns.map((r) => r.id)).toEqual(["run_a"]);
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h1", "h2"]);
  });

  it("says so when the ledger cannot be loaded, and stays quiet when the caller has no access to it", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch;
    await mount();
    expect(latest.notices.map((n) => [n.kind, n.message])).toEqual([
      ["error", "Couldn’t load agent changes for this item. Reload to try again."],
    ]);

    act(() => root.unmount());
    root = createRoot(container);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as typeof fetch;
    await mount();
    expect(latest.notices).toEqual([]);
  });

  it("merges a RUN_UPDATED frame into the live view", async () => {
    await mount();
    expect(latest.openRuns).toEqual([]);
    await emit({ type: "updated", payload: { run: run({ updated_at: T0 + 1 }) } });
    expect(latest.openRuns.map((r) => r.id)).toEqual(["run_a"]);
    expect(latest.pending).toHaveLength(2);
  });

  it("clears the bar when a RUN_DECIDED frame settles the run", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    await emit({
      type: "decided",
      payload: {
        run_id: "run_a",
        decision: "accept",
        hunk_ids: ["h1", "h2"],
        decided_by: ME,
        run: run({ updated_at: T0 + 1, status: "applied", hunks: [hunk("h1", "accepted"), hunk("h2", "accepted")] }),
      },
    });
    expect(latest.openRuns).toEqual([]);
    expect(latest.pending).toEqual([]);
  });

  it("surfaces a run that auto-applied while the reviewer was away", async () => {
    responder = () => ({
      runs: [run({ status: "applied", auto_applied: true, hunks: [hunk("h1", "auto_applied")] })],
    });
    await mount();
    expect(latest.unseenApplied.map((r) => r.id)).toEqual(["run_a"]);
    expect(latest.openRuns).toEqual([]);
  });

  it("posts a decision and adopts the run the server returns", async () => {
    responder = (url, method) =>
      method === "POST"
        ? { run: run({ updated_at: T0 + 1, hunks: [hunk("h1", "accepted"), hunk("h2")] }), applied: 1, conflicts: 0 }
        : { runs: [run()] };
    await mount();
    await act(async () => {
      await latest.decide("run_a", "accept", ["h1"]);
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/docs/d1/runs/run_a/decision");
    expect(post.body).toEqual({ decision: "accept", hunk_ids: ["h1"] });
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h2"]);
  });

  it("dismisses the catch-up card immediately and acks it server-side", async () => {
    responder = (url, method) =>
      method === "POST"
        ? { ok: true }
        : { runs: [run({ status: "applied", auto_applied: true, hunks: [hunk("h1", "auto_applied")] })] };
    await mount();
    expect(latest.unseenApplied).toHaveLength(1);
    await act(async () => {
      await latest.ack("run_a");
    });
    expect(latest.unseenApplied).toEqual([]);
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/api/docs/d1/runs/run_a/ack");
  });

  it("propagates a revert conflict so the caller can offer version history", async () => {
    responder = () => ({ runs: [run({ status: "applied", auto_applied: true })] });
    await mount();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "document has changed; use version history to restore" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    let status: number | undefined;
    await act(async () => {
      await latest.revert("run_a").catch((e: { status?: number }) => {
        status = e.status;
      });
    });
    expect(status).toBe(409);
  });

  it("routes an inline per-hunk click to the run the ghost belongs to, since hunk ids repeat across runs", async () => {
    responder = (url, method) =>
      method === "POST" ? { run: run({ updated_at: T0 + 1 }) } : { runs: [run(), run({ id: "run_b", hunks: [hunk("h1")] })] };
    await mount();
    expect(latest.pending.map((p) => `${p.runId}:${p.hunk.id}`)).toEqual(["run_a:h1", "run_a:h2", "run_b:h1"]);

    await act(async () => {
      document.dispatchEvent(
        new CustomEvent<RunHunkDecisionDetail>(RUN_HUNK_EVENT, {
          detail: { runId: "run_a", hunkId: "h1", decision: "accept" },
        }),
      );
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/docs/d1/runs/run_a/decision");
    expect(post.body).toEqual({ decision: "accept", hunk_ids: ["h1"] });
  });

  it("ignores a hunk event for a run/hunk pair it is not showing", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    await act(async () => {
      document.dispatchEvent(
        new CustomEvent<RunHunkDecisionDetail>(RUN_HUNK_EVENT, {
          detail: { runId: "run_gone", hunkId: "h1", decision: "accept" },
        }),
      );
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("detaches its listener on unmount", async () => {
    await mount();
    expect(fakeProvider.runListener).not.toBeNull();
    await act(async () => {
      root.render(<div />);
    });
    expect(fakeProvider.runListener).toBeNull();
  });
});

describe("AgentRunsProvider decisions", () => {
  it("marks the hunk in flight and hands those keys to the overlay, then clears them", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    const settle = hangingFetch();

    let posted!: Promise<void>;
    await act(async () => {
      posted = latest.decide("run_a", "accept", ["h1"]);
    });
    expect([...latest.inFlight]).toEqual(["run_a:h1"]);
    expect([...(overlay.last().pendingKeys ?? [])]).toEqual(["run_a:h1"]);

    await act(async () => {
      settle({ run: run({ updated_at: T0 + 1, hunks: [hunk("h1", "accepted"), hunk("h2")] }), applied: 1, conflicts: 0 });
      await posted;
    });
    expect([...latest.inFlight]).toEqual([]);
  });

  it("takes the hunk off the pending list on click, before the server answers", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    const settle = hangingFetch();

    let posted!: Promise<void>;
    await act(async () => {
      posted = latest.decide("run_a", "accept", ["h1"]);
    });
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h2"]);
    expect(overlay.last().hunks.map((h) => h.id)).toEqual(["h2"]);

    await act(async () => {
      settle({ run: run({ updated_at: T0 + 1, hunks: [hunk("h1", "accepted"), hunk("h2")] }), applied: 1, conflicts: 0 });
      await posted;
    });
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h2"]);
  });

  it("puts the hunk back and says why when the decision fails", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    const settle = hangingFetch();

    let posted!: Promise<void>;
    await act(async () => {
      posted = latest.decide("run_a", "accept", ["h1"]);
    });
    await act(async () => {
      settle({ error: "document is locked" }, 423);
      await posted;
    });

    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h1", "h2"]);
    expect([...latest.inFlight]).toEqual([]);
    expect(latest.notices).toHaveLength(1);
    expect(latest.notices[0]!.kind).toBe("error");
    expect(latest.notices[0]!.message).toContain("document is locked");
  });

  it("surfaces a server-side conflict instead of letting the hunk vanish as accepted", async () => {
    responder = (url, method) =>
      method === "POST"
        ? {
            run: run({ updated_at: T0 + 1, hunks: [hunk("h1", "conflict"), hunk("h2")] }),
            applied: 0,
            conflicts: 1,
          }
        : { runs: [run()] };
    await mount();
    await act(async () => {
      await latest.decide("run_a", "accept", ["h1"]);
    });
    expect(latest.notices.map((n) => n.kind)).toEqual(["conflict"]);
    expect(latest.notices[0]!.message).toContain("no longer matches the document");
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h2"]);
  });

  it("drops a notice once it has been shown", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    await act(async () => {
      await latest.decide("run_a", "reject", ["h1"]);
    });
    const id = latest.notices[0]!.id;
    await act(async () => {
      latest.dismissNotice(id);
    });
    expect(latest.notices).toEqual([]);
  });

  it("ignores a second inline click on a hunk already being decided", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    const settle = hangingFetch();
    let posted!: Promise<void>;
    await act(async () => {
      posted = latest.decide("run_a", "accept", ["h1"]);
    });
    await act(async () => {
      document.dispatchEvent(
        new CustomEvent<RunHunkDecisionDetail>(RUN_HUNK_EVENT, {
          detail: { runId: "run_a", hunkId: "h1", decision: "accept" },
        }),
      );
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    await act(async () => {
      settle({ run: run({ updated_at: T0 + 1, hunks: [hunk("h1", "accepted"), hunk("h2")] }), conflicts: 0 });
      await posted;
    });
  });

  it("offers Undo once an accept closes the run", async () => {
    responder = (url, method) =>
      method === "POST"
        ? {
            run: run({ updated_at: T0 + 1, status: "applied", hunks: [hunk("h1", "accepted"), hunk("h2", "accepted")] }),
            applied: 2,
            conflicts: 0,
          }
        : { runs: [run()] };
    await mount();
    await act(async () => {
      await latest.decide("run_a", "accept");
    });
    const notice = latest.notices.find((n) => n.kind === "accepted");
    expect(notice).toBeDefined();
    expect(notice!.runId).toBe("run_a");
    expect(notice!.message).toContain("Accepted 2 changes from Claude (Connector)");
  });

  it("stays quiet on a partial accept, where the whole-run Undo would discard the unreviewed rest", async () => {
    responder = (url, method) =>
      method === "POST"
        ? {
            run: run({ updated_at: T0 + 1, hunks: [hunk("h1", "accepted"), hunk("h2")] }),
            applied: 1,
            conflicts: 0,
          }
        : { runs: [run()] };
    await mount();
    await act(async () => {
      await latest.decide("run_a", "accept", ["h1"]);
    });
    expect(latest.notices.filter((n) => n.kind === "accepted")).toEqual([]);
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h2"]);
  });

  it("stays quiet when a run closes with nothing actually applied", async () => {
    responder = (url, method) =>
      method === "POST"
        ? {
            run: run({ updated_at: T0 + 1, status: "rejected", hunks: [hunk("h1", "rejected"), hunk("h2", "rejected")] }),
            applied: 0,
            conflicts: 0,
          }
        : { runs: [run()] };
    await mount();
    await act(async () => {
      await latest.decide("run_a", "reject");
    });
    expect(latest.notices.filter((n) => n.kind === "accepted")).toEqual([]);
  });
});

describe("AgentRunsProvider truncated runs", () => {
  const truncated = run({ hunks: [], hunks_truncated: true });

  it("fetches the full hunk list on demand and makes the run itemizable", async () => {
    responder = (url) =>
      url.includes("full=1")
        ? { run: truncated, hunks: [hunk("h1"), hunk("h2"), hunk("h3")] }
        : { runs: [truncated] };
    await mount();
    expect(latest.openRuns.map((r) => r.id)).toEqual(["run_a"]);
    expect(latest.pending).toEqual([]);

    await act(async () => {
      await latest.loadFullHunks("run_a");
    });
    expect(calls.some((c) => c.url === "/api/docs/d1/runs/run_a?full=1")).toBe(true);
    expect(latest.pending.map((p) => p.hunk.id)).toEqual(["h1", "h2", "h3"]);
    expect(latest.openRuns[0]!.hunks_truncated).toBeUndefined();
    expect(overlay.last().hunks.map((h) => h.id)).toEqual(["h1", "h2", "h3"]);
  });

  it("fetches once, and not at all for a run that already carries its hunks", async () => {
    responder = (url) => (url.includes("full=1") ? { run: truncated, hunks: [hunk("h1")] } : { runs: [truncated] });
    await mount();
    await act(async () => {
      await latest.loadFullHunks("run_a");
      await latest.loadFullHunks("run_a");
    });
    expect(calls.filter((c) => c.url.includes("full=1"))).toHaveLength(1);
  });

  it("says so when the run's text can't be read, rather than showing an empty list", async () => {
    // The actor answers 200 with no hunks when a run's stored text is unreadable.
    responder = (url) => (url.includes("full=1") ? { run: truncated, hunks: [] } : { runs: [truncated] });
    await mount();
    await act(async () => {
      await latest.loadFullHunks("run_a");
    });
    expect(latest.notices.map((n) => n.kind)).toEqual(["error"]);
    expect(latest.pending).toEqual([]);
  });
});

describe("previewKeyOf", () => {
  const of = (old_string: string, new_string: string) => [
    { runId: "run_a", agent: "Claude", hunk: { id: "h1", old_string, new_string, status: "pending" as const, review: "review" as const } },
  ];

  it("changes when the text changes, not just its length", () => {
    expect(previewKeyOf(of("colour", "colours"))).not.toBe(previewKeyOf(of("colors", "colorful")));
    expect(previewKeyOf(of("a", "bb"))).not.toBe(previewKeyOf(of("c", "dd")));
  });

  it("is stable for an unchanged pending set", () => {
    expect(previewKeyOf(of("a", "bb"))).toBe(previewKeyOf(of("a", "bb")));
  });

  it("separates identically-named hunks in different runs", () => {
    const a = [{ runId: "run_a", agent: "Claude", hunk: hunk("h1") }];
    const b = [{ runId: "run_b", agent: "Claude", hunk: hunk("h1") }];
    expect(previewKeyOf(a)).not.toBe(previewKeyOf(b));
  });
});

describe("the overlay's payload", () => {
  it("carries the agent name, so two runs' ghosts can be told apart", async () => {
    responder = () => ({ runs: [run(), run({ id: "run_b", agent: "Codex", hunks: [hunk("h1")] })] });
    await mount();
    expect(overlay.last().hunks.map((h) => `${h.agent}:${h.runId}:${h.id}`)).toEqual([
      "Claude (Connector):run_a:h1",
      "Claude (Connector):run_a:h2",
      "Codex:run_b:h1",
    ]);
  });

  it("exposes the overlay's anchored order and scroll call to the navigator", async () => {
    overlay.anchored = ["run_a:h2", "run_a:h1"];
    overlay.unanchored = [];
    responder = () => ({ runs: [run()] });
    await mount();
    expect(latest.preview.anchored).toEqual(["run_a:h2", "run_a:h1"]);
    expect(latest.preview.scrollToHunk("run_a:h2")).toBe(true);
    expect(latest.preview.scrollToHunk("run_a:h9")).toBe(false);
    expect(overlay.scrolled).toEqual(["run_a:h2", "run_a:h9"]);
  });
});
