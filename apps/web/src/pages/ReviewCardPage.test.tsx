// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { RunDeciders } from "../api";
import ReviewCardPage, { decidersLine } from "./ReviewCardPage";
import { toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

const docs = vi.hoisted(() => ({ get: vi.fn() }));
const folders = vi.hoisted(() => ({ ancestors: vi.fn() }));
const runs = vi.hoisted(() => ({ detail: vi.fn(), decide: vi.fn(), ack: vi.fn() }));
const dbRuns = vi.hoisted(() => ({ detail: vi.fn(), decide: vi.fn(), ack: vi.fn() }));
const me = vi.hoisted(() => ({ alias: "sam" }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Folders: folders,
  Runs: runs,
  DatabaseRuns: dbRuns,
}));
vi.mock(import("../lib/http/client"), async (importOriginal) => ({ ...(await importOriginal()), getAlias: () => me.alias }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("../shell/AppTopNav", () => ({ AppTopNav: () => null }));
vi.mock("../state/identity", async (orig) => ({
  ...(await orig<typeof import("../state/identity")>()),
  principalLabel: (p: string) => ({ "user:liv": "Liv", "user:sam": "Sam", "user:ana": "Ana" })[p] ?? p,
  useUserNames: () => 0,
}));

const DOC = {
  doc_id: "d_leave",
  title: "Leave policy",
  doc_type: "prose",
  parent_id: "f_hr",
  locked: false,
  agent_mode: "colleague",
};

const RUN: AgentRunSummary = {
  id: "run_1",
  doc_id: "d_leave",
  source: "connector",
  agent: "Scout",
  agent_alias: "agent-1",
  client: "claude-code",
  reviewer: "liv",
  status: "open",
  hunks: [{ id: "h1", old_string: "Ten days", new_string: "Twelve days[^1]", status: "pending", review: "colleague" }],
  acknowledged: false,
  auto_applied: false,
  review_mode: "colleague",
  created_at: Date.parse("2026-10-22T08:00:00.000Z"),
  updated_at: Date.parse("2026-10-22T08:00:00.000Z"),
};

const BASELINE = "# Leave policy\n\n## Annual leave\n\nTen days a year.\n";

function detail(over: { you: AgentRunSummary["you"]; deciders?: RunDeciders; withheld?: boolean }) {
  const run = { ...RUN, you: over.you, ...(over.withheld ? { hunks: [], hunks_withheld: true as const, hunks_pending: 1 } : {}) };
  return over.withheld
    ? { run, hunks: [] }
    : {
        run,
        baseline_markdown: BASELINE,
        final_markdown: null,
        hunks: run.hunks,
        citations: [{ n: 1, doc_id: "d_hr", title: "HR handbook", heading_path: null, content: "Twelve days from 2027." }],
        deciders: over.deciders,
      };
}

const NONE = { owner: false, admin: false };
const APPROVER = { level: "colleague" as const, accept: true, reject: true, ack: true };
const ASKER = { level: "colleague" as const, accept: false, reject: true, ack: false, waits_for: "colleague" as const };
const READER = { level: "colleague" as const, accept: false, reject: false, ack: false };

describe("the review card", () => {
  let host: HTMLDivElement;
  let root: Root;
  const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);
  const click = async (label: string) => {
    const el = button(label);
    expect(el, `no button ${label}`).toBeTruthy();
    await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };

  async function render() {
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/review/d_leave/run_1"] },
          createElement(Routes, null, createElement(Route, { path: "/review/:docId/:runId", element: createElement(ReviewCardPage) })),
        ),
      ),
    );
  }

  beforeEach(() => {
    toasts.shown.length = 0;
    me.alias = "sam";
    docs.get.mockResolvedValue(DOC);
    folders.ancestors.mockResolvedValue({ ancestors: [{ folder_id: "f_hr", title: "HR" }] });
    ({ host, root } = mountInto());
  });

  afterEach(() => vi.clearAllMocks());

  it("shows who asked, through which AI, the level, who may approve, and the change in its section with its sources", async () => {
    runs.detail.mockResolvedValue(detail({ you: APPROVER, deciders: { aliases: ["ana", "sam"], stand_in: false, cause: null, also: NONE } }));
    await render();
    expect(runs.detail).toHaveBeenCalledWith("d_leave", "run_1", { full: true });
    const text = host.textContent!;
    expect(text).toContain("HR › Leave policy");
    expect(host.querySelector("h1")?.textContent).toBe("Liv’s Scout proposed 1 change");
    expect(text).toContain("Through Claude Code");
    expect(text).toContain("Reviewed by a colleague");
    expect(text).toContain("You can approve it, and so can Ana.");
    expect(text).toContain("In “Annual leave”");
    expect(host.querySelector("del")?.textContent).toContain("Ten days a year.");
    expect(host.querySelector("ins")?.textContent).toContain("Twelve days");
    expect(text).toContain("HR handbook");
    expect(text).toContain("Twelve days from 2027.");
    expect(button("Approve")?.disabled).toBe(false);
  });

  it("approves every waiting change at once", async () => {
    runs.detail.mockResolvedValue(detail({ you: APPROVER }));
    runs.decide.mockResolvedValue({ run: RUN, applied: 1, conflicts: 0, blocked: 0 });
    await render();
    await click("Approve");
    expect(runs.decide).toHaveBeenCalledExactlyOnceWith("d_leave", "run_1", "accept", undefined, undefined);
    expect(toasts.shown).toEqual([{ body: "Approved 1 change.", type: "info" }]);
  });

  it("asks for changes only with a note, which goes to the agent with the rejection", async () => {
    runs.detail.mockResolvedValue(detail({ you: APPROVER }));
    runs.decide.mockResolvedValue({ run: RUN, applied: 0, conflicts: 0, blocked: 0 });
    await render();
    await click("Ask for changes…");
    const send = () => [...document.body.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Ask for changes") as HTMLButtonElement;
    await act(async () => send().click());
    expect(runs.decide).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Say what should change.");
    await typeInto(document.body.querySelector("dialog[open] textarea"), "Twelve days starts next year; say so.");
    await act(async () => send().click());
    expect(runs.decide).toHaveBeenCalledExactlyOnceWith("d_leave", "run_1", "reject", undefined, "Twelve days starts next year; say so.");
    expect(toasts.shown.at(-1)).toEqual({ body: "Sent back with your note.", type: "info" });
  });

  it("declines with no note needed", async () => {
    runs.detail.mockResolvedValue(detail({ you: APPROVER }));
    runs.decide.mockResolvedValue({ run: RUN, applied: 0, conflicts: 0, blocked: 0 });
    await render();
    await click("Decline…");
    const send = [...document.body.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Decline") as HTMLButtonElement;
    await act(async () => send.click());
    expect(runs.decide).toHaveBeenCalledExactlyOnceWith("d_leave", "run_1", "reject", undefined, undefined);
  });

  it("tells whoever asked why a colleague approves it, and lets them take it back", async () => {
    me.alias = "liv";
    runs.detail.mockResolvedValue(detail({ you: ASKER, deciders: { aliases: ["ana", "sam"], stand_in: false, cause: null, also: NONE } }));
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Your Scout proposed 1 change");
    expect(host.textContent).toContain("You asked for this change, so a colleague approves it.");
    expect(host.textContent).toContain("Ana or Sam can approve it.");
    expect(button("Approve")?.disabled).toBe(true);
    expect(button("Decline…")).toBeTruthy();
  });

  it("keeps its decisions in the layout's footer beside the scrolling content, so the content scrolls clear of it however tall it grows", async () => {
    me.alias = "liv";
    runs.detail.mockResolvedValue(detail({ you: ASKER, deciders: { aliases: ["sam"], stand_in: false, cause: null, also: NONE } }));
    await render();
    const scroller = button("Open the document")!.closest(".astryx-layout-content")!;
    const footer = host.querySelector('[aria-label="Decide this change"]')!;
    expect(footer.textContent).toContain("You asked for this change, so a colleague approves it.");
    expect(footer.contains(button("Approve")!)).toBe(true);
    expect(scroller.contains(footer)).toBe(false);
    expect(scroller.closest(".astryx-layout")).not.toBeNull();
    expect(footer.closest(".astryx-layout")).toBe(scroller.closest(".astryx-layout"));
  });

  it("says what became of each change in the words of its buttons", async () => {
    const hunks = [
      { id: "h1", old_string: "Ten days", new_string: "Twelve days", status: "accepted" as const, review: "colleague" as const },
      { id: "h2", old_string: "a year", new_string: "each year", status: "rejected" as const, review: "colleague" as const },
    ];
    runs.detail.mockResolvedValue({ ...detail({ you: APPROVER }), run: { ...RUN, status: "applied", you: APPROVER, hunks }, hunks });
    await render();
    expect(host.textContent).toContain("Decided");
    expect(host.textContent).toContain("1 approved · 1 declined");
    expect(host.textContent).toContain("Approved");
    expect(host.textContent).toContain("Declined");
    expect(host.textContent).not.toMatch(/accepted|rejected/i);
  });

  it("below colleague, names whoever asked, the item's owner and an admin as those who may approve", async () => {
    const you = { level: "review" as const, accept: true, reject: true, ack: true };
    runs.detail.mockResolvedValue(detail({ you, deciders: { aliases: ["liv"], stand_in: false, cause: null, also: { owner: true, admin: true } } }));
    await render();
    expect(host.textContent).toContain("Liv, the document’s owner or an admin can approve it.");
  });

  it("below colleague, tells anyone else who may approve it, without its text", async () => {
    runs.detail.mockResolvedValue(detail({ you: { level: "review", accept: false, reject: false, ack: false }, withheld: true }));
    await render();
    expect(host.textContent).toContain("Only Liv, the document’s owner or an admin can approve it.");
    expect(host.textContent).not.toContain("Twelve days");
  });

  it("says nothing waits once a run that someone else reads is decided", async () => {
    runs.detail.mockResolvedValue({ run: { ...RUN, status: "open", you: READER, hunks: [], hunks_withheld: true, hunks_pending: 0 }, hunks: [] });
    await render();
    expect(host.textContent).toContain("Decided");
    expect(button("Approve")).toBeUndefined();
  });

  it("shows anyone else who reads it that it waits, and why they may not decide, without its text", async () => {
    runs.detail.mockResolvedValue(detail({ you: READER, withheld: true }));
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Liv’s Scout proposed 1 change");
    expect(host.textContent).toContain("Whoever asked and whoever approves see the change before it lands.");
    expect(host.textContent).toContain("Liv asked for this change, so a colleague approves it.");
    expect(host.textContent).not.toContain("Twelve days");
    expect(button("Approve")?.disabled).toBe(true);
    expect(button("Decline…")).toBeUndefined();
  });
});

