import { describe, it, expect } from "vitest";
import { describeFilter } from "./filters.js";

describe("describeFilter", () => {
  const name = (id: string) => ({ c1: "Status", c2: "Due" })[id] ?? id;

  it("reads one condition, quoting text and leaving numbers bare", () => {
    expect(describeFilter({ column_id: "c1", op: "eq", value: "Done" }, name)).toBe("Status = 'Done'");
    expect(describeFilter({ column_id: "c2", op: "gte", value: 3 }, name)).toBe("Due ≥ 3");
  });

  it("says nothing of a value for the empty tests", () => {
    expect(describeFilter({ column_id: "c2", op: "not_empty" }, name)).toBe("Due is not empty");
  });

  it("joins a group with its operator and parenthesizes only what is nested", () => {
    const tree = { and: [{ column_id: "c1", op: "ne" as const, value: "Done" }, { or: [{ column_id: "c2", op: "not_empty" as const }, { column_id: "c2", op: "lt" as const, value: "2026-01-01" }] }] };
    expect(describeFilter(tree, name)).toBe("(Status ≠ 'Done' and (Due is not empty or Due < '2026-01-01'))");
  });

  it("names an unknown column by its id and drops empty groups", () => {
    expect(describeFilter({ column_id: "gone", op: "eq", value: "x" }, name)).toBe("gone = 'x'");
    expect(describeFilter({ and: [] }, name)).toBe("");
  });
});
