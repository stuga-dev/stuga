// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { toasts } from "../../test/toast";
import { mountInto, typeInto } from "../../test/form-input";

const folders = vi.hoisted(() => ({ create: vi.fn(), placementInstructions: vi.fn(async () => ({ inherited: [] })) }));
const docs = vi.hoisted(() => ({ search: vi.fn(), create: vi.fn(), get: vi.fn() }));
const workspaces = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  Folders: folders,
  Docs: docs,
  Me: { whoami: vi.fn(async () => ({ node_admin: false })) },
  Workspaces: workspaces,
}));
vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));

const { CommandPalette, PALETTE_START } = await import("./CommandPalette");
const { CommandPaletteProvider } = await import("./context");

let host: HTMLDivElement;
let root: Root;

function Where() {
  const loc = useLocation();
  return (
    <>
      <output data-testid="path">{loc.pathname}</output>
      <output data-testid="search">{loc.search}</output>
      <output data-testid="jump">{(loc.state as { jump?: number } | null)?.jump}</output>
    </>
  );
}

const path = () => host.querySelector('[data-testid="path"]')?.textContent;
const searchParam = (name: string) => new URLSearchParams(host.querySelector('[data-testid="search"]')?.textContent ?? "").get(name);
const jump = () => host.querySelector('[data-testid="jump"]')?.textContent;

async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function createFolder(name: string) {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
  await click([...host.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent === "New folder"));
  const input = [...host.querySelectorAll("input")].find(
    (i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.includes("Folder name"),
  );
  expect(input).toBeTruthy();
  await typeInto(input, name);
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Create"));
}

async function mountPalette() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/doc/d_1"]}>
        <CommandPaletteProvider>
          <CommandPalette />
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </CommandPaletteProvider>
      </MemoryRouter>,
    );
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  workspaces.list.mockResolvedValue({ workspaces: [], active: null });
  docs.search.mockImplementation(async () => ({ results: [], degraded: false }));
  localStorage.clear();
  toasts.shown = [];
  ({ host, root } = mountInto());
  await mountPalette();
});

describe("CommandPalette keyboard", () => {
  it("points the input at the highlighted option, so a screen reader follows the arrow keys", async () => {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const options = () => [...host.querySelectorAll('[role="listbox"] [role="option"]')];
    const active = () => host.querySelector(`[id="${input.getAttribute("aria-activedescendant")}"]`);
    expect(input.getAttribute("aria-controls")).toBe(host.querySelector('[role="listbox"]')?.id);
    expect(options().length).toBeGreaterThan(1);
    expect(active()).toBe(options()[0]);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(active()).toBe(options()[1]);
  });
});

describe("CommandPalette New folder", () => {
  it("shows the refusal and stays put when the folder cannot be created", async () => {
    folders.create.mockRejectedValue(new Error("A folder with that name exists"));
    await createFolder("Plans");
    expect(folders.create).toHaveBeenCalledWith("Plans", null);
    expect(toasts.shown).toContainEqual({ body: "A folder with that name exists", type: "error" });
    expect(path()).toBe("/doc/d_1");
  });

  it("goes to the library once the folder exists", async () => {
    folders.create.mockResolvedValue({ folder_id: "f_1" });
    await createFolder("Plans");
    expect(toasts.shown).toEqual([]);
    expect(path()).toBe("/");
  });

});

describe("CommandPalette New document", () => {
  const command = (label: string) => [...host.querySelectorAll('[role="option"]')].find((el) => el.textContent?.startsWith(label));

  it("creates it without a title, which reads as Untitled until it has one", async () => {
    docs.create.mockResolvedValue({ doc_id: "d_9" });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    await click(command("New document"));
    expect(docs.create).toHaveBeenCalledWith("");
    expect(path()).toBe("/doc/d_9");
  });

  it("offers a guest nothing to create", async () => {
    workspaces.list.mockResolvedValue({ workspaces: [{ workspace_id: "w_1", role: "guest" }], active: "w_1" });
    await act(async () => root.unmount());
    ({ host, root } = mountInto());
    await mountPalette();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    for (const label of ["New document", "New database", "New folder", "Import from Markdown"]) expect(command(label)).toBeUndefined();
    expect(command("All documents")).toBeTruthy();
  });
});

