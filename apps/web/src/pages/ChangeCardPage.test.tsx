// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { ChangeCard, ChangePage } from "../api";
import ChangeCardPage, { outcomeOf, pageBlock } from "./ChangeCardPage";
import { toasts } from "../test/toast";
import { mountInto } from "../test/form-input";

const changes = vi.hoisted(() => ({ get: vi.fn(), decide: vi.fn() }));
const runs = vi.hoisted(() => ({ detail: vi.fn() }));
const dbRuns = vi.hoisted(() => ({ detail: vi.fn() }));
const me = vi.hoisted(() => ({ alias: "sam" }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Changes: changes,
  Runs: runs,
  DatabaseRuns: dbRuns,
}));
vi.mock(import("../lib/http/client"), async (importOriginal) => ({ ...(await importOriginal()), getAlias: () => me.alias }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("../shell/AppTopNav", () => ({ AppTopNav: () => null }));
vi.mock("../state/identity", async (orig) => ({
  ...(await orig<typeof import("../state/identity")>()),
  principalLabel: (p: string) => ({ "user:liv": "Liv", "user:sam": "Sam", "user:cy": "Cy" })[p] ?? p,
  useUserNames: () => 0,
}));

const APPROVER = { level: "colleague" as const, accept: true, reject: true, ack: true };
const ASKER = { level: "colleague" as const, accept: false, reject: true, ack: false, waits_for: "colleague" as const };

function run(docId: string, id: string, newString: string, over: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id,
    doc_id: docId,
    source: "connector",
    agent: "Scout",
    agent_alias: "agent-1",
    reviewer: "liv",
    status: "open",
    hunks: [{ id: "h1", old_string: "", new_string: newString, status: "pending", review: "colleague" }],
    acknowledged: false,
    auto_applied: false,
    review_mode: "colleague",
    change_id: "chg_0123456789ab",
    created_at: Date.parse("2026-10-22T08:00:00.000Z"),
    updated_at: Date.parse("2026-10-22T08:00:00.000Z"),
    you: APPROVER,
    ...over,
  };
}

function page(over: Partial<ChangePage> & Pick<ChangePage, "doc_id" | "title" | "runs">): ChangePage {
  return { doc_kind: "prose", path: ["Customers"], locked: false, level: "colleague", new: false, ...over };
}

const CARD: ChangeCard = {
  change: {
    change_id: "chg_0123456789ab",
    title: "Customer sync, 2026-10-21",
    summary: "Adds Initech as a customer.",
    agent: "Scout",
    agent_alias: "agent-1",
    agent_name: "Scout",
    client: "claude-code",
    model: null,
    asked_by: "liv",
    created_at: "2026-10-22T08:00:00.000Z",
    updated_at: "2026-10-22T08:05:00.000Z",
  },
  pages: [
    page({ doc_id: "d_initech", title: "Initech", new: true, state: "held", runs: [run("d_initech", "run_a", "Initech signed for 30 days.")] }),
    page({
      doc_id: "d_list",
      title: "Customer list",
      runs: [run("d_list", "run_b", "- Initech")],
      deciders: { aliases: ["cy", "sam"], stand_in: false, cause: null, also: { owner: false, admin: false } },
    }),
    page({ doc_id: "d_log", title: "Sync log", path: ["Team notes"], level: "review", runs: [run("d_log", "run_c", "", { review_mode: "review", hunks: [], hunks_withheld: true, hunks_pending: 1, you: { level: "review", accept: false, reject: false, ack: false } })] }),
  ],
};

describe("a change's card", () => {
  let host: HTMLDivElement;
  let root: Root;
  const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);

  async function render() {
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/review/change/chg_0123456789ab"] },
          createElement(Routes, null, createElement(Route, { path: "/review/change/:changeId", element: createElement(ChangeCardPage) })),
        ),
      ),
    );
  }

  beforeEach(() => {
    toasts.shown.length = 0;
    me.alias = "sam";
    changes.get.mockResolvedValue(CARD);
    runs.detail.mockImplementation(async (docId: string, runId: string) => {
      const r = CARD.pages.flatMap((p) => p.runs).find((x) => x.id === runId) as AgentRunSummary;
      return { run: r, baseline_markdown: docId === "d_list" ? "# Customer list\n\n- Acme\n" : "", hunks: r.hunks, citations: [] };
    });
    ({ host, root } = mountInto());
  });

  afterEach(() => vi.clearAllMocks());

  it("leads with the agent's summary, then each page with its level, whether the change made it, and its changes", async () => {
    await render();
    const text = host.textContent!;
    expect(host.querySelector("h1")?.textContent).toBe("Customer sync, 2026-10-21");
    expect(text).toContain("Change to 3 pages");
    expect(text).toContain("Liv’s Scout proposed these changes");
    expect(text.indexOf("Adds Initech as a customer.")).toBeLessThan(text.indexOf("Customer list"));
    // The note dialog stays mounted, with its own heading, after the pages.
    expect([...host.querySelectorAll("h2")].map((h) => h.textContent).slice(0, 3)).toEqual(["Initech", "Customer list", "Sync log"]);
    expect(text).toContain("New page");
    expect(text).toContain("Until it’s approved, only whoever asked and whoever approves it can open this page.");
    expect(text).toContain("You can approve it, and so can Cy.");
    expect(text).toContain("1 change waiting for a decision");
    expect(host.querySelectorAll("ins").length).toBeGreaterThan(0);
    expect(text).toContain("Approve all approves each page you may approve, one by one. The rest keeps waiting.");
    expect(button("Approve all")?.disabled).toBe(false);
  });

  it("approves what the reader may, and says per page what is left and why", async () => {
    changes.decide.mockResolvedValue({
      change_id: "chg_0123456789ab",
      decision: "accept",
      atomic: false,
      pages: [
        { doc_id: "d_initech", title: "Initech", approved: 1, declined: 0, conflicts: 0, left: 0, reasons: [], state: "released" },
        { doc_id: "d_list", title: "Customer list", approved: 1, declined: 0, conflicts: 0, left: 0, reasons: [] },
        { doc_id: "d_log", title: "Sync log", approved: 0, declined: 0, conflicts: 0, left: 1, reasons: ["reviewer"] },
      ],
    });
    await render();
    await act(async () => button("Approve all")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(changes.decide).toHaveBeenCalledExactlyOnceWith("chg_0123456789ab", "accept", undefined);
    const text = document.body.textContent!;
    expect(text).toContain("“Initech”: approved, now in its folder · 1 approved.");
    expect(text).toContain("“Sync log”: 1 left. Whoever asked, the owner or an admin approves it.");
    expect(toasts.shown).toEqual([{ body: "Approved 2 changes, 1 left.", type: "info" }]);
  });

  it("tells whoever asked why they approve none of it, beside a disabled Approve all", async () => {
    me.alias = "liv";
    changes.get.mockResolvedValue({
      ...CARD,
      pages: CARD.pages.slice(0, 2).map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, you: ASKER })) })),
    });
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Customer sync, 2026-10-21");
    expect(host.textContent).toContain("Your Scout proposed these changes");
    expect(document.body.textContent).toContain("You asked for it, so a colleague approves it.");
    expect(button("Approve all")?.disabled).toBe(true);
    expect(button("Decline…")).toBeTruthy();
  });

  it("names the change by who asked when its title is not the reader's to read", async () => {
    changes.get.mockResolvedValue({ ...CARD, change: { ...CARD.change, title: null, summary: null }, pages: [CARD.pages[2]!] });
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Liv’s Scout: changes");
    expect(host.textContent).not.toContain("Adds Initech");
  });

  it("says a change is not found, whatever the reason", async () => {
    changes.get.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    await render();
    expect(host.textContent).toContain("Change not found");
  });
});

