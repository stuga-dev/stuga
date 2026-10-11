// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import type { SearchResult } from "../api";
import { mountInto } from "../test/form-input";
import { toastBodies, toasts } from "../test/toast";

const docs = vi.hoisted(() => ({ search: vi.fn(), sharedWithMe: vi.fn(), get: vi.fn() }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Favorites: { list: vi.fn(async () => ({ favorites: [], docs: [] })) },
}));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("../shell/NotificationsBell", () => ({ NotificationsBell: () => null }));
vi.mock("../shell/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("../shell/WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../library/LibraryNav", () => ({ LibraryNav: () => null }));
vi.mock("../library/FileExplorer", () => ({ FileExplorer: () => null, TableSkeleton: () => null }));
vi.mock("../library/ImportMarkdownDialog", () => ({ ImportMarkdownDialog: () => null }));
vi.mock("../library/NewFolderDialog", () => ({ NewFolderDialog: () => null }));

const { DocList } = await import("./DocList");
const { CommandPaletteProvider } = await import("../shell/command-palette/context");

function result(doc_id: string, over: Partial<SearchResult> = {}): SearchResult {
  return {
    doc_id,
    title: `Note ${doc_id}`,
    doc_type: "prose",
    snippet: `Read this first. Find out ⟦where⟧ things live in ${doc_id}.`,
    score: 1,
    sem_score: 0,
    page_of: null,
    page_row: null,
    updated_at: "2026-10-01T09:00:00.000Z",
    ...over,
  };
}

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `d_${from + i}`);
const answer = (docIds: string[]) => ({ query: "where", results: docIds.map((id) => result(id)), degraded: false });

let host: HTMLDivElement;
let root: Root;
let navigate: NavigateFunction = () => {};

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

/** Hands the test the router's navigate, to change `?q=` the way Back would. */
function Steer() {
  navigate = useNavigate();
  return null;
}

async function render(url = "/?q=where") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <CommandPaletteProvider>
          <Steer />
          <Routes>
            <Route path="/" element={<DocList />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </CommandPaletteProvider>
      </MemoryRouter>,
    );
  });
}

const rows = () => [...host.querySelectorAll<HTMLLIElement>("li.search-result")];
const where = () => host.querySelector('[data-testid="where"]')?.textContent;
/** The shell's content area, which scrolls the results. */
const scroller = () => host.querySelector<HTMLElement>('[role="main"]')!;
const rowIds = () => rows().map((r) => /\/doc\/([^?]+)/.exec(r.querySelector("a")?.getAttribute("href") ?? "")?.[1]);
const badge = () => host.querySelector(".doc-list-head__title")?.lastElementChild?.textContent;
/** By its name: while it loads, its text also carries "Loading". */
const showMoreButton = () =>
  [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === "Show more");

async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Also drops answers queued with mockResolvedValueOnce that a failed test left unused.
  docs.search.mockReset();
  toasts.shown = [];
  sessionStorage.clear();
  ({ host, root } = mountInto());
});

describe("DocList search results count", () => {
  it("reads as the top of a longer list when the answer fills the limit", async () => {
    docs.search.mockResolvedValue(answer(ids(0, 20)));
    await render();
    expect(docs.search).toHaveBeenCalledWith("where", { limit: 20 });
    expect(rows()).toHaveLength(20);
    expect(badge()).toBe("Top 20");
  });

  it("gives the plain count when the answer falls short of the limit, and offers no more", async () => {
    docs.search.mockResolvedValue(answer(ids(0, 3)));
    await render();
    expect(badge()).toBe("3");
    expect(showMoreButton()).toBeUndefined();
  });
});

