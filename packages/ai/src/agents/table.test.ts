/**
 * The table co-author loop against scripted streamed rounds and a mock runner:
 * mutations stage as they are emitted, and citations stay in the prose.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { runTableAgentTurn, type TableToolRunner } from "./table.js";
import { CFG, mockRounds, textRound, toolRound, streamOf } from "../test-helpers.js";

const NOOP_RUNNER: TableToolRunner = {
  getSchema: async () => "{}",
  query: async () => "[]",
  stageOp: async () => ({ text: "ok: staged", isError: false, staged: true }),
};

const INPUT = {
  prompt: "fill in the Q3 numbers",
  schemaJson: '{"tables":[]}',
  activeTable: "Revenue",
  // An explicit id from the test config, so the test pins the model rather than the default.
  model: "sonnet" as const,
  history: [],
};

/** The tool names offered on the FIRST request — what the model can actually see. */
function offeredTools(fetchFn: ReturnType<typeof vi.fn>): string[] {
  const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
    tools: Array<{ name: string }>;
  };
  return body.tools.map((t) => t.name);
}

const CITES: AiCitation[] = [
  { n: 1, doc_id: "d1", title: "Q3 Board Deck", heading_path: "Revenue", content: "Q3 revenue was 4.2M." },
  { n: 2, doc_id: "d2", title: "Finance Notes", heading_path: null, content: "Unused passage." },
];

afterEach(() => vi.unstubAllGlobals());

describe("runTableAgentTurn", () => {
  it("streams prose and stages nothing when the model just answers", async () => {
    mockRounds([textRound("Your table already has the Q3 rows.")]);
    const chunks: string[] = [];
    const out = await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, (t) => chunks.push(t));
    expect(chunks.join("")).toBe("Your table already has the Q3 rows.");
    expect(out.staged).toBe(0);
    expect(out.citations).toEqual([]);
  });

  it("stages a mutation through the runner as the model emits it", async () => {
    mockRounds([toolRound("insert_rows", { table: "Revenue", rows: [{ Name: "Q3" }] }), textRound("Proposed one row.")]);
    const stageOp = vi.fn(async () => ({ text: "ok: staged", isError: false, staged: true }));
    const out = await runTableAgentTurn(CFG, INPUT, { ...NOOP_RUNNER, stageOp }, () => {});
    expect(stageOp).toHaveBeenCalledWith({ kind: "rows.insert", table: "Revenue", rows: [{ Name: "Q3" }] });
    expect(out.staged).toBe(1);
  });

  it("breaks between rounds so one round's prose can't run into the next", async () => {
    mockRounds([
      toolRound("add_column", { table: "Revenue", name: "Date", type: "date" }, { text: "I'll add a Date column." }),
      textRound("Done — I proposed 1 change."),
    ]);
    const chunks: string[] = [];
    const out = await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, (t) => chunks.push(t));
    expect(out.prose).toBe("I'll add a Date column.\n\nDone — I proposed 1 change.");
    // The break is streamed, not just stored — the live panel and the finished
    // turn must show the same thing.
    expect(chunks.join("")).toBe(out.prose);
  });

  it("passes the model choice through to the resolved model id", async () => {
    // The ledger stores the CLIENT id the operator configured, not the
    // provider's wire model name — that survives a vendor renaming or
    // retiring the exact snapshot it pointed to.
    mockRounds([textRound("ok")]);
    const fast = await runTableAgentTurn(CFG, { ...INPUT, model: "fast" }, NOOP_RUNNER, () => {});
    expect(fast.modelId).toBe("fast");
    mockRounds([textRound("ok")]);
    const auto = await runTableAgentTurn(CFG, { ...INPUT, model: "auto" }, NOOP_RUNNER, () => {});
    expect(auto.modelId).toBe(CFG.chat.defaultModel);
  });
});

