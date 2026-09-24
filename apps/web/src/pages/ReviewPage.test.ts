// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { InboxRun } from "../api";
import { ReviewPage, madeBy, needsAttention, runActions, runStatus } from "./ReviewPage";

const inbox = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn() }));
const docRuns = vi.hoisted(() => ({ decide: vi.fn(), revert: vi.fn(), ack: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Inbox: inbox,
  Runs: docRuns,
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));
vi.mock("../shell/AppTopNav", () => ({ AppTopNav: () => null }));
// The row menu stands in as its items' buttons.
vi.mock("@astryxdesign/core/MoreMenu", async () => {
  const { createElement: h } = await import("react");
  return {
    MoreMenu: ({ items }: { items: Array<{ label: string; onClick: () => void }> }) =>
      items.map((item) => h("button", { key: item.label, onClick: item.onClick }, item.label)),
  };
});

// jsdom's <dialog> has no showModal/close, which Astryx Dialog calls.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

/** A run as an agent's first proposal opens it; each case moves it the way an actor does. */
const run = (overrides: Partial<InboxRun> = {}) => ({
  source: "connector",
  agent: "Research bot",
  agent_name: "Research bot",
  client: null,
  status: "open",
  pending: 0,
  accepted: 0,
  rejected: 0,
  conflicts: 0,
  applied: 0,
  auto_applied: false,
  acknowledged: false,
  reverted: false,
  ...overrides,
}) as InboxRun;

const parked = run({ pending: 2 });
// Accepting all can leave a hunk pending behind one it quotes, so a run can be part decided.
const partlyDecided = run({ pending: 1, accepted: 2 });
// An `auto` session stays open after each proposal, and after it is acknowledged.
const autoSession = run({ auto_applied: true, applied: 2 });
const autoChecked = run({ auto_applied: true, applied: 2, acknowledged: true });
// The agent's next proposal after a quiet spell closes the session.
const autoRolledOver = run({ status: "applied", auto_applied: true, applied: 2 });
const decided = run({ status: "applied", accepted: 2, rejected: 1 });
const allSkipped = run({ status: "rejected", rejected: 3 });
// A revert marks the run expired and acknowledged, keeps the landed counts and skips what was pending.
const reverted = run({ status: "expired", reverted: true, acknowledged: true, accepted: 2, rejected: 1 });
const revertedAuto = run({ status: "expired", reverted: true, acknowledged: true, auto_applied: true, applied: 2 });

describe("review inbox status", () => {
  it("leads with the decision still needed", () => {
    expect(runStatus(run({ pending: 1 }))).toBe("1 change waiting for your decision");
    expect(runStatus(parked)).toBe("2 changes waiting for your decision");
    expect(runStatus(partlyDecided)).toBe("1 change waiting for your decision");
  });

  it("asks for a check of automatic changes until they are acknowledged", () => {
    expect(runStatus(autoSession)).toBe("2 applied automatically · Check the result");
    expect(runStatus(autoRolledOver)).toBe("2 applied automatically · Check the result");
    expect(runStatus(autoChecked)).toBe("2 applied automatically");
  });

  it("counts changes that could not be applied next to the rest", () => {
    expect(runStatus(run({ auto_applied: true, applied: 2, conflicts: 1 }))).toBe(
      "2 applied automatically · 1 couldn’t be applied · Check the result",
    );
    expect(runStatus(run({ status: "applied", accepted: 1, conflicts: 2 }))).toBe("1 kept · 2 couldn’t be applied");
    // A database marks a run auto-applied only when something landed.
    expect(runStatus(run({ conflicts: 1 }))).toBe("1 couldn’t be applied");
  });

  it("summarizes decided runs in plain language", () => {
    expect(runStatus(decided)).toBe("2 kept · 1 skipped");
    expect(runStatus(allSkipped)).toBe("3 skipped");
  });

  it("reads a reverted run as reverted", () => {
    expect(runStatus(reverted)).toBe("Changes reverted");
    expect(runStatus(revertedAuto)).toBe("Changes reverted");
  });
});

describe("review inbox actions", () => {
  it("lists what waits for a decision or an unchecked automatic change", () => {
    expect([parked, partlyDecided, autoSession, autoRolledOver].map(needsAttention)).toEqual([true, true, true, true]);
    expect([autoChecked, decided, allSkipped, reverted, revertedAuto].map(needsAttention)).toEqual([false, false, false, false, false]);
  });

  it("offers a decision only while changes wait", () => {
    expect(runActions(parked)).toEqual({ decide: true, revert: false, dismiss: false });
    expect(runActions(partlyDecided)).toEqual({ decide: true, revert: true, dismiss: false });
  });

  it("offers mark as reviewed only on unchecked automatic changes", () => {
    expect(runActions(autoSession)).toEqual({ decide: false, revert: true, dismiss: true });
    expect(runActions(autoRolledOver)).toEqual({ decide: false, revert: true, dismiss: true });
    expect(runActions(autoChecked)).toEqual({ decide: false, revert: true, dismiss: false });
  });

  it("offers revert only while something landed and the run was not reverted", () => {
    expect(runActions(decided).revert).toBe(true);
    expect(runActions(allSkipped).revert).toBe(false);
    expect(runActions(reverted)).toEqual({ decide: false, revert: false, dismiss: false });
    expect(runActions(revertedAuto)).toEqual({ decide: false, revert: false, dismiss: false });
  });
});

describe("who made a run", () => {
  it("names the co-author once", () => {
    expect(madeBy(run({ source: "panel", agent: "AI co-author", agent_name: "AI co-author" }))).toBe("AI co-author");
  });

  it("adds the client label only when the agent's name does not already say it", () => {
    expect(madeBy(run({ client: "claude-desktop" }))).toBe("Research bot · claude-desktop");
    expect(madeBy(run({ agent_name: "Claude Desktop", client: "claude-desktop" }))).toBe("Claude Desktop");
    expect(madeBy(run())).toBe("Research bot");
  });
});

describe("the inbox page", () => {
  let host: HTMLDivElement;
  let root: Root;
  const wideScreen = window.matchMedia;
  const row = run({ ...parked, run_id: "run_1", doc_id: "d_1", doc_kind: "prose", doc_title: "Q3 plan", updated_at: "2026-09-01T00:00:00.000Z" });

  /** Renders the page in a window below AppShell's breakpoint, or above it. */
  async function render(phone: boolean) {
    window.matchMedia = ((query: string) => ({ ...wideScreen(query), matches: phone && query.startsWith("(width <") })) as typeof window.matchMedia;
    inbox.list.mockResolvedValue({ runs: [row], filter: "attention" });
    inbox.stats.mockResolvedValue({ agents: [] });
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(ReviewPage))));
  }

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.matchMedia = wideScreen;
  });

  it("leaves the page's name to the top bar, which shows it on a wide screen", async () => {
    await render(false);
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe("1 item needs review");
  });

  it("names the page itself on a phone, where the top bar's title sits in the menu", async () => {
    await render(true);
    expect([...host.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Review AI edits"]);
  });

  it("gives the status dot a short label, since the status line beside it is read out too", async () => {
    await render(false);
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Needs review");
    expect(host.textContent).toContain("2 changes waiting for your decision");
  });
});

