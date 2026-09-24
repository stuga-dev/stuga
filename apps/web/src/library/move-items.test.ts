import { describe, expect, it } from "vitest";
import { moveReport, movableTo, trashReport, type LibraryDragItem } from "./move-items";

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

describe("moveReport", () => {
  it("says nothing when one item moved, and counts a successful batch", () => {
    expect(moveReport(1, [])).toBeNull();
    expect(moveReport(3, [])).toEqual({ body: "Moved 3 items.", type: "info" });
  });

  it("quotes the server's reason when nothing moved", () => {
    expect(moveReport(2, [new Error("locked"), new Error("gone")])).toEqual({ body: "locked", type: "error" });
    expect(moveReport(1, ["?"])).toEqual({ body: "Couldn’t move those items.", type: "error" });
  });

  it("says how many landed on a partial failure", () => {
    expect(moveReport(3, [new Error("x")])).toEqual({ body: "Moved 2 of 3; 1 couldn’t be moved.", type: "error" });
  });
});

describe("trashReport", () => {
  it("counts a full and a partial batch", () => {
    expect(trashReport(2, 0)).toEqual({ body: "Moved 2 to Trash.", type: "info" });
    expect(trashReport(3, 1)).toEqual({ body: "2 of 3 moved to Trash.", type: "error" });
  });
});
