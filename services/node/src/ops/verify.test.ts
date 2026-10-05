import { describe, expect, it } from "vitest";
import { exitCodeOf } from "./outcome.js";
import { checkSameExtensions } from "./verify.js";

const BACKUP = { plpgsql: "1.0", btree_gin: "1.3", pg_search: "0.21.4", vector: "0.8.1" };

function refusal(live: Record<string, string>): unknown {
  try {
    checkSameExtensions(new Map(Object.entries(live)), BACKUP);
    return null;
  } catch (err) {
    return err;
  }
}

describe("checkSameExtensions", () => {
  it("passes the backup's own extensions", () => {
    expect(refusal(BACKUP)).toBeNull();
  });

  it("refuses an extension both hold at another version", () => {
    const err = refusal({ ...BACKUP, vector: "0.9.0" });
    expect(exitCodeOf(err)).toBe(2);
    expect((err as Error).message).toBe(
      "the current data has vector 0.9.0 and this backup vector 0.8.1: going back across an extension update is not supported. Nothing was changed.",
    );
  });

  it("passes an extension only one side holds: the older build never opens it, or the dump brings it back", () => {
    expect(refusal({ ...BACKUP, unaccent: "1.1" })).toBeNull();
    const { btree_gin: _dropped, ...live } = BACKUP;
    expect(refusal(live)).toBeNull();
    expect(refusal({ plpgsql: "1.0" })).toBeNull();
  });
});
