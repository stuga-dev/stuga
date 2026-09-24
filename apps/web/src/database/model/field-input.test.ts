import { describe, expect, it } from "vitest";
import { parseFieldInput } from "./field-input";

describe("parseFieldInput", () => {
  it("reads empty input as null", () => {
    expect(parseFieldInput("text", "")).toBeNull();
    expect(parseFieldInput("number", "  ")).toBeNull();
  });

  it("parses numbers and passes NaN through for the validator", () => {
    expect(parseFieldInput("number", " 4.5 ")).toBe(4.5);
    expect(parseFieldInput("number", "abc")).toBeNaN();
  });

  it("keeps text as typed, surrounding spaces included", () => {
    expect(parseFieldInput("text", " hi ")).toBe(" hi ");
    expect(parseFieldInput("date", "2026-09-16")).toBe("2026-09-16");
  });
});
