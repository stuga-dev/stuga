/** The ask loop against scripted streamed rounds (one per fetch call) and a mock runner. */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AskStep } from "@stuga/protocol/api/ask";
import { runAskAgentTurn, DONT_KNOW, type AskToolRunner } from "./ask.js";
import { CFG, mockRounds, sentBody, textRound, toolRound, streamOf } from "../test-helpers.js";


/** A runner whose search returns one passage, numbered from the given offset. */
function runnerWith(overrides: Partial<AskToolRunner> = {}): AskToolRunner {
  return {
    search: async ({ query, offset }) => ({
      text: `[${offset + 1}] Doc — Section (doc: d1)\nabout ${query}`,
      citations: [{ n: offset + 1, doc_id: "d1", title: "Doc", heading_path: "Section", content: `about ${query}` }],
    }),
    readDocument: async () => ({ title: "Doc", text: "full body", total: 9 }),
    listDocuments: async () => ({ docs: [{ doc_id: "d1", title: "Doc" }], folders: [] }),
    listDatabases: async () => [{ database_id: "db1", title: "Tasks", schema: "table tasks [2 rows]: _id, name text, done checkbox" }],
    queryDatabase: async () => ({ title: "Tasks", columns: ["n"], rows: [[2]], truncated: false }),
    ...overrides,
  };
}

const BASE = { question: "what was the target?", model: "sonnet" as const, history: [] };

afterEach(() => vi.unstubAllGlobals());

