// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import type { DocSummary, Folder } from "../api";
import type { LibraryRow } from "./DocTable";
import { toastBodies, toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

const docs = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  rename: vi.fn(),
  trash: vi.fn(),
  move: vi.fn(),
  setState: vi.fn(),
  instructions: vi.fn(),
}));
const folders = vi.hoisted(() => ({
  list: vi.fn(),
  ancestors: vi.fn(),
  rename: vi.fn(),
  contents: vi.fn(),
  remove: vi.fn(),
  move: vi.fn(),
  instructions: vi.fn(),
  setInstructions: vi.fn(),
}));
const collections = vi.hoisted(() => ({ list: vi.fn(), addItems: vi.fn(), create: vi.fn() }));
/** A mouse-driven window this many CSS px wide, for ui/narrow.ts and Astryx AppShell's breakpoints. */
const viewport = vi.hoisted(() => ({ width: 1280 }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Folders: folders,
  Collections: collections,
}));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
vi.mock("../state/favorites", () => ({
  useFavorites: () => ({ ids: new Set<string>(), toggle: vi.fn(async () => true) }),
}));
vi.mock("../state/identity", async (orig) => ({
  ...(await orig<typeof import("../state/identity")>()),
  useUserNames: () => 0,
}));
// The table stands in as one row of buttons per row action, or its empty state.
vi.mock("./DocTable", async (orig) => ({
  ...(await orig<typeof import("./DocTable")>()),
  DocTable: ({
    rows,
    rowActions,
    emptyState,
  }: {
    rows: LibraryRow[];
    rowActions: (row: LibraryRow) => Array<Record<string, unknown>>;
    emptyState: React.ReactNode;
  }) =>
    rows.length === 0 ? (
      emptyState
    ) : (
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {rowActions(row)
              .flatMap((item) => (Array.isArray(item.items) ? (item.items as Array<Record<string, unknown>>) : [item]))
              .map((item) => (
                <button key={String(item.label)} data-row={row.id} onClick={item.onClick as () => void}>
                  {String(item.label)}
                </button>
              ))}
          </li>
        ))}
      </ul>
    ),
}));

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    // Width terms compare; any other feature, such as a coarse pointer, does not match.
    matches: query.split(" and ").every((term) => {
      const max = /^\(max-width: (\d+)px\)$/.exec(term.trim());
      const below = /^\(width < (\d+)px\)$/.exec(term.trim());
      return max ? viewport.width <= Number(max[1]) : below ? viewport.width < Number(below[1]) : false;
    }),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

const { FileExplorer } = await import("./FileExplorer");

const DOC: DocSummary = {
  doc_id: "d_1",
  title: "Plan",
  title_source: "user",
  owner: "user:u_1",
  doc_type: "prose",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  trashed: false,
  trashed_at: null,
  parent_id: null,
  locked: false,
  search_hidden: false,
  agent_mode: "review",
  page_of: null,
  page_row: null,
};

const FOLDER: Folder = {
  folder_id: "f_1",
  parent_id: null,
  title: "Contracts",
  owner: "user:u_1",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;
const onSelectDoc = vi.fn();
const onCreateDoc = vi.fn();
const onCreateDatabase = vi.fn();
const onCreateDatabaseFromFile = vi.fn();
const onCreateFolder = vi.fn();
const onImport = vi.fn();
const onSearch = vi.fn();

const buttons = () => [...host.querySelectorAll("button")];
const button = (label: string, row?: string) =>
  buttons().find((b) => b.textContent === label && (row === undefined || b.dataset.row === row));
/** The rail's title heading. */
const railTitle = () => host.querySelector(".doc-detail h2")?.textContent;

async function click(el: HTMLElement | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function type(labelText: string, value: string) {
  const input = [...host.querySelectorAll("input")].find(
    (i) => (host.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").includes(labelText),
  );
  expect(input, `no input labelled ${labelText}`).toBeTruthy();
  await typeInto(input, value);
}

async function rename(to: string) {
  await click(button("Rename…", DOC.doc_id));
  await type("Document title", to);
  await click(button("Rename"));
}

async function renderExplorer(
  path: string[] = [],
  onPathChange: (path: string[]) => void = () => {},
  { canCreate = true, refreshKey = 0 }: { canCreate?: boolean; refreshKey?: number } = {},
) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AppShell sideNav={<nav aria-label="Library">Library</nav>} contentPadding={0}>
          <FileExplorer
            refreshKey={refreshKey}
            movedAway={0}
            path={path}
            selectedDocId={DOC.doc_id}
            onPathChange={onPathChange}
            onSelectDoc={onSelectDoc}
            sort={{ key: "updated_at", direction: "descending" }}
            onSortChange={() => {}}
            onMoveDoc={() => {}}
            onMoveFolder={() => {}}
            onMoveMany={() => {}}
            onShareFolder={() => {}}
            onShareDoc={() => {}}
            onCreateDoc={onCreateDoc}
            onCreateDatabase={onCreateDatabase}
            onCreateDatabaseFromFile={onCreateDatabaseFromFile}
            onCreateFolder={onCreateFolder}
            onImport={onImport}
            canCreate={canCreate}
            onSearch={onSearch}
          />
        </AppShell>
      </MemoryRouter>,
    );
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  toasts.shown = [];
  docs.list.mockResolvedValue({ docs: [DOC] });
  docs.get.mockResolvedValue(DOC);
  folders.list.mockResolvedValue({ folders: [FOLDER] });
  collections.list.mockResolvedValue({ collections: [] });
  viewport.width = 1280;
  onCreateDoc.mockReset();
  onCreateDatabase.mockReset();
  onCreateDatabaseFromFile.mockReset();
  onCreateFolder.mockReset();
  onImport.mockReset();
  ({ host, root } = mountInto());
  await renderExplorer();
});

