// @vitest-environment jsdom
/** The run bar with a stubbed overlay: tests dictate what it painted and check the bar follows. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { StugaProvider } from "../sync/stuga-provider";
import { AgentRunsProvider } from "./agent-runs-context";
import { AgentRunBar } from "./AgentRunBar";

const ME = "me-sub";
const T0 = 1_700_000_000_000;

const overlay = vi.hoisted(() => ({
  anchored: [] as string[],
  unanchored: [] as string[],
  scrolled: [] as string[],
}));

vi.mock("../editor/run-preview/use-run-preview", () => ({
  useRunPreview: () => ({
    anchored: overlay.anchored,
    unanchored: overlay.unanchored,
    scrollToHunk: (key: string) => {
      overlay.scrolled.push(key);
      return overlay.anchored.includes(key);
    },
    clearPreview: () => {},
  }),
}));

/** A hunk whose changed span, which a row summarizes, is unique to it. */
function hunk(id: string, over: Partial<AgentRunHunk> = {}): AgentRunHunk {
  return {
    id,
    old_string: `the ${id} section as written`,
    new_string: `the ${id} section rewritten for ${id}`,
    status: "pending",
    review: "review",
    ...over,
  };
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
    hunks: [hunk("h1"), hunk("h2"), hunk("h3")],
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

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <AgentRunsProvider provider={{ runListener: null, doc: null } as unknown as StugaProvider} docId="d1">
        <AgentRunBar />
      </AgentRunsProvider>,
    );
  });
}

/** A control by accessible name: Astryx sets `aria-label` only when it differs from the visible text. */
function byLabel(name: string): HTMLElement {
  const labelled = container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  if (labelled) return labelled;
  const byText = [...container.querySelectorAll<HTMLElement>("button")].find(
    (b) => !b.hasAttribute("aria-label") && b.textContent?.trim() === name,
  );
  if (!byText) throw new Error(`no control named "${name}" — have: ${names().join(" | ")}`);
  return byText;
}

