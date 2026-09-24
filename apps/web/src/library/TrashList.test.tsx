// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DocSummary } from "../api";
import type { LibraryRow } from "./DocTable";

const docs = vi.hoisted(() => ({ list: vi.fn(), trash: vi.fn(), remove: vi.fn() }));
const folders = vi.hoisted(() => ({ list: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type: string }> }));

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Docs: docs,
  Folders: folders,
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type: string }) => toasts.shown.push(t),
}));
// The table stands in as one row of buttons per row action.
vi.mock("./DocTable", async (orig) => ({
  ...(await orig<typeof import("./DocTable")>()),
  DocTable: ({ rows, rowActions }: { rows: LibraryRow[]; rowActions: (row: LibraryRow) => Array<Record<string, unknown>> }) => (
    <ul>
      {rows.map((row) => (
        <li key={row.id}>
          {rowActions(row).map((item) => (
            <button key={String(item.label)} data-row={row.id} onClick={item.onClick as () => void}>
              {String(item.label)}
            </button>
          ))}
        </li>
      ))}
    </ul>
  ),
}));

const { TrashList } = await import("./TrashList");

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
  owner: "user:u_2",
  doc_type: "prose",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  trashed: true,
  trashed_at: "2026-09-10T00:00:00.000Z",
  parent_id: null,
  locked: false,
  search_hidden: false,
  agent_mode: "review",
  page_of: null,
  page_row: null,
};

let host: HTMLDivElement;
let root: Root;

const rowButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button[data-row]")].find((b) => b.textContent === label);
const dialogButton = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find((b) => b.textContent === label);

async function click(el: HTMLElement | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toasts.shown = [];
  docs.list.mockResolvedValue({ docs: [DOC] });
  folders.list.mockResolvedValue({ folders: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<TrashList />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("TrashList", () => {
  it("shows the refusal and brings the row back when a restore fails", async () => {
    docs.trash.mockRejectedValue(new Error("The folder it was in is gone"));
    await click(rowButton("Restore"));
    expect(docs.trash).toHaveBeenCalledWith(DOC.doc_id, false);
    expect(toasts.shown).toEqual([{ body: "The folder it was in is gone", type: "error" }]);
    expect(docs.list).toHaveBeenCalledTimes(2);
    expect(rowButton("Restore")).toBeTruthy();
  });

  it("removes the row without a message once it is restored", async () => {
    docs.trash.mockResolvedValue({});
    await click(rowButton("Restore"));
    expect(toasts.shown).toEqual([]);
    expect(rowButton("Restore")).toBeUndefined();
  });

  it("shows the refusal and brings the row back when Delete forever is refused", async () => {
    docs.remove.mockRejectedValue(new Error("only the owner or a workspace admin can delete"));
    await click(rowButton("Delete forever"));
    await click(dialogButton("Delete forever"));
    expect(docs.remove).toHaveBeenCalledWith(DOC.doc_id);
    expect(toasts.shown).toEqual([{ body: "only the owner or a workspace admin can delete", type: "error" }]);
    expect(docs.list).toHaveBeenCalledTimes(2);
    expect(rowButton("Delete forever")).toBeTruthy();
  });
});
