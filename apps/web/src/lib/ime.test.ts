// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isComposingKey } from "./ime";

describe("isComposingKey", () => {
  it("reads a key mid-composition as the input method's", () => {
    expect(isComposingKey(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(true);
  });

  it("reads Safari's candidate-picking Enter, after compositionend, as the input method's too", () => {
    expect(isComposingKey(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229 }))).toBe(true);
  });

  it("leaves a plain Enter to the field", () => {
    expect(isComposingKey(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13 }))).toBe(false);
  });

  it("reads a React event by its native one", () => {
    const nativeEvent = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229 });
    expect(isComposingKey({ nativeEvent } as unknown as Parameters<typeof isComposingKey>[0])).toBe(true);
  });
});