describe("pageBlock and outcomeOf", () => {
  it("says why a page's changes are not the reader's to approve", () => {
    const queued = page({ doc_id: "d", title: "Hub", runs: [run("d", "r", "x", { queued_behind: "run_z", you: { ...APPROVER, accept: false, queued: true } })] });
    expect(pageBlock(queued, "sam", "liv")).toBe("queued");
    const own = page({ doc_id: "d", title: "Hub", runs: [run("d", "r", "x", { you: ASKER })] });
    expect(pageBlock(own, "liv", "liv")).toBe("own");
    expect(pageBlock({ ...own, runs: [run("d", "r", "x")] }, "sam", "liv")).toBeNull();
    expect(pageBlock({ ...own, locked: true, runs: [run("d", "r", "x")] }, "sam", "liv")).toBe("locked");
  });

  it("says a page that is left why, after what was decided", () => {
    expect(outcomeOf({ doc_id: "d", title: "Hub", approved: 0, declined: 0, conflicts: 0, left: 2, reasons: ["queued"] })).toBe(
      "“Hub”: 2 left. It waits behind earlier changes to the page.",
    );
    expect(outcomeOf({ doc_id: "d", title: "Initech", approved: 0, declined: 1, conflicts: 0, left: 0, reasons: [], state: "removed" })).toBe(
      "“Initech”: removed · 1 declined.",
    );
  });
});