function names(): string[] {
  return [...container.querySelectorAll<HTMLElement>("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "",
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  overlay.anchored = [];
  overlay.unanchored = [];
  overlay.scrolled = [];
  responder = () => ({ runs: [] });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responder(url, method)), {
      status: 200,
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

describe("AgentRunBar", () => {
  it("shows nothing at all when no run is waiting", async () => {
    await mount();
    expect(container.textContent).toBe("");
  });

  it("keeps its whole message on one line: a count plus one muted clause", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    const title = container.querySelector(".agent-run-title")!;
    expect(title.querySelector(".agent-run-title__main")!.textContent).toBe("Claude (Connector) proposes 3 edits");
    expect(title.querySelector(".agent-run-title__hint")!.textContent).toBe("nothing changes until you accept");
    expect(container.textContent).toBe(
      "Claude (Connector) proposes 3 editsnothing changes until you acceptReview eachAccept allReject all",
    );
  });

  it("counts the run's edits and offers a whole-run verdict", async () => {
    responder = (url, method) =>
      method === "POST"
        ? { run: run({ updated_at: T0 + 1, status: "applied", hunks: [] }), applied: 3, conflicts: 0 }
        : { runs: [run()] };
    await mount();
    expect(container.textContent).toContain("Claude (Connector) proposes 3 edits");
    await click(byLabel("Accept all"));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/docs/d1/runs/run_a/decision");
    expect(post.body).toEqual({ decision: "accept", hunk_ids: undefined });
  });

  it("walks the changes in document order, not the order the agent wrote them, wrapping at both ends", async () => {
    overlay.anchored = ["run_a:h2", "run_a:h3", "run_a:h1"];
    responder = () => ({ runs: [run()] });
    await mount();
    expect(container.textContent).toContain("1 of 3");

    await click(byLabel("Next change")); // the first press lands on the first change
    expect(overlay.scrolled).toEqual(["run_a:h2"]);
    expect(container.textContent).toContain("1 of 3");

    await click(byLabel("Next change"));
    await click(byLabel("Next change"));
    expect(container.textContent).toContain("3 of 3");
    await click(byLabel("Next change")); // wraps
    expect(overlay.scrolled).toEqual(["run_a:h2", "run_a:h3", "run_a:h1", "run_a:h2"]);
    expect(container.textContent).toContain("1 of 3");

    await click(byLabel("Previous change")); // wraps the other way
    expect(overlay.scrolled.at(-1)).toBe("run_a:h1");
  });

  it("does not skip the change that takes the place of the one just accepted", async () => {
    overlay.anchored = ["run_a:h1", "run_a:h2", "run_a:h3"];
    const accepted = run({
      updated_at: T0 + 1,
      hunks: [hunk("h1", { status: "accepted" }), hunk("h2"), hunk("h3")],
    });
    responder = (url, method) =>
      method === "POST" ? { run: accepted, applied: 1, conflicts: 0 } : { runs: [run()] };
    await mount();

    await click(byLabel("Next change"));
    expect(overlay.scrolled).toEqual(["run_a:h1"]);

    await click(byLabel("Review each change"));
    await click(byLabel("Accept change 1 of 3")); // the row for h1, where we stand
    expect(container.textContent).toContain("1 of 2"); // the slot now holds h2

    await click(byLabel("Next change"));
    expect(overlay.scrolled).toEqual(["run_a:h1", "run_a:h2"]);
    expect(container.textContent).toContain("1 of 2");

    await click(byLabel("Next change"));
    expect(overlay.scrolled.at(-1)).toBe("run_a:h3");
    expect(container.textContent).toContain("2 of 2");
  });

  it("keeps the cursor on its change when an earlier one is decided from the list", async () => {
    overlay.anchored = ["run_a:h1", "run_a:h2", "run_a:h3"];
    const accepted = run({
      updated_at: T0 + 1,
      hunks: [hunk("h1", { status: "accepted" }), hunk("h2"), hunk("h3")],
    });
    responder = (url, method) =>
      method === "POST" ? { run: accepted, applied: 1, conflicts: 0 } : { runs: [run()] };
    await mount();

    await click(byLabel("Next change"));
    await click(byLabel("Next change")); // parked on h2, "2 of 3"
    expect(overlay.scrolled).toEqual(["run_a:h1", "run_a:h2"]);
    expect(container.textContent).toContain("2 of 3");

    await click(byLabel("Review each change"));
    await click(byLabel("Accept change 1 of 3")); // h1, above the cursor
    expect(container.textContent).toContain("1 of 2"); // still h2, renumbered

    await click(byLabel("Next change"));
    expect(overlay.scrolled.at(-1)).toBe("run_a:h3");
  });

  it("has no navigator when the overlay painted nothing to navigate to", async () => {
    responder = () => ({ runs: [run()] });
    await mount();
    expect(names()).not.toContain("Next change");
  });

  it("lists every hunk with its own verdict, scattered ones included", async () => {
    // h2 and h1 are painted in that document order; h3 has no ghost.
    overlay.anchored = ["run_a:h2", "run_a:h1"];
    overlay.unanchored = ["run_a:h3"];
    responder = (url, method) =>
      method === "POST" ? { run: run({ updated_at: T0 + 1 }), applied: 1, conflicts: 0 } : { runs: [run()] };
    await mount();
    expect(container.textContent).toContain("1 can’t be shown in the document");

    await click(byLabel("Review each change"));
    const rows = [...container.querySelectorAll(".agent-run-change__text")].map((e) => e.textContent);
    expect(rows).toEqual(["rewritten for h2", "rewritten for h1", "rewritten for h3"]);
    expect(container.textContent).toContain("can’t be shown inline — decide it here");

    await click(byLabel("Show change 1 of 3 in the document"));
    expect(overlay.scrolled).toEqual(["run_a:h2"]);

    await click(byLabel("Accept change 1 of 3"));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "accept", hunk_ids: ["h2"] });
  });

  it("offers the list for a truncated run and fills it from the detail fetch", async () => {
    responder = (url) =>
      url.includes("full=1")
        ? { run: run({ hunks: [], hunks_truncated: true }), hunks: [hunk("h1"), hunk("h2")] }
        : { runs: [run({ hunks: [], hunks_truncated: true })] };
    await mount();
    expect(container.textContent).toContain("Claude (Connector) proposes edits");

    await click(byLabel("Review each change"));
    expect(calls.some((c) => c.url === "/api/docs/d1/runs/run_a?full=1")).toBe(true);
    expect(container.querySelectorAll(".agent-run-change")).toHaveLength(2);
    expect(container.textContent).toContain("proposes 2 edits");
  });
});
