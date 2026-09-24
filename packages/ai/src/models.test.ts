import { describe, it, expect } from "vitest";
import { resolveModel } from "./models.js";
import { CFG } from "./test-helpers.js";

describe("resolveModel", () => {
  it("maps auto, empty and missing to the configured default", () => {
    expect(resolveModel(CFG, "auto")).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG, "")).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG, "  ")).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG, null)).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG)).toBe(CFG.chat.defaultModel);
  });

  it("passes any other id through verbatim; endpoint routing is streamTurn's job", () => {
    expect(resolveModel(CFG, "sonnet")).toBe("sonnet");
    expect(resolveModel(CFG, "claude-opus-4-1")).toBe("claude-opus-4-1");
  });
});
