// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { mountInto } from "../test/form-input";
import type { ToastOptions } from "@astryxdesign/core/Toast";

const docs = vi.hoisted(() => ({ move: vi.fn(), trash: vi.fn() }));
const folders = vi.hoisted(() => ({ move: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Docs: docs, Folders: folders }));

const { accessGains, moveAndReport, movableTo, trashAndReport } = await import("./move-items");
type LibraryDragItem = import("./move-items").LibraryDragItem;

const doc = (id: string, parentId: string | null): LibraryDragItem => ({ kind: "doc", id, title: id, parentId });
const folder = (id: string, parentId: string | null): LibraryDragItem => ({ kind: "folder", id, title: id, parentId });

describe("movableTo", () => {
  it("keeps items that would change folder", () => {
    expect(movableTo([doc("d1", "f1"), folder("f2", "f1")], null, []).map((i) => i.id)).toEqual(["d1", "f2"]);
  });

  it("drops items already in the destination", () => {
    expect(movableTo([doc("d1", "f1"), doc("d2", null)], "f1", [])).toEqual([doc("d2", null)]);
  });

  it("never moves a folder onto itself or into its own subtree", () => {
    expect(movableTo([folder("f2", "f1")], "f2", ["f1"])).toEqual([]);
    expect(movableTo([folder("f1", null)], "f3", ["f1", "f2"])).toEqual([]);
  });

  it("moves a document into a nested folder", () => {
    expect(movableTo([doc("d1", null)], "f3", ["f1", "f2"])).toEqual([doc("d1", null)]);
  });
});

let shown: ToastOptions[] = [];
const toast = (t: ToastOptions) => void shown.push(t);
const bodies = () => shown.map((t) => t.body);
const after = vi.fn();

/** Press the Undo a toast carries. */
async function undo(t: ToastOptions | undefined) {
  const { host, root } = mountInto();
  await act(async () => root.render(t?.endContent as ReactNode));
  await act(async () => host.querySelector("button")!.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  shown = [];
});

describe("accessGains", () => {
  // The document Sofia may view; the folder where she, and everyone, may edit.
  const salaries = { acl_principals: ["user:owner", "user:sofia"], acl_writers: ["user:owner"], inherits: true };
  const staffRoom = { acl_principals: ["user:owner", "user:sofia", "org:w"], acl_writers: ["user:owner", "user:sofia"] };

  it("names who could read or edit more after the move", () => {
    expect(accessGains(salaries, staffRoom)).toEqual([
      { principal: "user:sofia", role: "editor" },
      { principal: "org:w", role: "viewer" },
    ]);
  });

  it("finds nobody when the folder reaches no further", () => {
    expect(accessGains(salaries, { acl_principals: ["user:owner"], acl_writers: ["user:owner"] })).toEqual([]);
  });

  it("finds nobody for an item that does not inherit", () => {
    expect(accessGains({ ...salaries, inherits: false }, staffRoom)).toEqual([]);
  });
});

describe("moveAndReport", () => {
  it("names where the items went, and Undo puts each back where it was", async () => {
    docs.move.mockResolvedValue({});
    folders.move.mockResolvedValue({});
    await moveAndReport([doc("d1", null), folder("f2", "f9")], { id: "f1", title: "Recipes" }, toast, after);
    expect(docs.move).toHaveBeenCalledWith("d1", "f1");
    expect(folders.move).toHaveBeenCalledWith("f2", "f1");
    expect(bodies()).toEqual(["Moved 2 items to “Recipes”."]);
    expect(after).toHaveBeenCalledTimes(1);
    await undo(shown[0]);
    expect(docs.move).toHaveBeenLastCalledWith("d1", null);
    expect(folders.move).toHaveBeenLastCalledWith("f2", "f9");
    expect(bodies().at(-1)).toBe("Moved 2 items back.");
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("names one item's destination without a count", async () => {
    docs.move.mockResolvedValue({});
    await moveAndReport([doc("d1", "f1")], { id: null, title: "All documents" }, toast, after);
    expect(bodies()).toEqual(["Moved to “All documents”."]);
  });

  it("quotes the server's reason when nothing moved, and offers no Undo", async () => {
    docs.move.mockRejectedValue(new Error("locked"));
    await moveAndReport([doc("d1", null), doc("d2", null)], { id: "f1", title: "Recipes" }, toast, after);
    expect(shown).toEqual([{ body: "locked", type: "error" }]);
  });

  it("says how many landed on a partial failure", async () => {
    docs.move.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({});
    await moveAndReport([doc("d1", null), doc("d2", null), doc("d3", null)], { id: "f1", title: "Recipes" }, toast, after);
    expect(shown).toEqual([{ body: "Moved 2 of 3; 1 couldn’t be moved.", type: "error" }]);
  });
});

describe("trashAndReport", () => {
  it("names one document, and Undo restores it", async () => {
    docs.trash.mockResolvedValue({});
    const gone = await trashAndReport([{ id: "d1", title: "" }], toast, after);
    expect(gone).toEqual(new Set(["d1"]));
    expect(bodies()).toEqual(["Moved “Untitled” to Trash."]);
    await undo(shown[0]);
    expect(docs.trash).toHaveBeenLastCalledWith("d1", false);
    expect(bodies().at(-1)).toBe("Restored “Untitled”.");
  });

  it("counts a batch, and says how many went when some are refused", async () => {
    docs.trash.mockResolvedValue({});
    await trashAndReport([{ id: "d1", title: "A" }, { id: "d2", title: "B" }], toast, after);
    expect(bodies()).toEqual(["Moved 2 to Trash."]);
    shown = [];
    docs.trash.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce({});
    const gone = await trashAndReport([{ id: "d1", title: "A" }, { id: "d2", title: "B" }, { id: "d3", title: "C" }], toast, after);
    expect(gone).toEqual(new Set(["d1", "d3"]));
    expect(shown).toEqual([{ body: "2 of 3 moved to Trash.", type: "error" }]);
  });

  it("quotes a single refusal", async () => {
    docs.trash.mockRejectedValue(new Error("The document is locked"));
    expect(await trashAndReport([{ id: "d1", title: "Plan" }], toast, after)).toEqual(new Set());
    expect(shown).toEqual([{ body: "The document is locked", type: "error" }]);
  });
});
