import { describe, expect, it } from "vitest";
import { CloseCode, Opcode } from "./opcodes.js";

/** Everything below this byte is reserved. */
const OPCODE_MIN = 0x20;

const entries = Object.entries(Opcode) as [string, number][];

describe("opcode table", () => {
  it("assigns every name a distinct value", () => {
    const byValue = new Map<number, string[]>();
    for (const [name, value] of entries) {
      byValue.set(value, [...(byValue.get(value) ?? []), name]);
    }
    const collisions = [...byValue.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([value, names]) => `0x${value.toString(16)}: ${names.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("keeps every opcode a single byte at or above the reserved floor", () => {
    for (const [name, value] of entries) {
      expect(Number.isInteger(value), `${name} must be an integer`).toBe(true);
      expect(value, `${name} must be >= OPCODE_MIN`).toBeGreaterThanOrEqual(OPCODE_MIN);
      expect(value, `${name} must fit in one byte`).toBeLessThanOrEqual(0xff);
    }
  });
});

describe("close codes", () => {
  it("are distinct and in the range kept for applications", () => {
    const codes = Object.values(CloseCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });
});
