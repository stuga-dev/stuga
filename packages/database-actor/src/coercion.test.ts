import { describe, expect, it } from "vitest";
import { AGENT, HUMAN, doJson, initStarter, makeActor } from "../test/harness.js";

type ListOut = { rows: Array<Record<string, unknown> & { _id: string }>; total: number };
type SetTypeOut = { column: { type: string; options: { choices?: string[] } | null }; coerced: number };
type OpsOut = { ops: Array<{ op_id: string; kind: string; revertible: boolean }> };

/** A fresh actor with one extra column holding the given values, one row per value. */
async function withColumn(type: string, values: unknown[], choices?: string[]) {
  const { actor, h } = makeActor();
  const starter = await initStarter(actor);
  const { column } = await doJson<{ column: { column_id: string; name: string } }>(actor, "/columns/add", {
    table_id: starter.table_id,
    display: "Payload",
    type,
    choices,
    actor: HUMAN,
  });
  const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
    table_id: starter.table_id,
    rows: values.map((v) => ({ Payload: v })),
    actor: HUMAN,
  });
  const list = async () => (await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id })).rows.map((r) => r[column.column_id]);
  return { actor, h, starter, column, rowIds: ins.row_ids, list };
}

describe("/columns/set-type coercion", () => {
  it("text→number casts fully-numeric text and nulls the rest (JS-Number-isms excluded)", async () => {
    const { actor, starter, column, list } = await withColumn("text", ["12.5", "abc", "", " 8 ", null, "0x1A"]);
    const out = await doJson<SetTypeOut>(actor, "/columns/set-type", {
      table_id: starter.table_id,
      column_id: column.column_id,
      type: "number",
      actor: HUMAN,
    });
    expect(out.column.type).toBe("number");
    expect(out.coerced).toBe(5);
    // "0x1A" parses with Number() but SQLite's CAST reads it as 0, so it becomes NULL.
    expect(await list()).toEqual([12.5, null, null, 8, null, null]);
  });

  it("number→text casts numbers to their text form", async () => {
    const { actor, starter, column, list } = await withColumn("number", [12.5, 3.25, null]);
    const out = await doJson<SetTypeOut>(actor, "/columns/set-type", {
      table_id: starter.table_id,
      column_id: column.column_id,
      type: "text",
      actor: HUMAN,
    });
    expect(out.coerced).toBe(2);
    expect(await list()).toEqual(["12.5", "3.25", null]);
  });

  it("→checkbox keeps numeric 0/1, maps true/false text, nulls the rest", async () => {
    const numeric = await withColumn("number", [1, 0, 2]);
    const out1 = await doJson<SetTypeOut>(numeric.actor, "/columns/set-type", {
      table_id: numeric.starter.table_id,
      column_id: numeric.column.column_id,
      type: "checkbox",
      actor: HUMAN,
    });
    expect(out1.coerced).toBe(1);
    expect(await numeric.list()).toEqual([1, 0, null]);

    const texty = await withColumn("text", ["true", "FALSE", "yep"]);
    const out2 = await doJson<SetTypeOut>(texty.actor, "/columns/set-type", {
      table_id: texty.starter.table_id,
      column_id: texty.column.column_id,
      type: "checkbox",
      actor: HUMAN,
    });
    expect(out2.coerced).toBe(3);
    expect(await texty.list()).toEqual([1, 0, null]);
  });

  it("→date keeps real calendar dates only", async () => {
    const { actor, starter, column, list } = await withColumn("text", ["2026-01-15", "2026-02-31", "nope", null]);
    const out = await doJson<SetTypeOut>(actor, "/columns/set-type", {
      table_id: starter.table_id,
      column_id: column.column_id,
      type: "date",
      actor: HUMAN,
    });
    // "2026-02-31" is well-formed but not a real date.
    expect(out.coerced).toBe(2);
    expect(await list()).toEqual(["2026-01-15", null, null, null]);
  });

  it("→single_select keeps members of the choice list only, and records the choices", async () => {
    const { actor, starter, column, list } = await withColumn("text", ["a", "c", null]);
    const out = await doJson<SetTypeOut>(actor, "/columns/set-type", {
      table_id: starter.table_id,
      column_id: column.column_id,
      type: "single_select",
      choices: ["a", "b"],
      actor: HUMAN,
    });
    expect(out.coerced).toBe(1);
    expect(out.column.options).toEqual({ choices: ["a", "b"] });
    expect(await list()).toEqual(["a", null, null]);
  });

  it("agent set-type is revertible: exactly the coerced cells come back, type and options restored", async () => {
    const { actor, starter, column, list } = await withColumn("text", ["12.5", "abc", null, "keepme"]);
    // NULL conforms to every type, so neither the coercion nor the revert touches it.
    const out = await doJson<SetTypeOut>(actor, "/columns/set-type", {
      table_id: starter.table_id,
      column_id: column.column_id,
      type: "number",
      actor: AGENT,
    });
    expect(out.coerced).toBe(3);
    expect(await list()).toEqual([12.5, null, null, null]);

    const ops = await doJson<OpsOut>(actor, "/ops");
    const op = ops.ops.find((o) => o.kind === "columns.set_type")!;
    expect(op.revertible).toBe(true);
    const reverted = await doJson<{ reverted: boolean; restored: number; missing: number }>(actor, "/ops/revert", {
      op_id: op.op_id,
      actor: HUMAN,
    });
    expect(reverted).toEqual({ reverted: true, restored: 3, missing: 0 });
    expect(await list()).toEqual(["12.5", "abc", null, "keepme"]);
    const schema = await doJson<{ tables: Array<{ columns: Array<{ column_id: string; type: string }> }> }>(actor, "/schema");
    const col = schema.tables[0]!.columns.find((c) => c.column_id === column.column_id)!;
    expect(col.type).toBe("text");
  });
});
