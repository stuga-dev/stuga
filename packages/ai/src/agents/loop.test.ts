import { describe, it, expect, vi, afterEach } from "vitest";
import { filterHistory, filterCited, runAgentLoop, type AgentLoopSpec } from "./loop.js";
import { CFG, mockRounds, textRound, toolRound } from "../test-helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** A minimal loop: no tools offered, every dispatch succeeds. */
function spec(over: Partial<AgentLoopSpec> = {}): AgentLoopSpec {
  return {
    cfg: CFG,
    modelId: "sonnet",
    system: "system",
    tools: [],
    maxRounds: 5,
    maxTokens: 1024,
    history: [],
    seed: "go",
    dispatch: async () => ({ text: "ok" }),
    onChunk: () => {},
    ...over,
  };
}

describe("runAgentLoop", () => {
  it("ends 'complete' when the model ends its own turn", async () => {
    mockRounds([textRound("All set.")]);
    const r = await runAgentLoop(spec());
    expect(r).toMatchObject({ stopReason: "complete", rounds: 1, prose: "All set." });
    expect(r.error).toBeUndefined();
  });

  it("resolves 'error' with nothing when the first round throws, so the caller can fail the turn", async () => {
    // A 400, since a 5xx or a network error would wait out the client's retry backoff.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("endpoint down", { status: 400 }))));
    const r = await runAgentLoop(spec());
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("endpoint down");
    expect(r.prose).toBe("");
  });

  it("breaks between rounds so one round's prose can't run into the next", async () => {
    mockRounds([toolRound("look", {}, { text: "Let me look." }), textRound("Found it.")]);
    const chunks: string[] = [];
    const r = await runAgentLoop(spec({ onChunk: (t) => chunks.push(t) }));
    expect(r.prose).toBe("Let me look.\n\nFound it.");
    // Streamed, not just stored: the live panel and the finished turn must match.
    expect(chunks.join("")).toBe(r.prose);
  });
});

describe("filterHistory", () => {
  it("drops blank turns", () => {
    const kept = filterHistory([
      { role: "user", content: "real question" },
      { role: "assistant", content: "" },
      { role: "user", content: "   " },
      { role: "assistant", content: "\n\t " },
      { role: "assistant", content: "real answer" },
    ]);
    expect(kept.map((h) => h.content)).toEqual(["real question", "real answer"]);
  });

  it("preserves order and does not trim surviving content", () => {
    const kept = filterHistory([
      { role: "user", content: "  padded  " },
      { role: "assistant", content: "b" },
    ]);
    expect(kept).toEqual([
      { role: "user", content: "  padded  " },
      { role: "assistant", content: "b" },
    ]);
  });

  it("returns nothing for an all-blank history", () => {
    expect(filterHistory([{ role: "user", content: "" }])).toEqual([]);
  });
});

describe("filterCited", () => {
  const cites = [
    { n: 1, doc_id: "a" },
    { n: 2, doc_id: "b" },
    { n: 3, doc_id: "c" },
  ];

  it("keeps only referenced sources, in their original order", () => {
    expect(filterCited("Facts [^3] and more [^1].", cites)).toEqual([
      { n: 1, doc_id: "a" },
      { n: 3, doc_id: "c" },
    ]);
  });

  it("accepts both [n] and [^n]", () => {
    expect(filterCited("plain [2] and caret [^1]", cites).map((c) => c.n)).toEqual([1, 2]);
  });

  it("drops everything when the prose cites nothing", () => {
    expect(filterCited("No markers at all.", cites)).toEqual([]);
  });

  it("ignores markers that match no source", () => {
    expect(filterCited("Invented [^9].", cites)).toEqual([]);
  });

  it("counts a repeated marker once", () => {
    expect(filterCited("[^1] and again [^1]", cites)).toEqual([{ n: 1, doc_id: "a" }]);
  });
});
