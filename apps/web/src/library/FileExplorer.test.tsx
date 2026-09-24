// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import type { DocSummary, Folder } from "../api";
import type { LibraryRow } from "./DocTable";

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
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));
/** A mouse-driven window this many CSS px wide, for ui/narrow.ts and Astryx AppShell's breakpoints. */
const viewport = vi.hoisted(() => ({ width: 1280 }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Folders: folders,
  Collections: collections,
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));
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

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

const DOC: DocSummary = {
  doc_id: "d_1",
  title: "Plan",
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
const onCreateFolder = vi.fn();
const onImport = vi.fn();

const buttons = () => [...host.querySelectorAll("button")];
const button = (label: string, row?: string) =>
  buttons().find((b) => b.textContent === label && (row === undefined || b.dataset.row === row));
/** The rail's title heading. */
const railTitle = () => host.querySelector(".doc-detail h2")?.textContent;

async function click(el: HTMLElement | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function typeInto(labelText: string, value: string) {
  const input = [...host.querySelectorAll("input")].find(
    (i) => (host.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").includes(labelText),
  );
  expect(input, `no input labelled ${labelText}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function rename(to: string) {
  await click(button("Rename…", DOC.doc_id));
  await typeInto("Document title", to);
  await click(button("Rename"));
}

async function renderExplorer() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AppShell sideNav={<nav aria-label="Library">Library</nav>} contentPadding={0}>
          <FileExplorer
            refreshKey={0}
            movedAway={0}
            path={[]}
            selectedDocId={DOC.doc_id}
            onPathChange={() => {}}
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
            onCreateFolder={onCreateFolder}
            onImport={onImport}
          />
        </AppShell>
      </MemoryRouter>,
    );
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toasts.shown = [];
  docs.list.mockResolvedValue({ docs: [DOC] });
  docs.get.mockResolvedValue(DOC);
  folders.list.mockResolvedValue({ folders: [FOLDER] });
  collections.list.mockResolvedValue({ collections: [] });
  viewport.width = 1280;
  onCreateDoc.mockReset();
  onCreateDatabase.mockReset();
  onCreateFolder.mockReset();
  onImport.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await renderExplorer();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("FileExplorer row actions", () => {
  it("uses a page heading at the top level and labels the local filter distinctly", () => {
    expect(host.querySelector(".explorer-heading h1")?.textContent).toBe("All documents");
    expect(host.querySelector('nav[aria-label="Folder path"]')).toBeNull();
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
    root = createRoot(host);
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

  it("clears the selection once the document is in Trash", async () => {
    docs.trash.mockResolvedValue({});
    await click(button("Move to Trash", DOC.doc_id));
    expect(toasts.shown).toEqual([]);
    expect(onSelectDoc).toHaveBeenCalledWith(null);
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