describe("the revert dialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  const row = run({ ...autoSession, run_id: "run_1", doc_id: "d_1", doc_kind: "prose", doc_title: "Q3 plan", updated_at: "2026-09-01T00:00:00.000Z" });
  const dialog = () => document.body.querySelector("dialog")!;
  const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);

  async function click(label: string) {
    const el = button(label);
    expect(el, `no button ${label}`).toBeTruthy();
    await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  beforeEach(async () => {
    toasts.shown.length = 0;
    inbox.list.mockResolvedValue({ runs: [row], filter: "attention" });
    inbox.stats.mockResolvedValue({ agents: [] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(ReviewPage))));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("cannot be closed while its revert is in flight, and keeps naming the document as it closes", async () => {
    let finish: (value: { run: AgentRunSummary; reverted: number }) => void = () => {};
    docRuns.revert.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await click("Revert these changes");
    expect(dialog().open).toBe(true);
    await click("Revert changes");
    await click("Cancel");
    // Escape reaches an Astryx dialog as the native cancel event.
    await act(async () => dialog().dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(dialog().open).toBe(true);

    const reply = {
      id: "run_1", doc_id: "d_1", source: "connector", agent: "Research bot", agent_alias: "agent-1", reviewer: "liv",
      status: "expired", reverted: true, acknowledged: true, auto_applied: true, review_mode: "auto",
      created_at: 0, updated_at: Date.parse("2026-09-02T00:00:00.000Z"),
      hunks: [
        { id: "h1", old_string: "a", new_string: "b", status: "auto_applied", review: "auto" },
        { id: "h2", old_string: "c", new_string: "d", status: "auto_applied", review: "auto" },
      ],
    } as AgentRunSummary;
    await act(async () => finish({ run: reply, reverted: 2 }));
    expect(dialog().open).toBe(false);
    expect(dialog().textContent).toContain("“Q3 plan”");
    expect(toasts.shown).toEqual([{ body: "Reverted the changes in “Q3 plan”.", type: "info" }]);
    // Reverted is not something to review, so the row leaves the list.
    expect(host.textContent).toContain("All caught up");
  });
});