describe("the review card of an item someone cannot open", () => {
  it("refuses as the item's own page does, whether it is hidden or gone", async () => {
    const { host, root } = mountInto();
    docs.get.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/review/d_leave/run_1"] },
          createElement(Routes, null, createElement(Route, { path: "/review/:docId/:runId", element: createElement(ReviewCardPage) })),
        ),
      ),
    );
    expect(runs.detail).not.toHaveBeenCalled();
    expect(host.querySelector("h1")?.textContent).toBe("This document isn’t available");
  });
});

describe("decidersLine", () => {
  const at = (aliases: string[], also = NONE, stand_in = false, cause: RunDeciders["cause"] = null): RunDeciders => ({ aliases, stand_in, cause, also });

  it("names who decides at colleague, the reader apart from the others", () => {
    expect(decidersLine("colleague", at(["sam"]), "sam", "document")).toBe("You can approve it.");
    expect(decidersLine("colleague", at(["ana", "liv"], NONE, true), "sam", "document")).toBe("Ana or Liv can approve it, standing in as owner or admin.");
    expect(decidersLine("colleague", at([], NONE, true, "group"), "sam", "document")).toBe("Give someone in the approver group edit access to approve it.");
    expect(decidersLine("colleague", null, "sam", "document")).toBeNull();
  });

  it("names whoever asked below colleague, with the owner and an admin by role when they may decide too", () => {
    expect(decidersLine("review", at(["liv"]), "sam", "document")).toBe("Liv can approve it.");
    expect(decidersLine("review", at(["sam"]), "sam", "document")).toBe("You can approve it.");
    expect(decidersLine("review", at(["liv"], { owner: true, admin: true }), "sam", "document")).toBe("Liv, the document’s owner or an admin can approve it.");
    expect(decidersLine("review", at(["liv"], { owner: true, admin: false }), "sam", "database")).toBe("Liv or the database’s owner can approve it.");
    expect(decidersLine("review", at(["liv"], { owner: false, admin: true }), "sam", "document")).toBe("Liv or an admin can approve it.");
    expect(decidersLine("review", at(["liv"], { owner: true, admin: true }), "liv", "document")).toBe("You can approve it, and so can the document’s owner or an admin.");
    expect(decidersLine("review", at(["liv"], { owner: false, admin: true }), "liv", "document")).toBe("You can approve it, and so can an admin.");
    expect(decidersLine("review", at(["liv"], { owner: true, admin: false }), "liv", "database")).toBe("You can approve it, and so can the database’s owner.");
  });
});