describe("runAskAgentTurn", () => {
  it("follows a lead: searches, reads the document it found, then answers", async () => {
    mockRounds([
      toolRound("search_documents", { query: "target" }),
      toolRound("read_document", { doc_id: "d1", offset: 0 }),
      textRound("The target was $4.2M [^1]."),
    ]);
    const steps: AskStep[] = [];
    const out: string[] = [];
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), {
      onChunk: (c) => out.push(c),
      onStep: (s) => steps.push(s),
    });

    expect(r.stopReason).toBe("complete");
    expect(r.rounds).toBe(3);
    expect(r.prose).toContain("$4.2M");
    expect(out.join("")).toBe(r.prose);
    expect(steps.map((s) => s.kind)).toEqual(["search", "read"]);
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0]).toMatchObject({ n: 1, doc_id: "d1", title: "Doc" });
  });

  it("numbers citations globally across several searches", async () => {
    mockRounds([
      toolRound("search_documents", { query: "first" }),
      toolRound("search_documents", { query: "second" }),
      textRound("Both hold [^1][^2]."),
    ]);
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {} });

    // The second search must be told the running offset, so what the model reads
    // as [2] is citation 2 — not a second [1] colliding with the first search.
    expect(r.citations.map((c) => c.n)).toEqual([1, 2]);
    expect(r.citations[1]!.content).toBe("about second");
  });

  it("passes the running offset to each search", async () => {
    mockRounds([
      toolRound("search_documents", { query: "a" }),
      toolRound("search_documents", { query: "b" }),
      textRound("done [^1][^2]."),
    ]);
    const offsets: number[] = [];
    const runner = runnerWith({
      search: async ({ query, offset }) => {
        offsets.push(offset);
        return {
          text: `[${offset + 1}] T\n${query}`,
          citations: [{ n: offset + 1, doc_id: "d1", title: "T", content: query }],
        };
      },
    });
    await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
    expect(offsets).toEqual([0, 1]);
  });

  it("drops sources the answer never cited", async () => {
    mockRounds([toolRound("search_documents", { query: "x" }), textRound("No marker in this answer.")]);
    const runner = runnerWith({
      search: async ({ offset }) => ({
        text: "two passages",
        citations: [
          { n: offset + 1, doc_id: "d1", title: "A", content: "" },
          { n: offset + 2, doc_id: "d2", title: "B", content: "" },
        ],
      }),
    });
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
    expect(r.citations).toEqual([]);
  });

  it("nudges — and resets the stream — when the model answers without searching", async () => {
    mockRounds([
      textRound("The target was $9M."), // ungrounded, straight from the model
      toolRound("search_documents", { query: "target" }),
      textRound("The target was $4.2M [^1]."),
    ]);
    const out: string[] = [];
    let resets = 0;
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), {
      onChunk: (c) => out.push(c),
      onStatus: () => {},
      onReset: () => {
        resets++;
        out.length = 0;
      },
    });

    expect(resets).toBe(1);
    expect(r.stopReason).toBe("complete");
    // The ungrounded claim is gone from BOTH the returned answer and the stream.
    expect(r.prose).not.toContain("$9M");
    expect(r.prose).toContain("$4.2M");
    expect(out.join("")).toBe(r.prose);
  });

  it("nudges only once — a second toolless answer is accepted", async () => {
    mockRounds([textRound("From memory."), textRound("Still from memory.")]);
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {} });
    expect(r.stopReason).toBe("complete");
    expect(r.prose).toBe("Still from memory.");
    expect(r.rounds).toBe(2);
  });

  it("does not nudge a search that legitimately found nothing", async () => {
    mockRounds([toolRound("search_documents", { query: "unicorns" }), textRound(DONT_KNOW)]);
    let resets = 0;
    const runner = runnerWith({ search: async () => ({ text: "No relevant passages found.", citations: [] }) });
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {}, onReset: () => resets++ });
    expect(resets).toBe(0);
    expect(r.prose).toBe(DONT_KNOW);
    expect(r.stopReason).toBe("complete");
  });

  it("reports a failed tool to the model, which recovers and carries on", async () => {
    mockRounds([
      toolRound("read_document", { doc_id: "missing" }),
      toolRound("search_documents", { query: "target" }),
      textRound("Found it elsewhere [^1]."),
    ]);
    let reads = 0;
    const runner = runnerWith({
      readDocument: async () => {
        reads++;
        return null;
      },
    });
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
    expect(reads).toBe(1);
    expect(r.stopReason).toBe("complete");
    // A null read is a tool error, not a step that happened — only the search is traced.
    expect(r.steps.map((s) => s.kind)).toEqual(["search"]);
    expect(r.citations).toHaveLength(1);
  });

  it("counts a successful read as grounding, so it is not nudged", async () => {
    mockRounds([toolRound("read_document", { doc_id: "d1" }), textRound("The doc says X.")]);
    let resets = 0;
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {}, onReset: () => resets++ });
    expect(resets).toBe(0);
    expect(r.rounds).toBe(2);
    expect(r.prose).toBe("The doc says X.");
  });

  it("does NOT count a failed read as grounding — that answer gets nudged", async () => {
    mockRounds([
      toolRound("read_document", { doc_id: "missing" }),
      textRound("I couldn't open that one."), // reads as grounded; nothing was read
      toolRound("search_documents", { query: "target" }),
      textRound("It was $4.2M [^1]."),
    ]);
    let resets = 0;
    const runner = runnerWith({ readDocument: async () => null });
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {}, onReset: () => resets++ });
    expect(resets).toBe(1);
    expect(r.prose).toBe("It was $4.2M [^1].");
  });

  it("hands a worded refusal to the model as the tool error, and does not count it as grounding", async () => {
    mockRounds([
      toolRound("read_document", { doc_id: "d_out" }),
      textRound("That one is outside."),
      toolRound("search_documents", { query: "target" }),
      textRound("It was $4.2M [^1]."),
    ]);
    let resets = 0;
    const runner = runnerWith({ readDocument: async () => ({ error: "that document is not in the selected collection" }) });
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {}, onReset: () => resets++ });
    expect(JSON.stringify(sentBody(1))).toContain("error: that document is not in the selected collection");
    expect(r.steps.map((s) => s.kind)).toEqual(["search"]);
    expect(resets).toBe(1);
  });

  it("does not treat list_documents alone as grounding", async () => {
    mockRounds([
      toolRound("list_documents", {}),
      textRound("Based on the titles, probably $9M."),
      toolRound("search_documents", { query: "target" }),
      textRound("It was $4.2M [^1]."),
    ]);
    let resets = 0;
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {}, onReset: () => resets++ });
    expect(resets).toBe(1);
    expect(r.prose).not.toContain("$9M");
  });

  describe("list_documents", () => {
    it("passes the folder and query through to the runner", async () => {
      mockRounds([toolRound("list_documents", { query: "Q3*", folder_id: "f1" }), textRound("ok")]);
      let got: { query?: string; folder_id?: string } | undefined;
      const runner = runnerWith({
        listDocuments: async (input) => {
          got = input;
          return { docs: [], folders: [] };
        },
      });
      await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
      expect(got).toEqual({ query: "Q3*", folder_id: "f1" });
    });

    it("records folders and query on the step", async () => {
      mockRounds([toolRound("list_documents", { query: "plan" }), textRound("ok")]);
      const runner = runnerWith({
        listDocuments: async () => ({
          docs: [{ doc_id: "d1", title: "Plan" }],
          folders: [{ folder_id: "f1", title: "Eng" }],
        }),
      });
      const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
      // The trace is the audit surface — a listing that walked folders should say so.
      expect(r.steps).toContainEqual({ kind: "list", count: 1, folders: 1, query: "plan" });
    });

    it("reports an unreadable folder as an error, not an empty listing", async () => {
      // An empty result would read as "that folder is empty", which is a claim
      // about a folder the caller may not see at all.
      mockRounds([toolRound("list_documents", { folder_id: "nope" }), textRound("ok")]);
      const runner = runnerWith({
        listDocuments: async () => ({ docs: [], folders: [], folderMissing: true }),
      });
      const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
      // No list step is recorded for a folder that was never listed.
      expect(r.steps.some((s) => s.kind === "list")).toBe(false);
    });

    it("does not silently swallow a malformed runner result", async () => {
      // The loop completes, but the step must not claim a successful listing.
      mockRounds([toolRound("list_documents", {}), textRound("ok")]);
      const runner = runnerWith({
        listDocuments: (async () => [{ doc_id: "d1", title: "Doc" }]) as unknown as AskToolRunner["listDocuments"],
      });
      const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
      expect(r.steps.some((s) => s.kind === "list")).toBe(false);
    });
  });

  it("survives a runner that throws", async () => {
    mockRounds([toolRound("search_documents", { query: "x" }), textRound("Search is down right now.")]);
    const runner = runnerWith({
      search: async () => {
        throw new Error("search index down");
      },
    });
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {} });
    expect(r.stopReason).toBe("complete");
    expect(r.prose).toContain("down");
  });

  it("keeps partial work when it hits the round cap", async () => {
    // Every round asks for another tool, so the cap is the only way out.
    mockRounds([toolRound("search_documents", { query: "loop" }, { text: "Looking… " })]);
    const r = await runAskAgentTurn(CFG, { ...BASE, maxRounds: 3 }, runnerWith(), { onChunk: () => {} });
    expect(r.stopReason).toBe("max_rounds");
    expect(r.rounds).toBe(3);
    expect(r.prose).toContain("Looking…");
    expect(r.steps).toHaveLength(3);
  });

  it("stops between rounds when aborted, keeping what it has", async () => {
    const ctrl = new AbortController();
    mockRounds([toolRound("search_documents", { query: "x" }, { text: "Searching. " })]);
    const runner = runnerWith({
      search: async ({ offset }) => {
        ctrl.abort(); // the user pressed Stop while the tool ran
        return { text: "hit", citations: [{ n: offset + 1, doc_id: "d1", title: "T", content: "" }] };
      },
    });
    const r = await runAskAgentTurn(CFG, { ...BASE, signal: ctrl.signal, maxRounds: 5 }, runner, { onChunk: () => {} });
    expect(r.stopReason).toBe("aborted");
    expect(r.rounds).toBe(1);
    expect(r.prose).toContain("Searching.");
  });

  it("stops when the budget hook refuses a further round", async () => {
    mockRounds([toolRound("search_documents", { query: "x" }, { text: "Working. " })]);
    const r = await runAskAgentTurn(
      CFG,
      { ...BASE, maxRounds: 5, beforeRound: async () => "The AI budget for this turn is exhausted." },
      runnerWith(),
      { onChunk: () => {} },
    );
    expect(r.stopReason).toBe("budget");
    expect(r.error).toContain("budget for this turn");
    expect(r.rounds).toBe(1);
    expect(r.prose).toContain("Working.");
  });

  it("separates rounds so two prose bursts don't run together", async () => {
    mockRounds([
      toolRound("search_documents", { query: "x" }, { text: "Let me look." }),
      textRound("Found it [^1]."),
    ]);
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {} });
    expect(r.prose).toBe("Let me look.\n\nFound it [^1].");
  });

  it("drops empty history turns (providers reject a blank text block)", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 }));
      }),
    );
    await runAskAgentTurn(
      CFG,
      { ...BASE, history: [{ role: "user", content: "" }, { role: "assistant", content: "prior" }] },
      runnerWith(),
      { onChunk: () => {} },
    );
    const sent = JSON.parse(bodies[0]!) as { messages: Array<{ content: Array<{ text?: string }> }> };
    expect(sent.messages).toHaveLength(2); // "prior" + the question; the blank one is gone
    expect(sent.messages[0]!.content[0]!.text).toBe("prior");
  });
});