describe("FileExplorer row actions", () => {
  it("uses a page heading at the top level and labels the local filter distinctly", () => {
    expect(host.querySelector(".explorer-heading h1")?.textContent).toBe("All documents");
    // The trail is there at the top level too, so opening a folder does not move the heading.
    const crumbs = [...host.querySelectorAll('nav[aria-label="Folder path"] li')];
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]?.textContent).toContain("All documents");
    expect(crumbs[0]?.querySelector('[aria-current="page"]')).not.toBeNull();
    expect(host.querySelector('input[placeholder="Filter this list…"]')).not.toBeNull();
  });

  it("keeps a resizable detail rail beside the table on a wide screen", async () => {
    expect((host.querySelector(".library-detail") as HTMLElement).style.width).toBe("320px");
    expect(host.querySelector('[aria-label="Resize details"]')).not.toBeNull();
  });

  it("lays the details over the table in a compact window, leaving the table in place", async () => {
    viewport.width = 900;
    await renderExplorer();
    expect(railTitle()).toBe("Plan");
    expect(host.querySelectorAll(".explorer-main li")).toHaveLength(2);
    // Only the stylesheet places the overlay: no state on the body takes the table away.
    expect(host.querySelector(".explorer-body")?.getAttributeNames()).toEqual(["class"]);
    expect((host.querySelector(".library-detail") as HTMLElement).style.width).toBe("");
    expect(host.querySelector('[aria-label="Resize details"]')).toBeNull();
  });

  it("shows no details on a phone, where a tap opens the document and details would cover the list", async () => {
    viewport.width = 400;
    await renderExplorer();
    expect(host.querySelector(".library-detail")).toBeNull();
    expect(host.querySelectorAll(".explorer-main li")).toHaveLength(2);
  });

  it.each([700, 1280])("offers one New in an empty library at %ipx", async (width) => {
    docs.list.mockResolvedValue({ docs: [] });
    folders.list.mockResolvedValue({ folders: [] });
    viewport.width = width;
    // A fresh mount, so the listing loads again.
    await act(async () => root.unmount());
    ({ host, root } = mountInto());
    await renderExplorer();
    expect(host.textContent).toContain("No documents yet");
    expect(buttons().filter((b) => b.textContent === "New")).toHaveLength(1);
  });

  it.each([
    [640, "hidden", "shown"],
    [767, "hidden", "shown"],
    [768, "visible", "absent"],
    [1280, "visible", "absent"],
  ])("at %ipx the side nav is %s, so New beside the heading is %s", async (width, _, inline) => {
    viewport.width = width;
    await renderExplorer();
    expect(host.querySelector(".explorer-heading button")?.textContent === "New").toBe(inline === "shown");
  });

  it("keeps the full New menu available when the sidebar is hidden", async () => {
    viewport.width = 700;
    await renderExplorer();
    for (const [label, callback] of [
      ["New document", onCreateDoc],
      ["New database", onCreateDatabase],
      ["New folder", onCreateFolder],
      ["Import from Markdown", onImport],
    ] as const) {
      await click(button("New"));
      const action = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent?.includes(label));
      await click(action);
      expect(callback).toHaveBeenCalledOnce();
    }
  });

  it("makes a database from a spreadsheet file chosen in the New menu", async () => {
    viewport.width = 700;
    await renderExplorer();
    const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
    const picked = vi.spyOn(input, "click").mockImplementation(() => {});
    await click(button("New"));
    await click([...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent === "New database from CSV…"));
    expect(picked).toHaveBeenCalledOnce();

    const file = new File(["Name,Price\nBread,4\n"], "Prices.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onCreateDatabaseFromFile).toHaveBeenCalledWith(file);
    expect(onCreateDatabase).not.toHaveBeenCalled();
  });

  it("shows the refusal and keeps the old title when a rename fails", async () => {
    docs.rename.mockRejectedValue(new Error("That title is taken"));
    expect(railTitle()).toBe("Plan");
    await rename("Budget");
    expect(docs.rename).toHaveBeenCalledWith(DOC.doc_id, "Budget");
    expect(toasts.shown).toContainEqual({ body: "That title is taken", type: "error" });
    expect(railTitle()).toBe("Plan");
  });

  it("puts the new title in the rail once the rename succeeds", async () => {
    docs.rename.mockResolvedValue({});
    // The list read after the rename has it too.
    docs.list.mockResolvedValue({ docs: [{ ...DOC, title: "Budget" }] });
    await rename("Budget");
    expect(toasts.shown).toEqual([]);
    expect(railTitle()).toBe("Budget");
  });

  it("shows the refusal and keeps the selection when Move to Trash fails", async () => {
    docs.trash.mockRejectedValue(new Error("The document is locked"));
    await click(button("Move to Trash", DOC.doc_id));
    expect(docs.trash).toHaveBeenCalledWith(DOC.doc_id, true);
    expect(toasts.shown).toContainEqual({ body: "The document is locked", type: "error" });
    expect(onSelectDoc).not.toHaveBeenCalled();
    expect(railTitle()).toBe("Plan");
  });

  it("clears the selection once the document is in Trash, and Undo brings it back", async () => {
    docs.trash.mockResolvedValue({});
    await click(button("Move to Trash", DOC.doc_id));
    expect(toastBodies()).toEqual(["Moved “Plan” to Trash."]);
    expect(onSelectDoc).toHaveBeenCalledWith(null);
    const { host: toastHost, root: toastRoot } = mountInto();
    await act(async () => toastRoot.render(toasts.shown[0]!.endContent as React.ReactNode));
    await click(toastHost.querySelector("button") ?? undefined);
    expect(docs.trash).toHaveBeenLastCalledWith(DOC.doc_id, false);
    expect(toastBodies().at(-1)).toBe("Restored “Plan”.");
  });

  it("asks before letting AI edits apply directly, and changes nothing on Cancel", async () => {
    const inDialog = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button, [role="dialog"] button')].find((b) => b.textContent === label);
    await click(button("Let AI edits apply directly", DOC.doc_id));
    expect(document.body.textContent).toContain("Edits from any AI will change this document without asking first.");
    expect(docs.setState).not.toHaveBeenCalled();
    await click(inDialog("Cancel"));
    expect(docs.setState).not.toHaveBeenCalled();

    docs.setState.mockResolvedValue({ ...DOC, agent_mode: "auto" });
    await click(button("Let AI edits apply directly", DOC.doc_id));
    await click(inDialog("Let AI edits apply directly"));
    expect(docs.setState).toHaveBeenCalledExactlyOnceWith(DOC.doc_id, { agent_mode: "auto" });
  });

  it("opens the instructions for agents from a folder row and from a document row", async () => {
    const answer = { own: "", inherited: [], can_edit: false };
    folders.instructions.mockResolvedValue(answer);
    docs.instructions.mockResolvedValue(answer);
    await click(button("Instructions for agents…", FOLDER.folder_id));
    expect(folders.instructions).toHaveBeenCalledWith(FOLDER.folder_id);
    await click(button("Instructions for agents…", DOC.doc_id));
    expect(docs.instructions).toHaveBeenCalledWith(DOC.doc_id);
  });
});

