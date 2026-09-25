import { describe, expect, it } from "vitest";
import type { RetrieveBody, SearchBody } from "../backend.js";
import { EMPTY_SCOPE_NOTE, renderPassages, renderSearch, type WorkspacePart } from "./search.js";

const chunk = (over: Record<string, unknown> = {}) => ({
  doc_id: "d1",
  title: "Handbook",
  content: "Expenses are filed monthly.",
  heading_path: "Policies > Expenses",
  ...over,
});
const part = <T>(body: T, origin = "http://localhost:8787", workspace_id = "ws1"): WorkspacePart<T> => ({ workspace_id, origin, body });
const passages = (body: RetrieveBody, origin?: string) => JSON.parse(renderPassages([part(body, origin)], []));

describe("renderPassages", () => {
  it("turns chunks into citable passages with their workspace and a link to each source", () => {
    expect(passages({ chunks: [chunk()], degraded: false })).toEqual({
      passages: [
        {
          workspace_id: "ws1",
          doc_id: "d1",
          title: "Handbook",
          heading_path: "Policies > Expenses",
          content: "Expenses are filed monthly.",
          url: "http://localhost:8787/doc/d1",
        },
      ],
      degraded: false,
      unavailable: [],
    });
  });

  it("leaves out the link when there is no origin", () => {
    expect(passages({ chunks: [chunk()] }, "").passages[0]).not.toHaveProperty("url");
  });

  it("reports a degraded ranking from any workspace", () => {
    const out = JSON.parse(renderPassages([part({ chunks: [chunk()] }), part({ chunks: [], degraded: true }, "", "ws2")], []));
    expect(out).toMatchObject({ degraded: true });
  });

  it("adds the scope note only on the node's empty_scope flag, for a single workspace", () => {
    expect(passages({ chunks: [], empty_scope: true })).toEqual({ passages: [], degraded: false, unavailable: [], note: EMPTY_SCOPE_NOTE });
    expect(passages({ chunks: [] })).toEqual({ passages: [], degraded: false, unavailable: [] });
  });

  it("keeps the degraded flag beside the scope note", () => {
    expect(passages({ chunks: [], degraded: true, empty_scope: true })).toMatchObject({ degraded: true, note: EMPTY_SCOPE_NOTE });
  });

  it("cuts the merged passages at the limit, and carries what could not be reached", () => {
    const out = JSON.parse(
      renderPassages(
        [part({ chunks: [chunk({ doc_id: "a1" }), chunk({ doc_id: "a2" })] }), part({ chunks: [chunk({ doc_id: "b1" })] }, "", "ws2")],
        [{ workspace_id: "ws9", reason: "node is asleep" }],
        2,
      ),
    );
    expect(out.passages.map((p: { doc_id: string }) => p.doc_id)).toEqual(["a1", "b1"]);
    expect(out.unavailable).toEqual([{ workspace_id: "ws9", reason: "node is asleep" }]);
  });
});

describe("renderSearch", () => {
  const body = (over: Partial<SearchBody> = {}): SearchBody => ({ query: "x", results: [], degraded: false, semantic: true, ...over });

  it("names each hit's workspace and link, and drops the per-workspace scores", () => {
    const out = JSON.parse(renderSearch("x", [part(body({ results: [{ doc_id: "d1", title: "T", score: 1, sem_score: 0.9 }] }))], []));
    expect(out).toEqual({
      query: "x",
      results: [{ workspace_id: "ws1", doc_id: "d1", title: "T", url: "http://localhost:8787/doc/d1" }],
      degraded: false,
      semantic: true,
      unavailable: [],
    });
  });

  it("adds the scope note on the node's flag", () => {
    expect(JSON.parse(renderSearch("x", [part(body({ empty_scope: true }))], []))).toMatchObject({ note: EMPTY_SCOPE_NOTE });
  });

  it("is semantic only when every workspace's search was", () => {
    expect(JSON.parse(renderSearch("x", [part(body()), part(body({ semantic: false }), "", "ws2")], [])).semantic).toBe(false);
    expect(JSON.parse(renderSearch("x", [], [{ workspace_id: "ws1", reason: "gone" }])).semantic).toBe(false);
  });
});