describe("runTableAgentTurn knowledge-base search", () => {
  it("does NOT offer search_collection when no Collection is selected", async () => {
    // With no scope there is nothing to search, and a tool that can only fail
    // teaches the model to distrust its toolbox.
    const fetchFn = vi.fn(() => Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 })));
    vi.stubGlobal("fetch", fetchFn);
    await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, () => {});
    const names = offeredTools(fetchFn);
    expect(names).not.toContain("search_collection");
    expect(names).toContain("query"); // the table tools are still all there
  });

  it("offers search_collection when a Collection is selected AND the runner can serve it", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 })));
    vi.stubGlobal("fetch", fetchFn);
    await runTableAgentTurn(
      CFG,
      { ...INPUT, collectionEnabled: true },
      { ...NOOP_RUNNER, searchCollection: async () => ({ text: "", citations: [] }) },
      () => {},
    );
    expect(offeredTools(fetchFn)).toContain("search_collection");
  });

  it("withholds the tool when the runner cannot serve it, even if enabled", async () => {
    // The route only supplies searchCollection when a collection id came in, so
    // the flag alone must not conjure a tool with nothing behind it.
    const fetchFn = vi.fn(() => Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 })));
    vi.stubGlobal("fetch", fetchFn);
    await runTableAgentTurn(CFG, { ...INPUT, collectionEnabled: true }, NOOP_RUNNER, () => {});
    expect(offeredTools(fetchFn)).not.toContain("search_collection");
  });

  it("wires the runner, reports the query as activity, and returns the cited source", async () => {
    mockRounds([
      toolRound("search_collection", { query: "Q3 revenue" }),
      textRound("Q3 revenue was 4.2M [^1]. I proposed the row."),
    ]);
    const searchCollection = vi.fn(async () => ({ text: "[1] Q3 Board Deck\n…", citations: CITES }));
    const activities: string[] = [];
    const out = await runTableAgentTurn(
      CFG,
      { ...INPUT, collectionEnabled: true },
      { ...NOOP_RUNNER, searchCollection },
      () => {},
      (a) => activities.push(a.kind === "searching" ? `searching:${a.query}` : a.kind),
    );
    expect(searchCollection).toHaveBeenCalledWith({ query: "Q3 revenue" });
    expect(activities).toContain("searching:Q3 revenue");
    // Only the source the prose actually cited survives — a search over-fetches.
    expect(out.citations.map((c) => c.doc_id)).toEqual(["d1"]);
  });

  it("renumbers citations globally across two searches", async () => {
    mockRounds([
      toolRound("search_collection", { query: "first" }, { id: "a" }),
      toolRound("search_collection", { query: "second" }, { id: "b" }),
      textRound("Both [^1] and [^3] mattered."),
    ]);
    const searchCollection = vi
      .fn()
      .mockResolvedValueOnce({ text: "…", citations: CITES }) // becomes 1,2
      .mockResolvedValueOnce({ text: "…", citations: [{ ...CITES[0]!, n: 1, doc_id: "d3", title: "Third" }] }); // becomes 3
    const out = await runTableAgentTurn(
      CFG,
      { ...INPUT, collectionEnabled: true },
      { ...NOOP_RUNNER, searchCollection },
      () => {},
    );
    expect(out.citations.map((c) => c.n)).toEqual([1, 3]);
    expect(out.citations.map((c) => c.doc_id)).toEqual(["d1", "d3"]);
  });

  it("does NOT count a marker that leaked into a cell value as a citation", async () => {
    // THE TABLE-SPECIFIC RULE. The system prompt forbids markers in cell values
    // (they would corrupt a text cell and fail to coerce into a number/date one).
    // Counting one as a reference would reward exactly the behaviour we forbid,
    // and would credit a source the user never sees cited in the reply.
    mockRounds([
      toolRound("search_collection", { query: "Q3 revenue" }, { id: "a" }),
      toolRound("insert_rows", { table: "Revenue", rows: [{ Amount: "4.2M [^1]" }] }, { id: "b" }),
      textRound("Added the row."),
    ]);
    const out = await runTableAgentTurn(
      CFG,
      { ...INPUT, collectionEnabled: true },
      { ...NOOP_RUNNER, searchCollection: async () => ({ text: "…", citations: CITES }) },
      () => {},
    );
    expect(out.staged).toBe(1);
    expect(out.citations).toEqual([]); // prose cited nothing
  });

  it("keeps going when the search is refused, so the model can fall back to SQL", async () => {
    // A refusal comes back as readable TEXT, not an exception — the turn must
    // continue and still be able to stage changes from the tables themselves.
    mockRounds([
      toolRound("search_collection", { query: "anything" }, { id: "a" }),
      toolRound("insert_rows", { table: "Revenue", rows: [{ Name: "Q3" }] }, { id: "b" }),
      textRound("The knowledge base was unavailable, so I used the table."),
    ]);
    const out = await runTableAgentTurn(
      CFG,
      { ...INPUT, collectionEnabled: true },
      {
        ...NOOP_RUNNER,
        searchCollection: async () => ({
          text: "Knowledge-base search is unavailable for this scope.",
          citations: [],
        }),
      },
      () => {},
    );
    expect(out.staged).toBe(1);
    expect(out.citations).toEqual([]);
  });

  it("rejects an empty query without calling the runner", async () => {
    mockRounds([toolRound("search_collection", { query: "  " }), textRound("done")]);
    const searchCollection = vi.fn(async () => ({ text: "", citations: [] }));
    await runTableAgentTurn(
      CFG,
      { ...INPUT, collectionEnabled: true },
      { ...NOOP_RUNNER, searchCollection },
      () => {},
    );
    expect(searchCollection).not.toHaveBeenCalled();
  });
});

