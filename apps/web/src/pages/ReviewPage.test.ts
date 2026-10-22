// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { InboxRun } from "../api";
import { ReviewPage, madeBy, needsAttention, runActions, runStatus, tabOf } from "./ReviewPage";
import { toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

const inbox = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn() }));
const docRuns = vi.hoisted(() => ({ decide: vi.fn(), revert: vi.fn(), ack: vi.fn(), detail: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Inbox: inbox,
  Runs: docRuns,
}));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("../shell/AppTopNav", () => ({ AppTopNav: () => null }));
// The row menu stands in as its items' buttons.
vi.mock("@astryxdesign/core/MoreMenu", async () => {
  const { createElement: h } = await import("react");
  return {
    MoreMenu: ({ items }: { items: Array<{ label: string; onClick: () => void }> }) =>
      items.map((item) => h("button", { key: item.label, onClick: item.onClick }, item.label)),
  };
});

/** A run as an agent's first proposal opens it; each case moves it the way an actor does. */
const run = (overrides: Partial<InboxRun> = {}) => ({
  source: "connector",
  agent: "Research bot",
  agent_alias: "agent-research",
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
    expect(runStatus(run({ status: "applied", accepted: 1, conflicts: 2 }))).toBe("1 approved · 2 couldn’t be applied");
    // A database marks a run auto-applied only when something landed.
    expect(runStatus(run({ conflicts: 1 }))).toBe("1 couldn’t be applied");
  });

  it("summarizes decided runs in plain language", () => {
    expect(runStatus(decided)).toBe("2 approved · 1 declined");
    expect(runStatus(allSkipped)).toBe("3 declined");
  });

  it("names who decides a run the reader cannot", () => {
    expect(runStatus(run({ pending: 1, reviewer: "liv", can_decide: false }))).toBe("1 change waiting for liv");
  });

  it("says a run at colleague waits for a colleague, or for one to be given edit access", () => {
    const waits = (waits_for: "colleague" | "nobody" | "group") =>
      run({ pending: 2, reviewer: "liv", can_decide: true, you: { level: "colleague", accept: false, reject: true, ack: false, waits_for } });
    expect(runStatus(waits("colleague"))).toBe("2 changes waiting for a colleague’s approval");
    expect(runStatus(waits("nobody"))).toBe("2 changes waiting: give a colleague edit access to approve them");
    expect(runStatus(waits("group"))).toBe("2 changes waiting: give someone in the approver group edit access to approve them");
    // Someone outside the approver group reads whom it waits for, never its asker's name.
    expect(runStatus(run({ pending: 1, reviewer: "liv", can_decide: false, you: { level: "colleague", accept: false, reject: false, ack: false } }))).toBe(
      "1 change waiting for a colleague’s approval",
    );
    expect(runStatus(run({ pending: 1, reviewer: "liv", can_decide: true, you: { level: "colleague", accept: true, reject: true, ack: true } }))).toBe(
      "1 change waiting for your decision",
    );
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

  it("lets whoever asked the AI take back a run at colleague, and leaves marking it reviewed to someone else", () => {
    const asked = { level: "colleague" as const, accept: false, reject: true, ack: false, waits_for: "colleague" as const };
    expect(runActions({ ...parked, you: asked })).toEqual({ decide: true, revert: false, dismiss: false });
    expect(runActions({ ...autoSession, you: asked })).toEqual({ decide: false, revert: true, dismiss: false });
    // Applied at once before its folder was raised: still theirs to mark reviewed.
    expect(runActions({ ...autoSession, you: { ...asked, ack: true } })).toEqual({ decide: false, revert: true, dismiss: true });
  });

  it("offers nothing on a run someone else decides", () => {
    expect(runActions({ ...parked, can_decide: false })).toEqual({ decide: false, revert: false, dismiss: false });
    expect(runActions({ ...autoSession, can_decide: false })).toEqual({ decide: false, revert: false, dismiss: false });
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
    expect(madeBy(run({ source: "panel", agent: "stored", agent_alias: "panel:u_ada", agent_name: "stored" }))).toEqual(["AI co-author"]);
  });

  it("names the sample agent from the catalog", () => {
    expect(madeBy(run({ agent: "stored", agent_alias: "agent-sample", agent_name: "stored" }))).toEqual(["Sample agent"]);
  });

  it("adds the app it came through, by its name, only when the agent's name does not already say it", () => {
    expect(madeBy(run({ client: "claude-desktop" }))).toEqual(["Research bot", "Claude Desktop"]);
    expect(madeBy(run({ agent_name: "Claude", client: "claude-code" }))).toEqual(["Claude", "Claude Code"]);
    expect(madeBy(run({ agent_name: "Claude Desktop", client: "claude-desktop" }))).toEqual(["Claude Desktop"]);
    expect(madeBy(run({ client: "my-script" }))).toEqual(["Research bot", "my-script"]);
    expect(madeBy(run())).toEqual(["Research bot"]);
  });
});

