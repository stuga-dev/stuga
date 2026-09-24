import { describe, expect, it } from "vitest";
import type { DatabaseRunOp, DatabaseRunOpPayload } from "@stuga/protocol/databases/types";
import type { PendingOp } from "../../review/db-runs-context";
import { pendingOverlay } from "./pending-overlay";

function pending(id: string, payload: DatabaseRunOpPayload | undefined, agent = "Claude", kind = payload?.kind): PendingOp {
  const op: DatabaseRunOp = {
    id,
    kind: kind ?? "rows.insert",
    table_id: "tbl_1",
    summary: id,
    status: "pending",
    review: "review",
    ...(payload ? { payload } : {}),
  };
  return { runId: "run_1", agent, op };
}

describe("pendingOverlay", () => {
  it("is empty with nothing pending", () => {
    const o = pendingOverlay([]);
    expect(o.ghostCols).toEqual([]);
    expect(o.updates.size).toBe(0);
    expect(o.deletes.size).toBe(0);
    expect(o.inserts).toEqual([]);
  });

  it("turns a proposed column into a ghost header", () => {
    const o = pendingOverlay([
      pending("o1", { kind: "columns.add", table_id: "tbl_1", column_id: "col_s", display: "Status", type: "text", options: null }),
    ]);
    expect(o.ghostCols).toEqual([{ columnId: "col_s", display: "Status", agent: "Claude" }]);
  });

  it("merges updates to one row across ops, keeping the first proposer as the tooltip's agent", () => {
    const o = pendingOverlay([
      pending("o1", { kind: "rows.update", table_id: "tbl_1", updates: [{ _id: "r1", values: { a: "x" } }] }, "Claude"),
      pending("o2", { kind: "rows.update", table_id: "tbl_1", updates: [{ _id: "r1", values: { b: 2 } }, { _id: "r2", values: { a: null } }] }, "Codex"),
    ]);
    expect(o.updates.get("r1")).toEqual({ agent: "Claude", values: { a: "x", b: 2 } });
    expect(o.updates.get("r2")).toEqual({ agent: "Codex", values: { a: null } });
  });

  it("collects deleted rows and keeps each insert op whole", () => {
    const insert = { kind: "rows.insert" as const, table_id: "tbl_1", rows: [{ a: "1" }, { a: "2" }], row_ids: ["n1", "n2"] };
    const o = pendingOverlay([
      pending("o1", { kind: "rows.delete", table_id: "tbl_1", row_ids: ["r1", "r2"] }),
      pending("o2", insert),
    ]);
    expect([...o.deletes]).toEqual(["r1", "r2"]);
    expect(o.inserts).toEqual([{ runId: "run_1", opId: "o2", agent: "Claude", payload: insert }]);
  });

  it("paints nothing for an op whose payload was elided", () => {
    const o = pendingOverlay([pending("o1", undefined, "Claude", "rows.delete")]);
    expect(o.deletes.size).toBe(0);
    expect(o.inserts).toEqual([]);
  });
});
