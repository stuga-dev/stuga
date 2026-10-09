// @vitest-environment jsdom
/** The run bar with a stubbed overlay: tests dictate what it painted and check the bar follows. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { StugaProvider } from "../sync/stuga-provider";
import { AgentRunsProvider } from "./agent-runs-context";
import { AgentRunBar } from "./AgentRunBar";
import { RUN_HUNK_EVENT } from "../editor/run-preview/plan";
import { mountInto, typeInto } from "../test/form-input";

const ME = "me-sub";
const T0 = 1_700_000_000_000;

const overlay = vi.hoisted(() => ({
  anchored: [] as string[],
  unanchored: [] as string[],
  why: {} as Record<string, string>,
  scrolled: [] as string[],
}));

const coauthor = vi.hoisted(() => ({
  present: false,
  available: true,
  streaming: false,
  revised: [] as string[],
  scopes: [] as Array<{ runId: string; feedbackId: string }>,
}));

vi.mock("../ai/ai-coauthor-context", () => ({
  useOptionalAiCoauthor: () =>
    coauthor.present
      ? {
          available: coauthor.available,
          streaming: coauthor.streaming,
          revise: (note: string, scope: { runId: string; feedbackId: string }) => {
            coauthor.revised.push(note);
            coauthor.scopes.push(scope);
            return true;
          },
        }
      : null,
}));

vi.mock("../editor/run-preview/use-run-preview", () => ({
  useRunPreview: () => ({
    anchored: overlay.anchored,
    unanchored: overlay.unanchored,
    why: overlay.why,
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
  calls = [];
  coauthor.present = false;
  coauthor.streaming = false;
  coauthor.revised = [];
  coauthor.available = true;
  coauthor.scopes = [];
  overlay.anchored = [];
  overlay.unanchored = [];
  overlay.why = {};
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
  ({ host: container, root } = mountInto());
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
    // Reject all's menu stays mounted, closed.
    expect(container.textContent).toBe(
      "Claude (Connector) proposes 3 editsnothing changes until you acceptReview eachAccept allReject allReject all with note…",
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
    expect(rows).toEqual(["as written → rewritten for h2", "as written → rewritten for h1", "as written → rewritten for h3"]);
    // Each row names the line its change sits in.
    expect(container.querySelector(".agent-run-change__context")!.textContent).toBe("the h2 section rewritten for h2");
    expect(container.textContent).toContain("can’t be shown inline — decide it here");

    await click(byLabel("Show change 1 of 3 in the document"));
    expect(overlay.scrolled).toEqual(["run_a:h2"]);

    await click(byLabel("Accept change 1 of 3"));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "accept", hunk_ids: ["h2"] });
  });

  it("says why a change can't be shown, in the banner and on its row", async () => {
    overlay.anchored = ["run_a:h1"];
    overlay.unanchored = ["run_a:h2"];
    overlay.why = { "run_a:h2": "missing" };
    responder = () => ({ runs: [run({ hunks: [hunk("h1"), hunk("h2")] })] });
    await mount();
    expect(container.textContent).toContain("1 can’t be shown in the document (its text is no longer there)");

    await click(byLabel("Review each change"));
    expect(container.textContent).toContain("can’t be shown inline — its text is no longer there");
    expect(byLabel("change 2 of 2 (can’t be shown inline — its text is no longer there)")).toBeTruthy();
  });

  it("leaves the reasons to the rows when the unshown changes differ", async () => {
    overlay.unanchored = ["run_a:h1", "run_a:h2"];
    overlay.why = { "run_a:h1": "missing", "run_a:h2": "chained" };
    responder = () => ({ runs: [run({ hunks: [hunk("h1"), hunk("h2")] })] });
    await mount();
    expect(container.textContent).toContain("2 can’t be shown in the document — see “Review each”");

    await click(byLabel("Review each change"));
    expect(container.textContent).toContain("its text is no longer there");
    expect(container.textContent).toContain("it edits text an earlier change adds; accept that one first");
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

  describe("rejecting with a note", () => {
    const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
    const dialogButton = (text: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text);

    /** Reject all's menu, beside it in one split button. */
    async function fromRejectMenu(item: string): Promise<void> {
      await click(byLabel("More ways to reject"));
      const entry = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.trim() === item);
      if (!entry) throw new Error(`no menu item "${item}"`);
      await click(entry);
    }

    async function noteAll(trigger: string, submit: string, note: string): Promise<void> {
      await fromRejectMenu(trigger);
      await typeInto(dialog()?.querySelector("textarea"), note);
      await click(dialogButton(submit)!);
    }

    function ghostNote(hunkId: string, note: string): Promise<void> {
      return act(async () => {
        document.dispatchEvent(new CustomEvent(RUN_HUNK_EVENT, { detail: { runId: "run_a", hunkId, decision: "request_changes", note } }));
      });
    }

    it("sends the note with the rejection, and closes", async () => {
      responder = (url, method) =>
        method === "POST" ? { run: run({ updated_at: T0 + 1, status: "rejected", hunks: [] }), applied: 0, conflicts: 0 } : { runs: [run()] };
      await mount();
      await noteAll("Reject all with note…", "Reject all with note", "Keep it plain.");
      const post = calls.find((c) => c.method === "POST")!;
      expect(post.url).toBe("/api/docs/d1/runs/run_a/decision");
      expect(post.body).toEqual({ decision: "reject", note: "Keep it plain." });
      expect(dialog()).toBeNull();
      expect(coauthor.revised).toEqual([]);
    });

    it("floats like Edit with AI: no modal, the change quoted, Enter sends, Escape closes", async () => {
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ updated_at: T0 + 1, hunks: [hunk("h1", { status: "rejected" }), hunk("h2"), hunk("h3")] }), applied: 0, conflicts: 0 }
          : { runs: [run()] };
      await mount();
      await click(byLabel("Review each change"));
      const open = () => click(byLabel("Reject with note: change 1 of 3"));
      await open();
      expect(document.body.querySelector("dialog")).toBeNull();
      const composer = document.body.querySelector<HTMLElement>(".ai-edit-composer")!;
      expect(composer.textContent).toContain("as written → rewritten for h1");
      await act(async () => {
        composer.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(dialog()).toBeNull();
      expect(calls.find((c) => c.method === "POST")).toBeUndefined();

      await open();
      // A press elsewhere closes it while the note is empty, and keeps it once something is written.
      await act(async () => {
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      expect(dialog()).toBeNull();
      await open();
      await typeInto(dialog()?.querySelector("textarea"), "Plainer.");
      await act(async () => {
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      expect(dialog()).not.toBeNull();
      await act(async () => {
        dialog()!.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", hunk_ids: ["h1"], note: "Plainer." });
      expect(dialog()).toBeNull();
    });

    it("hands focus back to the menu's button when the whole-run note closes, the menu being gone", async () => {
      responder = () => ({ runs: [run()] });
      await mount();
      await fromRejectMenu("Reject all with note…");
      await act(async () => {
        dialog()!.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(dialog()).toBeNull();
      await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      expect(document.activeElement).toBe(byLabel("More ways to reject"));
    });

    it("leaves an input method's Enter and Escape to it", async () => {
      responder = () => ({ runs: [run()] });
      await mount();
      await fromRejectMenu("Reject all with note…");
      const field = dialog()!.querySelector("textarea")!;
      await typeInto(field, "再短一点");
      await act(async () => {
        // Safari's Enter that picks a candidate comes after compositionend, with the IME's keyCode 229.
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
      });
      expect(calls.find((c) => c.method === "POST")).toBeUndefined();
      expect(dialog()!.querySelector("textarea")!.value).toBe("再短一点");
    });

    it("rejects one change from the list with its own note, under the button's own words", async () => {
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ updated_at: T0 + 1, hunks: [hunk("h1", { status: "rejected" }), hunk("h2"), hunk("h3")] }), applied: 0, conflicts: 0 }
          : { runs: [run()] };
      await mount();
      await click(byLabel("Review each change"));
      await click(byLabel("Reject with note: change 1 of 3"));
      await typeInto(dialog()?.querySelector("textarea"), "Not this one.");
      await click(dialogButton("Reject with note")!);
      expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", hunk_ids: ["h1"], note: "Not this one." });
    });

    it("sends a ghost's note at once, rejecting that one hunk", async () => {
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ updated_at: T0 + 1, hunks: [hunk("h1"), hunk("h2", { status: "rejected" }), hunk("h3")] }), applied: 0, conflicts: 0 }
          : { runs: [run()] };
      await mount();
      await ghostNote("h2", "Plainer.");
      expect(dialog()).toBeNull();
      expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", hunk_ids: ["h2"], note: "Plainer." });
    });

    it("has the co-author revise from a ghost's note on its own run", async () => {
      coauthor.present = true;
      const feedback = { id: "fb_2", note: "Plainer.", decided_by: "u", decided_at: T0 + 1 };
      responder = (url, method) =>
        method === "POST"
          ? {
              run: run({ source: "panel", updated_at: T0 + 1, hunks: [hunk("h1"), hunk("h2", { status: "rejected", feedback }), hunk("h3")] }),
              applied: 0,
              conflicts: 0,
            }
          : { runs: [run({ source: "panel", agent: "AI co-author" })] };
      await mount();
      await ghostNote("h2", "Plainer.");
      expect(coauthor.revised).toEqual(["Plainer."]);
      expect(coauthor.scopes).toEqual([{ runId: "run_a", feedbackId: "fb_2" }]);
    });

    it("has the co-author revise from the note when the run is its own, scoped to what was rejected", async () => {
      coauthor.present = true;
      const feedback = { id: "fb_1", note: "Shorter, please.", decided_by: "u", decided_at: T0 + 1 };
      responder = (url, method) =>
        method === "POST"
          ? {
              run: run({ source: "panel", updated_at: T0 + 1, status: "rejected", hunks: [hunk("h1", { status: "rejected", feedback })] }),
              applied: 0,
              conflicts: 0,
            }
          : { runs: [run({ source: "panel", agent: "AI co-author" })] };
      await mount();
      await fromRejectMenu("Revise all…");
      // The submit label says what happens, so no line under the note repeats it.
      expect(dialog()!.textContent).not.toContain("The agent gets your note");
      await typeInto(dialog()?.querySelector("textarea"), "Shorter, please.");
      await click(dialogButton("Revise all")!);
      expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", note: "Shorter, please." });
      expect(coauthor.revised).toEqual(["Shorter, please."]);
      expect(coauthor.scopes).toEqual([{ runId: "run_a", feedbackId: "fb_1" }]);
    });

    it("leaves an outside agent's change to that agent, never the co-author", async () => {
      coauthor.present = true;
      const feedback = { id: "fb_1", note: "No.", decided_by: "u", decided_at: T0 + 1 };
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ updated_at: T0 + 1, status: "rejected", hunks: [hunk("h1", { status: "rejected", feedback })] }), applied: 0, conflicts: 0 }
          : { runs: [run()] };
      await mount();
      await fromRejectMenu("Reject all with note…");
      expect(dialog()!.textContent).toContain("The agent gets your note the next time it works here.");
      await typeInto(dialog()?.querySelector("textarea"), "No.");
      await click(dialogButton("Reject all with note")!);
      expect(coauthor.revised).toEqual([]);
    });

    it("keeps the co-author's note for its next turn while AI chat is off", async () => {
      coauthor.present = true;
      coauthor.available = false;
      const feedback = { id: "fb_1", note: "No.", decided_by: "u", decided_at: T0 + 1 };
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ source: "panel", updated_at: T0 + 1, status: "rejected", hunks: [hunk("h1", { status: "rejected", feedback })] }), applied: 0, conflicts: 0 }
          : { runs: [run({ source: "panel", agent: "AI co-author" })] };
      await mount();
      await fromRejectMenu("Reject all with note…");
      expect(dialog()!.textContent).toContain("The co-author gets your note on its next turn.");
      await typeInto(dialog()?.querySelector("textarea"), "No.");
      await click(dialogButton("Reject all with note")!);
      expect(coauthor.revised).toEqual([]);
    });

    it("does not revise when the decision rejected nothing", async () => {
      coauthor.present = true;
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ source: "panel", updated_at: T0 + 1, status: "rejected", hunks: [] }), applied: 0, conflicts: 0 }
          : { runs: [run({ source: "panel", agent: "AI co-author" })] };
      await mount();
      await noteAll("Revise all…", "Revise all", "Shorter, please.");
      expect(coauthor.revised).toEqual([]);
    });

    it("still offers Revise while the co-author is mid-turn, handing the note on to wait for it", async () => {
      coauthor.present = true;
      coauthor.streaming = true;
      const feedback = { id: "fb_1", note: "Again.", decided_by: "u", decided_at: T0 + 1 };
      responder = (url, method) =>
        method === "POST"
          ? { run: run({ source: "panel", updated_at: T0 + 1, status: "rejected", hunks: [hunk("h1", { status: "rejected", feedback })] }), applied: 0, conflicts: 0 }
          : { runs: [run({ source: "panel", agent: "AI co-author" })] };
      await mount();
      await fromRejectMenu("Revise all…");
      expect(dialog()!.textContent).toContain("Revises when the current turn ends.");
      await typeInto(dialog()?.querySelector("textarea"), "Again.");
      await click(dialogButton("Revise all")!);
      expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject", note: "Again." });
      // The co-author queues it behind the turn in flight.
      expect(coauthor.revised).toEqual(["Again."]);
    });
  });
});