const hit = (doc_id: string, title: string, snippet: string, doc_type: "prose" | "database" = "prose", sem_score = 0) => ({
  doc_id,
  title,
  doc_type,
  snippet,
  score: 1,
  sem_score,
  page_of: null,
  page_row: null,
  updated_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
});
/** Past both of the palette's search passes, with their responses settled. */
const debounce = () => act(async () => new Promise((r) => setTimeout(r, 500)));

async function search(text: string) {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
  const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await typeInto(input, text);
  await debounce();
  return input;
}

const options = () => [...host.querySelectorAll('[role="listbox"] [role="option"]')];

describe("CommandPalette dialog", () => {
  it("is named, and starts at the window's margin when 640px do not fit", async () => {
    await mountPalette();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    const dialog = document.querySelector("dialog[open]");
    expect(dialog?.getAttribute("aria-label")).toBe("Search documents or run a command");
    // Centred while it fits; at 360px wide, 50% - 320px would put its start off the left edge.
    expect(PALETTE_START).toBe("max(16px, calc(50% - 320px))");
    expect(dialog?.getAttribute("style")).toContain(PALETTE_START);
  });

  it("offers the keyboard shortcuts", async () => {
    await mountPalette();
    await search("shortcuts");
    expect(options().some((o) => o.textContent?.includes("Keyboard shortcuts"))).toBe(true);
  });
});

describe("CommandPalette document search", () => {
  it("says when each hit last changed, and which ones were found by meaning alone", async () => {
    docs.search.mockResolvedValue({
      results: [hit("d_1", "Notes", "It is ⟦cheap⟧ here.", "prose", 0.5), hit("d_2", "Shopping list", "Butter, flour, eggs.", "prose", 0.4)],
      degraded: false,
    });
    await search("cheap");
    const [words, meaning] = options();
    expect(words!.textContent).toContain("3d ago");
    expect(words!.textContent).not.toContain("Found by meaning");
    expect(meaning!.textContent).toContain("Found by meaning");
  });

  it("shows the passage that matched under each hit, and highlights the first hit", async () => {
    docs.search.mockResolvedValue({ results: [hit("d_9", "Start here", "Read this first. Find out ⟦where⟧ things live.")], degraded: false });
    const input = await search("where");
    const first = options()[0]!;
    expect(first.textContent).toContain("Start here");
    expect(first.querySelector("mark")?.textContent).toBe("where");
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(options().at(-1)?.textContent).toContain("Search all documents for “where”");
  });

  it("keeps a response overtaken by a newer query off the screen", async () => {
    let answerOld: (v: unknown) => void = () => {};
    docs.search.mockImplementation((q: string) =>
      q === "wher"
        ? new Promise((r) => (answerOld = r))
        : Promise.resolve({ results: [hit("d_new", "New hit", "⟦where⟧")], degraded: false }),
    );
    const input = await search("wher");
    await typeInto(input, "where");
    await debounce();
    await act(async () => answerOld({ results: [hit("d_old", "Old hit", "⟦wher⟧")], degraded: false }));
    expect(host.textContent).toContain("New hit");
    expect(host.textContent).not.toContain("Old hit");
  });

  it("leaves the Enter that picks an input method's candidate to it", async () => {
    docs.search.mockResolvedValue({ results: [hit("d_9", "Start here", "⟦where⟧")], degraded: false });
    const input = await search("where");
    // Safari's comes after compositionend, with isComposing false and the IME's keyCode 229.
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })));
    expect(path()).toBe("/doc/d_1");
    expect(options()[0]!.textContent).toContain("Start here");
  });

  it("searches all documents on ⌘Enter, whatever is highlighted", async () => {
    docs.search.mockResolvedValue({ results: [hit("d_9", "Start here", "⟦where⟧")], degraded: false });
    const input = await search("where");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(path()).toBe("/");
  });

  it("marks a database hit with the database icon, as Recent does", async () => {
    docs.search.mockResolvedValue({
      results: [hit("d_9", "Start here", "⟦where⟧ it is"), hit("d_db", "Vendors", "⟦where⟧ they are", "database")],
      degraded: false,
    });
    await search("where");
    expect(options()[0]?.querySelector("svg.lucide-file-text")).toBeTruthy();
    expect(options()[1]?.querySelector("svg.lucide-database")).toBeTruthy();
    expect(options()[1]?.querySelector("svg.lucide-file-text")).toBeNull();
  });

  it("opens a hit at the passage that matched", async () => {
    docs.search.mockResolvedValue({ results: [hit("d_9", "Start here", "Read this first. Find out ⟦where⟧ things live.")], degraded: false });
    await search("where");
    await click(options()[0]);
    expect(path()).toBe("/doc/d_9");
    expect(searchParam("hit")).toContain("Find out where things live.");
  });

  it("lands again on a hit in the document already open, though its link is unchanged", async () => {
    docs.search.mockResolvedValue({ results: [hit("d_1", "Start here", "Read this first. Find out ⟦where⟧ things live.")], degraded: false });
    await search("where");
    await click(options()[0]);
    const first = { path: path(), hit: searchParam("hit"), jump: jump() };
    expect(first.hit).toContain("Find out where things live.");
    expect(first.jump).toBeTruthy();
    await search("where");
    await click(options()[0]);
    expect({ path: path(), hit: searchParam("hit") }).toEqual({ path: first.path, hit: first.hit });
    expect(jump()).toBeTruthy();
    expect(jump()).not.toBe(first.jump);
  });

  it("opens a hit at the top when its title holds the query", async () => {
    docs.search.mockResolvedValue({ results: [hit("d_9", "Where things live", "Read this first. Find out ⟦where⟧ things live.")], degraded: false });
    await search("where");
    await click(options()[0]);
    expect(path()).toBe("/doc/d_9");
    expect(searchParam("hit")).toBeNull();
  });

  it("says a failed search failed, and searches again in place", async () => {
    docs.search.mockRejectedValue(new Error("down"));
    await search("where");
    expect(host.textContent).toContain("Couldn’t search documents.");
    docs.search.mockResolvedValue({ results: [hit("d_9", "Start here", "⟦where⟧")], degraded: false });
    await click(options().find((o) => o.textContent === "Search again"));
    await debounce();
    expect(host.textContent).toContain("Start here");
    expect(path()).toBe("/doc/d_1");
  });
});

