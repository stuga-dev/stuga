/** The app's toast defaults: every toast hides itself, and a plain message raised again replaces itself. */
import { describe, it, expect } from "vitest";
import { ERROR_HIDE_MS, INFO_HIDE_MS, withToastDefaults } from "./toast-defaults";

describe("withToastDefaults", () => {
  it("hides an error after a while, as it does an info toast", () => {
    expect(withToastDefaults({ body: "Enter a date as YYYY-MM-DD.", type: "error" })).toMatchObject({
      isAutoHide: true,
      autoHideDuration: ERROR_HIDE_MS,
    });
    expect(withToastDefaults({ body: "Link copied" })).toMatchObject({ isAutoHide: true, autoHideDuration: INFO_HIDE_MS });
  });

  it("gives the same message the same key, so a repeat replaces the one showing", () => {
    const a = withToastDefaults({ body: "Enter a date as YYYY-MM-DD.", type: "error" });
    const b = withToastDefaults({ body: "Enter a date as YYYY-MM-DD.", type: "error" });
    expect(a.uniqueID).toBeDefined();
    expect(a.uniqueID).toBe(b.uniqueID);
    expect(withToastDefaults({ body: "Link copied" }).uniqueID).not.toBe(a.uniqueID);
  });

  it("leaves a toast with a control its own, since its Undo acts on one moment", () => {
    expect(withToastDefaults({ body: "Moved to Trash", endContent: "Undo" }).uniqueID).toBeUndefined();
  });

  it("lets the caller's options win", () => {
    expect(
      withToastDefaults({ body: "Rejected 1 change.", autoHideDuration: 8000, uniqueID: "run-decision:r1", isAutoHide: false }),
    ).toMatchObject({ autoHideDuration: 8000, uniqueID: "run-decision:r1", isAutoHide: false });
  });
});