/** What the node answers a decision on the inbox's run with. */
const RUN_REPLY = {
  id: "run_1", doc_id: "d_1", source: "connector", agent: "Research bot", agent_alias: "agent-1", reviewer: "liv",
  status: "rejected", acknowledged: false, auto_applied: false, review_mode: "review",
  created_at: 0, updated_at: Date.parse("2026-09-02T00:00:00.000Z"), hunks: [],
};

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
    docRuns.detail.mockResolvedValue({ run: { hunks: [] } });
    ({ host, root } = mountInto());
  });

  afterEach(() => {
    window.matchMedia = wideScreen;
  });

  it("leaves the page's name to the top bar, which shows it on a wide screen", async () => {
    await render(false);
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe("1 item needs review");
  });

  it("leaves naming the page to the top bar, which keeps its title on a phone", async () => {
    await render(true);
    expect(host.querySelectorAll("h1")).toHaveLength(0);
  });

  it("previews what a waiting run would change, and offers no blind Accept all", async () => {
    docRuns.detail.mockResolvedValue({
      run: {
        hunks: [
          { id: "h1", old_string: "We open at 7.", new_string: "We open at 6.", status: "pending" },
          { id: "h2", old_string: "", new_string: "Closed on Sundays.", status: "pending" },
          { id: "h3", old_string: "a", new_string: "b", status: "accepted" },
        ],
      },
    });
    await render(false);
    expect(host.textContent).toContain("7. → 6. · and 1 more change");
    expect(host.textContent).not.toContain("Accept all");
    expect(host.textContent).toContain("Ask for changes…");
    expect(host.textContent).toContain("Decline");
  });

  describe("a waiting run's menu, in the review card's words", () => {
    const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label)!;
    const click = (label: string) => act(async () => button(label).dispatchEvent(new MouseEvent("click", { bubbles: true })));

    beforeEach(() => {
      toasts.shown.length = 0;
      const reply = { ...RUN_REPLY, hunks: [{ id: "h1", old_string: "a", new_string: "b", status: "rejected", review: "review" }] } as AgentRunSummary;
      docRuns.decide.mockResolvedValue({ run: reply, applied: 0, conflicts: 0, blocked: 0 });
    });

    it("declines the whole run", async () => {
      await render(false);
      await click("Decline");
      expect(docRuns.decide).toHaveBeenLastCalledWith("d_1", "run_1", "reject", undefined, undefined);
      expect(toasts.shown.at(-1)).toEqual({ body: "Declined the changes in “Q3 plan”.", type: "info" });
    });

    it("asks for changes with the note the agent revises from", async () => {
      await render(false);
      await click("Ask for changes…");
      await typeInto(document.body.querySelector("dialog[open] textarea"), "Say which quarter.");
      await click("Ask for changes");
      expect(docRuns.decide).toHaveBeenLastCalledWith("d_1", "run_1", "reject", undefined, "Say which quarter.");
      expect(toasts.shown.at(-1)).toEqual({ body: "Asked for changes in “Q3 plan”.", type: "info" });
    });
  });

  it("keeps each fact under a row whole, so a narrow row breaks only between them, after a separator", async () => {
    await render(true);
    const facts = [...host.querySelectorAll(".review-row-fact")].map((f) => f.textContent);
    expect(facts).toEqual(["Document\u00A0·", "Research bot\u00A0·", expect.any(String)]);
    expect(host.querySelector(".review-row-fact time")?.getAttribute("dateTime")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("gives the status dot a short label, since the status line beside it is read out too", async () => {
    await render(false);
    expect(host.querySelector('li [role="img"]')?.getAttribute("aria-label")).toBe("Needs review");
    expect(host.textContent).toContain("2 changes waiting for your decision");
  });
});

describe("the tabs", () => {
  it("name the inbox views as the address does, Needs you by default", () => {
    expect(tabOf(null).filter).toBe("attention");
    expect(tabOf("waiting").filter).toBe("waiting");
    expect(tabOf("done").filter).toBe("done");
    expect(tabOf("everything").filter).toBe("attention");
  });

  it("list Needs you, Waiting on others and Done, each from its own view, and a row opens its review card", async () => {
    const { host, root } = mountInto();
    const row = run({ ...parked, run_id: "run_1", doc_id: "d_1", doc_kind: "prose", doc_title: "Q3 plan", updated_at: "2026-09-01T00:00:00.000Z" });
    inbox.list.mockImplementation(async (filter: string) => ({ runs: filter === "attention" ? [row, row] : [], filter }));
    inbox.stats.mockResolvedValue({ agents: [] });
    docRuns.detail.mockResolvedValue({ run: { hunks: [] } });
    let path = "";
    const Where = () => {
      path = useLocation().pathname + useLocation().search;
      return null;
    };
    await act(async () =>
      root.render(createElement(MemoryRouter, { initialEntries: ["/review?tab=waiting"] }, createElement(ReviewPage), createElement(Where))),
    );
    expect(inbox.list).toHaveBeenCalledWith("waiting", undefined);
    // Needs you keeps its count whichever tab is open.
    const tab = (label: string) => [...host.querySelectorAll("a, button")].find((el) => el.textContent?.startsWith(label));
    expect(tab("Needs you")?.textContent).toMatch(/2$/);
    expect(tab("Waiting on others")).toBeTruthy();
    expect(tab("Done")).toBeTruthy();
    expect(host.textContent).toContain("Nothing waiting on others");

    const needs = tab("Needs you")!;
    await act(async () => needs.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(inbox.list).toHaveBeenLastCalledWith("attention", undefined);
    const review = [...host.querySelectorAll("button")].find((b) => b.textContent === "Review changes")!;
    await act(async () => review.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(path).toBe("/review/d_1/run_1");
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
    ({ host, root } = mountInto());
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(ReviewPage))));
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
