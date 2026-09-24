// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";

const docs = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api", () => ({ Docs: docs }));

const { useRefreshAfterIndexing } = await import("./use-refresh-after-indexing");

let host: HTMLDivElement;
let root: Root;
let ydoc: Y.Doc;
const onDoc = vi.fn();

function Probe({ doc }: { doc: Y.Doc | null }) {
  useRefreshAfterIndexing("d_1", doc, onDoc);
  return null;
}

function edit(text: string) {
  ydoc.getText("t").insert(0, text);
}

/** Past the actor's snapshot interval and the index job's allowance. */
const SETTLED_MS = DOC_FLUSH_INTERVAL_MS + 10_000;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  docs.get.mockReset().mockResolvedValue({ doc_id: "d_1", title: "Meeting notes" });
  onDoc.mockReset();
  ydoc = new Y.Doc();
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Probe doc={ydoc} />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useRefreshAfterIndexing", () => {
  it("re-reads the document once, after the content has been still long enough to be indexed", async () => {
    edit("Meeting");
    await act(async () => vi.advanceTimersByTime(SETTLED_MS - 1_000));
    edit(" notes");
    await act(async () => vi.advanceTimersByTime(SETTLED_MS - 1));
    expect(docs.get).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(docs.get).toHaveBeenCalledTimes(1);
    expect(docs.get).toHaveBeenCalledWith("d_1");
    expect(onDoc).toHaveBeenCalledWith({ doc_id: "d_1", title: "Meeting notes" });

    await act(async () => vi.advanceTimersByTime(SETTLED_MS * 3));
    expect(docs.get).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while the content does not change", async () => {
    await act(async () => vi.advanceTimersByTime(SETTLED_MS * 3));
    expect(docs.get).not.toHaveBeenCalled();
  });

  it("stops listening when the page goes away", async () => {
    edit("Meeting notes");
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => vi.advanceTimersByTime(SETTLED_MS));
    edit(" again");
    await act(async () => vi.advanceTimersByTime(SETTLED_MS));
    expect(docs.get).not.toHaveBeenCalled();
  });
});
