import { describe, expect, it } from "vitest";
import { describeAclChange, describeGroupSync } from "./acl-diff.js";

describe("describeAclChange", () => {
  it("names who entered and who left, per tier", () => {
    const change = describeAclChange(
      { p: ["user:bob", "group:eng"], w: ["user:bob"], c: [] },
      { p: ["group:eng", "user:alice"], w: [], c: ["user:alice"] },
      false,
      false,
    );
    expect(change).toEqual({
      added: { p: ["user:alice"], w: [], c: ["user:alice"] },
      removed: { p: ["user:bob"], w: ["user:bob"], c: [] },
      inherits: { before: false, after: false },
    });
  });

  it("returns null when nobody moved — order and duplicates are not a change", () => {
    expect(
      describeAclChange(
        { p: ["user:bob", "user:alice"], w: [], c: [] },
        { p: ["user:alice", "user:bob", "user:bob"], w: [], c: [] },
        true,
        true,
      ),
    ).toBeNull();
  });

  it("records an inheritance flip even when no principal moves", () => {
    expect(describeAclChange({ p: ["user:bob"], w: [], c: [] }, { p: ["user:bob"], w: [], c: [] }, true, false)).toEqual({
      added: { p: [], w: [], c: [] },
      removed: { p: [], w: [], c: [] },
      inherits: { before: true, after: false },
    });
  });

  it("cuts an oversized list and keeps the true size beside it", () => {
    const many = Array.from({ length: 201 }, (_, i) => `user:u${i}`);
    const change = describeAclChange({ p: [], w: [], c: [] }, { p: many, w: [], c: [] }, false, false);
    expect(change?.added.p).toHaveLength(200);
    expect(change?.truncated).toEqual({
      added: { p: 201, w: 0, c: 0 },
      removed: { p: 0, w: 0, c: 0 },
    });
  });
});

describe("describeGroupSync", () => {
  it("names the members who joined and left", () => {
    expect(describeGroupSync(["user:alice", "user:bob"], ["user:alice", "user:carol"])).toEqual({
      added: ["user:carol"],
      removed: ["user:bob"],
      members: 2,
    });
  });

  it("treats a group that did not exist as empty", () => {
    expect(describeGroupSync(null, ["user:alice"])).toEqual({
      added: ["user:alice"],
      removed: [],
      members: 1,
    });
  });

  it("returns null for a re-sync of the same membership", () => {
    expect(describeGroupSync(["user:bob", "user:alice"], ["user:alice", "user:bob"])).toBeNull();
  });
});