describe("FileExplorer breadcrumb", () => {
  /** An enclosing folder the caller cannot read, as the ancestors call redacts it. */
  const hidden = (id: string, parent: string | null) => ({
    folder_id: id,
    parent_id: parent,
    title: null,
    owner: null,
    created_at: null,
    updated_at: null,
  });
  const crumbs = () => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Folder path"] li')];

  it("shows a folder the caller cannot read as a named place in the chain, not somewhere to go", async () => {
    folders.ancestors.mockResolvedValue({ ancestors: [hidden("f_a", null), hidden("f_b", "f_a"), { ...FOLDER, parent_id: "f_b" }] });
    const onPathChange = vi.fn();
    await renderExplorer(["f_a", "f_b", FOLDER.folder_id], onPathChange);
    const [all, a, b, own] = crumbs();
    expect(all?.querySelector("button")?.textContent).toBe("All documents");
    for (const crumb of [a, b]) {
      expect(crumb?.querySelector("button, a")).toBeNull();
      // A screen reader hears the words, not the glyph.
      const glyph = [...(crumb?.querySelectorAll<HTMLElement>("*") ?? [])].find((el) => el.textContent === "…");
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(crumb?.textContent).toContain("Folder you can’t open");
      await click(glyph);
    }
    expect(onPathChange).not.toHaveBeenCalled();
    expect(own?.querySelector('[aria-current="page"]')?.textContent).toBe("Contracts");
  });

  it("keeps a crumb whose title did not load as a way back to that folder", async () => {
    folders.ancestors.mockRejectedValue(new Error("offline"));
    const onPathChange = vi.fn();
    await renderExplorer(["f_a", FOLDER.folder_id], onPathChange);
    const back = crumbs()[1]?.querySelector("button");
    expect(back?.textContent).toBe("…");
    await click(back ?? undefined);
    expect(onPathChange).toHaveBeenCalledWith(["f_a"]);
  });
});