/** Ops are parked in the ledger as they are staged, so an incomplete turn must still report them. */
describe("runTableAgentTurn — incomplete turns keep their staged ops", () => {
  it("reports stopReason 'complete' when the model ends its own turn", async () => {
    mockRounds([textRound("All set.")]);
    const out = await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, () => {});
    expect(out.stopReason).toBe("complete");
    expect(out.error).toBeUndefined();
  });

  it("reports 'max_rounds' at the cap, and still counts the ops staged before it", async () => {
    mockRounds([toolRound("insert_rows", { table: "Revenue", rows: [{ Name: "Q3" }] })]);
    const out = await runTableAgentTurn(CFG, { ...INPUT, maxRounds: 3 }, NOOP_RUNNER, () => {});
    expect(out.stopReason).toBe("max_rounds");
    expect(out.rounds).toBe(3);
    expect(out.staged).toBe(3);
  });

  it("a throw mid-loop resolves with stopReason 'error' and the ops already staged", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        if (call++ === 0) {
          const fr = toolRound("insert_rows", { table: "Revenue", rows: [{ Name: "Q3" }] }, { text: "Adding. " });
          return Promise.resolve(new Response(streamOf(fr), { status: 200 }));
        }
        return Promise.reject(new Error("upstream throttled"));
      }),
    );
    const out = await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, () => {});
    expect(out.stopReason).toBe("error");
    expect(out.error).toContain("upstream throttled");
    expect(out.staged).toBe(1); // survived the failure
    expect(out.prose).toContain("Adding.");
  });

  it("a throw on the FIRST round still resolves — with nothing, so the caller can fail the turn", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("endpoint down"))));
    const out = await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, () => {});
    expect(out.stopReason).toBe("error");
    expect(out.staged).toBe(0);
    expect(out.prose).toBe("");
  });
});

describe("instructions for agents", () => {
  /** The system prompt actually sent on the first round. */
  function systemOf(fetchFn: ReturnType<typeof vi.fn>): string {
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
      system?: Array<{ text?: string }>;
    };
    return (body.system ?? []).map((b) => b.text ?? "").join("\n");
  }

  it("reaches the model as the database's stack, each level fenced as policy", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 })));
    vi.stubGlobal("fetch", fetchFn);
    await runTableAgentTurn(
      CFG,
      {
        ...INPUT,
        instructions: [
          { kind: "workspace", id: "ws1", title: "Acme", text: "Dates are ISO 8601." },
          { kind: "database", id: "db1", title: "Tasks", text: "Tasks live in the Tasks database; add rows, don't rewrite them." },
        ],
      },
      NOOP_RUNNER,
      () => {},
    );
    const system = systemOf(fetchFn);
    expect(system).toContain("Tasks live in the Tasks database");
    expect([...system.matchAll(/^<<<INSTRUCTIONS (.*)$/gm)].map((m) => m[1])).toEqual(['Workspace "Acme"', 'Database "Tasks"']);
    // The tool contract is still intact above it, placeholder substituted.
    expect(system).toContain("insert_rows(table, rows)");
    expect(system).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("adds nothing when nothing applies", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 })));
    vi.stubGlobal("fetch", fetchFn);
    await runTableAgentTurn(CFG, { ...INPUT, instructions: [] }, NOOP_RUNNER, () => {});
    const withNone = systemOf(fetchFn);
    vi.unstubAllGlobals();

    const absent = vi.fn(() => Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 })));
    vi.stubGlobal("fetch", absent);
    await runTableAgentTurn(CFG, INPUT, NOOP_RUNNER, () => {});
    expect(withNone).toBe(systemOf(absent));
    expect(withNone).not.toContain("INSTRUCTIONS");
  });
});