describe("DocList search results", () => {
  it("names the tab after the search, and says when each result last changed", async () => {
    docs.search.mockResolvedValue(answer(["d_1"]));
    await render();
    expect(document.title).toBe("Search results - Stuga");
    expect(rows()[0]!.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T09:00:00.000Z");
  });

  it("finds nothing: says recent edits may not show yet, and offers Ask", async () => {
    docs.search.mockResolvedValue(answer([]));
    await render();
    expect(host.textContent).toContain("No documents match");
    expect(host.textContent).toContain("Edits from the last minute may not show yet.");
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Ask your documents"));
    expect(where()).toBe("/ask");
  });
});

describe("DocList Show more", () => {
  it("asks for 20 more and adds only documents not yet shown, leaving the rows on screen in place", async () => {
    docs.search.mockResolvedValueOnce(answer(ids(0, 20)));
    await render();
    // The deeper pool reorders the first twenty and comes back short of its limit.
    docs.search.mockResolvedValueOnce(answer(["d_25", ...ids(0, 20).reverse(), ...ids(20, 25)]));
    await click(showMoreButton());
    expect(docs.search).toHaveBeenLastCalledWith("where", { limit: 40 });
    expect(rowIds()).toEqual([...ids(0, 20), "d_25", ...ids(20, 25)]);
    expect(badge()).toBe("26");
    expect(showMoreButton()).toBeUndefined();
  });

  it("stops at the server's cap of 100", async () => {
    docs.search.mockImplementation(async (_q: string, opts: { limit: number }) => answer(ids(0, opts.limit)));
    await render();
    for (let i = 0; i < 4; i++) await click(showMoreButton());
    expect(docs.search.mock.calls.map((c) => c[1].limit)).toEqual([20, 40, 60, 80, 100]);
    expect(rows()).toHaveLength(100);
    expect(badge()).toBe("Top 100");
    expect(showMoreButton()).toBeUndefined();
  });

  it("spins on the button while it loads, and keeps the rows when it fails", async () => {
    docs.search.mockResolvedValueOnce(answer(ids(0, 20)));
    await render();
    let fail: (e: Error) => void = () => {};
    docs.search.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    await click(showMoreButton());
    expect(showMoreButton()?.getAttribute("aria-busy")).toBe("true");
    expect(rows()).toHaveLength(20);
    await act(async () => fail(new Error("down")));
    expect(toastBodies()).toEqual(["down"]);
    expect(rows()).toHaveLength(20);
    expect(showMoreButton()?.hasAttribute("aria-busy")).toBe(false);
  });

  it("drops an answer that lands after the query changed", async () => {
    docs.search.mockResolvedValueOnce(answer(ids(0, 20)));
    await render();
    let late: (v: unknown) => void = () => {};
    docs.search.mockReturnValueOnce(new Promise((r) => (late = r)));
    await click(showMoreButton());
    docs.search.mockResolvedValueOnce({ query: "other", results: [result("d_other")], degraded: false });
    await act(async () => navigate("/?q=other"));
    await act(async () => late(answer(ids(0, 40))));
    expect(rows()).toHaveLength(0);
    // Past the debounce for one query replacing another.
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    expect(rowIds()).toEqual(["d_other"]);
    expect(docs.search).toHaveBeenLastCalledWith("other", { limit: 20 });
  });
});

describe("DocList Back from a document", () => {
  const deepAnswers = () =>
    docs.search.mockImplementation(async (_q: string, opts: { limit: number }) => answer(ids(0, opts.limit)));

  it("shows as many rows as Show more had reached", async () => {
    deepAnswers();
    await render();
    for (let i = 0; i < 3; i++) await click(showMoreButton());
    await act(async () => navigate("/doc/d_65"));
    expect(where()).toBe("/doc/d_65");
    await act(async () => navigate(-1));
    expect(docs.search).toHaveBeenLastCalledWith("where", { limit: 80 });
    expect(rows()).toHaveLength(80);
    expect(badge()).toBe("Top 80");
    expect(showMoreButton()).toBeTruthy();
  });

  it("keeps the depth with its own search: a new query starts at 20, and Back to the deeper one asks for all of it", async () => {
    deepAnswers();
    await render();
    await click(showMoreButton());
    await act(async () => navigate("/?q=other"));
    // Past the debounce for one query replacing another.
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    expect(docs.search).toHaveBeenLastCalledWith("other", { limit: 20 });
    await act(async () => navigate(-1));
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    expect(docs.search).toHaveBeenLastCalledWith("where", { limit: 40 });
    expect(rows()).toHaveLength(40);
  });

  it("lands where the reader left the results, and only on that visit", async () => {
    deepAnswers();
    await render();
    await click(showMoreButton());
    scroller().scrollTop = 1200;
    await act(async () => navigate("/doc/d_30"));
    await act(async () => navigate(-1));
    expect(rows()).toHaveLength(40);
    expect(scroller().scrollTop).toBe(1200);
    // The same search opened afresh is a new visit, from the top.
    await act(async () => navigate("/doc/d_30"));
    await act(async () => navigate("/?q=where"));
    expect(rows()).toHaveLength(20);
    expect(scroller().scrollTop).toBe(0);
  });

  it("stays on the document when a Show more answer lands after the reader left", async () => {
    docs.search.mockResolvedValueOnce(answer(ids(0, 20)));
    await render();
    let late: (v: unknown) => void = () => {};
    docs.search.mockReturnValueOnce(new Promise((r) => (late = r)));
    await click(showMoreButton());
    await act(async () => navigate("/doc/d_3"));
    await act(async () => late(answer(ids(0, 40))));
    expect(where()).toBe("/doc/d_3");
  });
});

describe("DocList search rows", () => {
  it("are links that open at the passage that matched, or at the top when the title matched", async () => {
    docs.search.mockResolvedValue({
      query: "where",
      results: [result("d_1"), result("d_2", { title: "Where things live" })],
      degraded: false,
    });
    await render();
    const [passage, top] = rows().map((r) => r.querySelector("a")!);
    const href = new URL(passage!.getAttribute("href")!, "http://x");
    expect(href.pathname).toBe("/doc/d_1");
    expect(href.searchParams.get("hit")).toContain("Find out where things live");
    expect(top!.getAttribute("href")).toBe("/doc/d_2");
  });

  it("open in the app on a plain click", async () => {
    docs.search.mockResolvedValue({ query: "where", results: [result("d_1", { title: "Where things live" })], degraded: false });
    await render();
    await click(rows()[0]!.querySelector("a")!);
    expect(where()).toBe("/doc/d_1");
  });

  it("show a database with the database icon", async () => {
    docs.search.mockResolvedValue({
      query: "where",
      results: [result("d_1"), result("d_db", { doc_type: "database" })],
      degraded: false,
    });
    await render();
    expect(rows()[0]!.querySelector("svg.lucide-file-text")).toBeTruthy();
    expect(rows()[1]!.querySelector("svg.lucide-database")).toBeTruthy();
    expect(rows()[1]!.querySelector("svg.lucide-file-text")).toBeNull();
  });
});