describe("text-to-SQL over structured databases", () => {
  it("lists databases with their schemas, queries one, grounds on the rows, and records the step", async () => {
    mockRounds([
      toolRound("list_databases", {}),
      toolRound("query_database", { database_id: "db1", sql: "SELECT count(*) AS n FROM tasks WHERE done = 0" }),
      textRound("Two tasks are still open."),
    ]);
    const steps: AskStep[] = [];
    const r = await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {}, onStep: (s) => steps.push(s) });
    expect(r.stopReason).toBe("complete");
    expect(r.prose).toContain("Two tasks");
    expect(steps).toEqual([
      { kind: "query", database_id: "db1", title: "Tasks", sql: "SELECT count(*) AS n FROM tasks WHERE done = 0", rows: 1 },
    ]);
  });

  it("hands a refused statement back to the model as a correctable error, not a dead turn", async () => {
    mockRounds([
      toolRound("query_database", { database_id: "db1", sql: "DELETE FROM tasks" }),
      toolRound("query_database", { database_id: "db1", sql: "SELECT count(*) AS n FROM tasks" }),
      textRound("There are 2."),
    ]);
    const runner = runnerWith({
      queryDatabase: async ({ sql }) =>
        sql.startsWith("DELETE") ? { error: "only a single SELECT is allowed" } : { title: "Tasks", columns: ["n"], rows: [[2]], truncated: false },
    });
    const steps: AskStep[] = [];
    const r = await runAskAgentTurn(CFG, BASE, runner, { onChunk: () => {}, onStep: (s) => steps.push(s) });
    expect(r.stopReason).toBe("complete");
    // Only the query that ran is a step; the refusal was a tool error the model corrected.
    expect(steps.map((s) => s.kind)).toEqual(["query"]);
  });
});