describe("CommandPalette search passes", () => {
  it("shows keyword hits first, then lets the hybrid search replace them", async () => {
    docs.search.mockImplementation(async (_q: string, opts?: { keywordOnly?: boolean }) => ({
      results: opts?.keywordOnly ? [hit("d_kw", "Keyword hit", "⟦where⟧")] : [hit("d_sem", "Meaning hit", "close"), hit("d_kw", "Keyword hit", "⟦where⟧")],
      degraded: false,
    }));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    await typeInto(host.querySelector<HTMLInputElement>('input[role="combobox"]'), "where");
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    expect(docs.search.mock.calls).toEqual([["where", expect.objectContaining({ keywordOnly: true })]]);
    expect(options()[0]?.textContent).toContain("Keyword hit");
    await debounce();
    expect(options()[0]?.textContent).toContain("Meaning hit");
  });
});

describe("CommandPalette recent documents", () => {
  const summary = (doc_id: string, title: string) => ({ doc_id, title, doc_type: "prose", trashed: false, page_of: null });

  it("offers what was opened lately, newest first, leaving out the open document and any no longer readable", async () => {
    const { noteRecentDoc, recentDocIds } = await import("../../lib/recent-docs");
    for (const id of ["d_gone", "d_old", "d_1", "d_new"]) noteRecentDoc(null, id);
    docs.get.mockImplementation(async (id: string) => {
      if (id === "d_gone") throw Object.assign(new Error("not found"), { status: 404 });
      return summary(id, id === "d_new" ? "Newest" : "Older");
    });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    expect(docs.get.mock.calls.map((c) => c[0])).toEqual(["d_new", "d_old", "d_gone"]);
    expect(options().slice(0, 2).map((o) => o.textContent)).toEqual(["Newest", "Older"]);
    expect(recentDocIds(null)).not.toContain("d_gone");
    await act(async () => host.querySelector('input[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(path()).toBe("/doc/d_new");
  });
});
