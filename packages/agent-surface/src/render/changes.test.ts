import { describe, expect, it } from "vitest";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { toolDefinition } from "../catalog.js";
import { renderDatabasePropose } from "./databases.js";
import { renderPropose } from "./docs.js";
import { REMEMBER_NEXT } from "./remember.js";

const RUN = {
  id: "run_0123456789ab",
  doc_id: "doc-1",
  source: "connector",
  agent: "Connector",
  agent_alias: "agent-1",
  reviewer: "liv",
  status: "open",
  hunks: [],
  acknowledged: false,
  auto_applied: false,
  review_mode: "colleague",
  created_at: 1,
  updated_at: 2,
} satisfies AgentRunSummary;

describe("a write's change", () => {
  it("hands the change's id back on every write, so the agent passes it on", () => {
    const text = renderPropose({ mode: "proposed", run: RUN, pending: 1, reason: "this document waits for a colleague's approval", change_id: "chg_0123456789ab", change_title: "Customer sync" });
    expect(text).toContain('pass `change_id` "chg_0123456789ab" to every other write');
  });

  it("says a queued write is success, and what it waits behind", () => {
    const text = renderPropose({
      mode: "proposed",
      run: RUN,
      pending: 1,
      reason: "queued",
      change_id: "chg_0000000000bb",
      queued_behind: { run_id: "run_aaaaaaaaaaaa", change_id: "chg_0000000000aa", change_title: "Customer sync, 2026-10-18" },
    });
    expect(text).toContain('QUEUED behind your change "Customer sync, 2026-10-18" (run run_aaaaaaaaaaaa)');
    expect(text).toContain("This is SUCCESS");
  });

  it("says the same of a database write", () => {
    const text = JSON.parse(
      renderDatabasePropose(
        {
          mode: "proposed",
          run: { ...RUN, database_id: "db1", ops: [] } as never,
          pending: 1,
          change_id: "chg_0000000000bb",
          change_title: "Email from Sam",
          queued_behind: { run_id: "run_aaaaaaaaaaaa", change_id: null, change_title: null },
        },
        "inserted 1 row(s).",
      ),
    ) as { result: string; change_id: string; queued_behind: unknown };
    expect(text.change_id).toBe("chg_0000000000bb");
    expect(text.queued_behind).toEqual({ run_id: "run_aaaaaaaaaaaa", change_id: null, change_title: null });
    expect(text.result).toContain("QUEUED behind your earlier changes");
  });

  it("is offered on every write that makes a page or changes one, and the save is told to make one", () => {
    for (const tool of ["docs_create", "markdown_append", "markdown_edit", "databases_add", "databases_change"] as const) {
      const def = toolDefinition(tool);
      expect(Object.keys(def.inputSchema), tool).toEqual(expect.arrayContaining(["change_title", "change_id", "change_summary"]));
      expect(def.description, tool).toContain("ONE piece of work is ONE change");
    }
    expect(toolDefinition("remember").description).toContain("ONE change for the whole save");
    expect(REMEMBER_NEXT).toContain("The whole save is ONE change");
  });
});