describe("FileExplorer for a guest", () => {
  it("offers nothing to create, and an empty library says nothing has been shared yet", async () => {
    docs.list.mockResolvedValue({ docs: [] });
    folders.list.mockResolvedValue({ folders: [] });
    await act(async () => root.unmount());
    ({ host, root } = mountInto());
    await renderExplorer([], () => {}, { canCreate: false });
    expect(host.textContent).toContain("Nothing shared with you yet");
    expect(host.textContent).not.toContain("No documents yet");
    expect(buttons().some((b) => b.textContent === "New" || b.textContent === "Import from Markdown")).toBe(false);
  });

  it("offers no collections, which a guest cannot make", async () => {
    expect(button("New collection…", DOC.doc_id)).toBeTruthy();
    await renderExplorer([], () => {}, { canCreate: false });
    expect(button("Rename…", DOC.doc_id)).toBeTruthy();
    expect(button("New collection…", DOC.doc_id)).toBeUndefined();
  });
});

describe("FileExplorer filter", () => {
  const filter = () => host.querySelector<HTMLInputElement>('input[placeholder="Filter this list…"]')!;

  it("offers a search of every folder when the filter finds nothing here", async () => {
    await typeInto(filter(), "Shop opening");
    expect(host.textContent).toContain("The filter checks this list only.");
    await click(button("Search for “Shop opening”"));
    expect(onSearch).toHaveBeenCalledWith("Shop opening");
  });

  it("starts empty in the folder the person opens", async () => {
    await typeInto(filter(), "Contracts");
    await renderExplorer([FOLDER.folder_id]);
    expect(filter().value).toBe("");
  });
});

describe("FileExplorer refresh", () => {
  it("reads the folder again without the loading skeleton, keeping the rows meanwhile", async () => {
    let answer!: (r: { docs: DocSummary[] }) => void;
    docs.list.mockReturnValueOnce(new Promise((r) => (answer = r)));
    await renderExplorer([], () => {}, { refreshKey: 1 });
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(button("Move to Trash", DOC.doc_id)).toBeTruthy();
    await act(async () => answer({ docs: [{ ...DOC, doc_id: "d_2", title: "Budget" }] }));
    expect(button("Move to Trash", DOC.doc_id)).toBeUndefined();
    expect(button("Move to Trash", "d_2")).toBeTruthy();
  });

  it("keeps the rows on screen when a re-read fails", async () => {
    docs.list.mockRejectedValueOnce(new Error("offline"));
    await renderExplorer([], () => {}, { refreshKey: 1 });
    expect(host.textContent).not.toContain("Couldn’t load");
    expect(button("Move to Trash", DOC.doc_id)).toBeTruthy();
  });
});