describe("workspace instructions", () => {
  type Body = { system: Array<{ text: string }> };
  const systemOf = (n = 0) => sentBody<Body>(n).system.map((b) => b.text).join("\n");

  it("appends the workspace's instructions to the system prompt, fenced as policy", async () => {
    mockRounds([toolRound("search_documents", { query: "target" }), textRound("It was $4.2M [^1].")]);
    await runAskAgentTurn(CFG, { ...BASE, workspaceInstructions: "Answer in bullet points." }, runnerWith(), { onChunk: () => {} });
    const system = systemOf();
    expect(system).toContain("search_documents(query)");
    expect(system).toContain("<<<INSTRUCTIONS Workspace\nAnswer in bullet points.\nINSTRUCTIONS");
    expect(system).toMatch(/the user's request wins/);
    // Part of the cached prefix: the same on every round.
    expect(systemOf(1)).toBe(system);
  });

  it("changes not one byte of the prompt when the workspace wrote none", async () => {
    mockRounds([textRound("done")]);
    await runAskAgentTurn(CFG, { ...BASE, workspaceInstructions: "  " }, runnerWith(), { onChunk: () => {} });
    const blank = systemOf();
    vi.unstubAllGlobals();

    mockRounds([textRound("done")]);
    await runAskAgentTurn(CFG, BASE, runnerWith(), { onChunk: () => {} });
    expect(blank).toBe(systemOf());
    expect(blank).not.toContain("INSTRUCTIONS");
  });
});
