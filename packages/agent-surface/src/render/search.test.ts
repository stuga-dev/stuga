import { describe, expect, it } from "vitest";
import { EMPTY_SCOPE_NOTE, renderPassages, renderSearch } from "./search.js";

const chunk = (over: Record<string, unknown> = {}) => ({
  doc_id: "d1",
  title: "Handbook",
  content: "Expenses are filed monthly.",
  heading_path: "Policies > Expenses",
  ...over,
});

describe("renderPassages", () => {
  it("turns chunks into citable passages with a link to each source", () => {
    expect(JSON.parse(renderPassages({ chunks: [chunk()], degraded: false }, "http://localhost:8787"))).toEqual({
      passages: [
        {
          doc_id: "d1",
          title: "Handbook",
          heading_path: "Policies > Expenses",
          content: "Expenses are filed monthly.",
          url: "http://localhost:8787/doc/d1",
        },
      ],
      degraded: false,
    });
  });

  it("leaves out the link when there is no origin", () => {
    const out = JSON.parse(renderPassages({ chunks: [chunk()] }, "")) as { passages: Array<Record<string, unknown>> };
    expect(out.passages[0]).not.toHaveProperty("url");
  });

  it("reports a degraded ranking", () => {
    expect(JSON.parse(renderPassages({ chunks: [chunk()], degraded: true }, ""))).toMatchObject({ degraded: true });
  });

  it("adds the scope note only on the node's empty_scope flag", () => {
    expect(JSON.parse(renderPassages({ chunks: [], empty_scope: true }, "http://x"))).toEqual({ passages: [], degraded: false, note: EMPTY_SCOPE_NOTE });
    expect(JSON.parse(renderPassages({ chunks: [] }, "http://x"))).toEqual({ passages: [], degraded: false });
  });

  it("keeps the degraded flag beside the scope note", () => {
    expect(JSON.parse(renderPassages({ chunks: [], degraded: true, empty_scope: true }, ""))).toEqual({
      passages: [],
      degraded: true,
      note: EMPTY_SCOPE_NOTE,
    });
  });
});

describe("renderSearch", () => {
  it("passes the node's answer through whole", () => {
    const body = { query: "x", results: [{ doc_id: "d1" }], degraded: false, semantic: true };
    expect(JSON.parse(renderSearch(body))).toEqual(body);
  });

  it("adds the scope note on the node's flag", () => {
    expect(JSON.parse(renderSearch({ query: "x", results: [], degraded: false, semantic: true, empty_scope: true }))).toEqual({
      query: "x",
      results: [],
      degraded: false,
      semantic: true,
      empty_scope: true,
      note: EMPTY_SCOPE_NOTE,
    });
  });
});
