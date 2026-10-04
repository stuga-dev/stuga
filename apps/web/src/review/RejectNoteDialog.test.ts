import { describe, expect, it } from "vitest";
import { composerPosition } from "./RejectNoteDialog";

const VIEW = { width: 1200, height: 800 };

describe("where the Request changes composer floats", () => {
  it("sits beside its button when there is room, leaving the rows under it in reach", () => {
    expect(composerPosition({ top: 300, bottom: 324, left: 600, right: 720 }, VIEW)).toEqual({ top: 296, left: 728 });
  });

  it("drops under its button, kept on screen, at the window's right edge", () => {
    expect(composerPosition({ top: 40, bottom: 64, left: 1100, right: 1190 }, VIEW)).toEqual({ top: 70, left: 892 });
  });

  it("never runs off the bottom or the top", () => {
    expect(composerPosition({ top: 790, bottom: 800, left: 100, right: 200 }, VIEW).top).toBe(600);
    expect(composerPosition({ top: 0, bottom: 10, left: 100, right: 200 }, VIEW).top).toBe(8);
  });
});
