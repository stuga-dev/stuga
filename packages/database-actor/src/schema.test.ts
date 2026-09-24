import { describe, expect, it } from "vitest";
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS, DATABASE_MAX_COLUMNS, DATABASE_MAX_TABLES } from "@stuga/protocol/databases/limits";
import type { ColumnSpec, DatabaseSchema, TableSchema } from "@stuga/protocol/databases/types";
import { AGENT, HUMAN, doFetch, doJson, initStarter, makeActor } from "../test/harness.js";

async function schemaOf(actor: ReturnType<typeof makeActor>["actor"]): Promise<DatabaseSchema> {
  return doJson<DatabaseSchema>(actor, "/schema");
}

describe("/schema/init", () => {
  it("creates the starter table once and is idempotent", async () => {
    const { actor } = makeActor();
    const first = await doJson<{ initialized: boolean; schema: DatabaseSchema }>(actor, "/schema/init", { actor: HUMAN });
    expect(first.initialized).toBe(true);
    expect(first.schema.database_id).toBe("db_test");
    expect(first.schema.tables).toHaveLength(1);
    const table = first.schema.tables[0]!;
    expect(table.display).toBe("Table 1");
    expect(table.name).toBe("table_1");
    expect(table.row_count).toBe(0);
    expect(table.columns.map((c) => [c.display, c.type])).toEqual([
      ["Name", "text"],
      ["Notes", "text"],
      ["Done", "checkbox"],
    ]);

    // A second init creates nothing, whatever it names.
    const second = await doJson<{ initialized: boolean; schema: DatabaseSchema }>(actor, "/schema/init", {
      display: "Other",
      actor: HUMAN,
    });
    expect(second.initialized).toBe(false);
    expect(second.schema.tables).toHaveLength(1);
    expect(second.schema.tables[0]!.display).toBe("Table 1");
  });

  it("honors a custom starter display", async () => {
    const { actor } = makeActor();
    const out = await doJson<{ schema: DatabaseSchema }>(actor, "/schema/init", { display: "  Projects  ", actor: HUMAN });
    expect(out.schema.tables[0]!.display).toBe("Projects");
    expect(out.schema.tables[0]!.name).toBe("projects");
  });
});

describe("tables", () => {
  it("creates tables with sanitized physical names and verbatim displays", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const { table } = await doJson<{ table: TableSchema }>(actor, "/tables/create", { display: "My Tasks!", actor: HUMAN });
    expect(table.display).toBe("My Tasks!");
    expect(table.name).toBe("my_tasks");
    expect(table.columns).toEqual([]);
  });

  it("uniquifies colliding display names (tasks → tasks_2)", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const a = await doJson<{ table: TableSchema }>(actor, "/tables/create", { display: "Tasks", actor: HUMAN });
    const b = await doJson<{ table: TableSchema }>(actor, "/tables/create", { display: "Tasks", actor: HUMAN });
    expect(a.table.name).toBe("tasks");
    expect(b.table.name).toBe("tasks_2");
    expect(b.table.display).toBe("Tasks");
  });

  it("refuses table creation past DATABASE_MAX_TABLES with 409", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    for (let i = 1; i < DATABASE_MAX_TABLES; i++) {
      await doJson(actor, "/tables/create", { display: `T${i}`, actor: HUMAN });
    }
    const res = await doFetch(actor, "/tables/create", { display: "One Too Many", actor: HUMAN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("table_cap");
  });

  it("renames the physical table (verified via /query) and keeps the display", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const { table } = await doJson<{ table: TableSchema }>(actor, "/tables/create", { display: "Tasks", actor: HUMAN });
    const renamed = await doJson<{ table: TableSchema }>(actor, "/tables/rename", {
      table_id: table.table_id,
      display: "Projects",
      actor: HUMAN,
    });
    expect(renamed.table.display).toBe("Projects");
    expect(renamed.table.name).toBe("projects");

    const ok = await doJson<{ rows: unknown[] }>(actor, "/query", { sql: `SELECT * FROM "projects"`, actor: AGENT });
    expect(ok.rows).toEqual([]);
    const gone = await doFetch(actor, "/query", { sql: `SELECT * FROM "tasks"`, actor: AGENT });
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { error: string }).error).toBe("sql_error");
  });

  it("leaves the physical name alone when the new display sanitizes identically", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const { table } = await doJson<{ table: TableSchema }>(actor, "/tables/create", { display: "Tasks", actor: HUMAN });
    const renamed = await doJson<{ table: TableSchema }>(actor, "/tables/rename", {
      table_id: table.table_id,
      display: "TASKS!",
      actor: HUMAN,
    });
    expect(renamed.table.name).toBe("tasks");
    expect(renamed.table.display).toBe("TASKS!");
  });

  it("deletes a table (404s afterwards)", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: HUMAN });
    expect((await schemaOf(actor)).tables).toHaveLength(0);
    const res = await doFetch(actor, "/rows/list", { table_id: starter.table_id });
    expect(res.status).toBe(404);
  });

  it("404s on an unknown table_id and 400s on a bad display", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    expect((await doFetch(actor, "/tables/rename", { table_id: "tbl_nope", display: "X", actor: HUMAN })).status).toBe(404);
    expect((await doFetch(actor, "/tables/create", { display: "   ", actor: HUMAN })).status).toBe(400);
  });
});

describe("columns", () => {
  it("adds a column of every type", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const add = (display: string, type: string, choices?: string[]) =>
      doJson<{ column: { name: string; type: string; options: { choices?: string[] } | null } }>(actor, "/columns/add", {
        table_id: starter.table_id,
        display,
        type,
        choices,
        actor: HUMAN,
      });
    expect((await add("Amount", "number")).column.name).toBe("amount");
    expect((await add("Due", "date")).column.type).toBe("date");
    expect((await add("Flag", "checkbox")).column.type).toBe("checkbox");
    const sel = await add("Status", "single_select", ["todo", "done"]);
    expect(sel.column.options).toEqual({ choices: ["todo", "done"] });
    const schema = await schemaOf(actor);
    expect(schema.tables[0]!.columns).toHaveLength(7);
  });

  it("rejects single_select without choices", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const res = await doFetch(actor, "/columns/add", { table_id: starter.table_id, display: "Status", type: "single_select", actor: HUMAN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/choices/);
  });

  it("rejects unknown column types", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const res = await doFetch(actor, "/columns/add", { table_id: starter.table_id, display: "X", type: "json", actor: HUMAN });
    expect(res.status).toBe(400);
  });

  it("uniquifies colliding column names within a table", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const { column } = await doJson<{ column: { name: string } }>(actor, "/columns/add", {
      table_id: starter.table_id,
      display: "Name",
      type: "text",
      actor: HUMAN,
    });
    expect(column.name).toBe("name_2");
  });

  it("refuses columns past DATABASE_MAX_COLUMNS with 409", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    for (let i = 3; i < DATABASE_MAX_COLUMNS; i++) {
      await doJson(actor, "/columns/add", { table_id: starter.table_id, display: `C${i}`, type: "text", actor: HUMAN });
    }
    const res = await doFetch(actor, "/columns/add", { table_id: starter.table_id, display: "Overflow", type: "text", actor: HUMAN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("column_cap");
  });

  it("renames a column physically (verified via /query)", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const { column } = await doJson<{ column: { name: string; display: string } }>(actor, "/columns/rename", {
      table_id: starter.table_id,
      column_id: notes.column_id,
      display: "Description",
      actor: HUMAN,
    });
    expect(column.name).toBe("description");
    expect(column.display).toBe("Description");
    const out = await doJson<{ columns: string[] }>(actor, "/query", {
      sql: `SELECT description FROM "table_1"`,
      actor: AGENT,
    });
    expect(out.columns).toEqual(["description"]);
  });

  it("deletes a column and 404s on unknown column ids", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: notes.column_id, actor: HUMAN });
    const schema = await schemaOf(actor);
    expect(schema.tables[0]!.columns.map((c) => c.display)).toEqual(["Name", "Done"]);
    expect(
      (await doFetch(actor, "/columns/delete", { table_id: starter.table_id, column_id: notes.column_id, actor: HUMAN })).status,
    ).toBe(404);
  });
});

describe("column descriptions", () => {
  /** Descriptions live inside the options blob; what leaves the actor must be the ColumnSpec field alone. */
  it("carries add_column's description on the spec, never inside options", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const { column } = await doJson<{ column: ColumnSpec }>(actor, "/columns/add", {
      table_id: starter.table_id,
      display: "Amount",
      type: "number",
      description: "  USD, net of refunds  ",
      actor: HUMAN,
    });
    expect(column.description).toBe("USD, net of refunds");
    expect(column.options).toBeNull();

    const sel = await doJson<{ column: ColumnSpec }>(actor, "/columns/add", {
      table_id: starter.table_id,
      display: "Stage",
      type: "single_select",
      choices: ["open", "won"],
      description: "Pipeline stage as sales calls it",
      actor: HUMAN,
    });
    expect(sel.column.options).toEqual({ choices: ["open", "won"] });
    expect(sel.column.description).toBe("Pipeline stage as sales calls it");

    const schema = await schemaOf(actor);
    const read = schema.tables[0]!.columns.find((c) => c.display === "Amount")!;
    expect(read.description).toBe("USD, net of refunds");
    expect(read.options).toBeNull();
    // A column nobody described says nothing at all.
    expect(schema.tables[0]!.columns.find((c) => c.display === "Name")!.description).toBeUndefined();
  });

  it("sets, rewrites and clears a description, and records nothing for an identical write", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const opCount = async () => (await doJson<{ ops: Array<{ summary: string }> }>(actor, "/ops")).ops;

    const set = await doJson<{ column: ColumnSpec }>(actor, "/columns/set-description", {
      table_id: starter.table_id,
      column_id: notes.column_id,
      description: "  Free-form notes the handler leaves  ",
      actor: HUMAN,
    });
    expect(set.column.description).toBe("Free-form notes the handler leaves");
    const afterSet = await opCount();
    expect(afterSet[0]!.summary).toBe('Described column "Notes" in "Table 1"');

    // The same text again is not a change, so no op joins the ledger.
    await doJson(actor, "/columns/set-description", {
      table_id: starter.table_id,
      column_id: notes.column_id,
      description: "Free-form notes the handler leaves",
      actor: HUMAN,
    });
    expect((await opCount()).length).toBe(afterSet.length);

    const cleared = await doJson<{ column: ColumnSpec }>(actor, "/columns/set-description", {
      table_id: starter.table_id,
      column_id: notes.column_id,
      description: "   ",
      actor: HUMAN,
    });
    expect(cleared.column.description).toBeUndefined();
    expect((await opCount())[0]!.summary).toBe('Cleared the description of column "Notes" in "Table 1"');
    // Clearing an already-empty description is another no-op.
    const afterClear = (await opCount()).length;
    await doJson(actor, "/columns/set-description", { table_id: starter.table_id, column_id: notes.column_id, actor: HUMAN });
    expect((await opCount()).length).toBe(afterClear);
  });

  it("refuses a description past the cap, naming it", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const tooLong = "x".repeat(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS + 1);
    for (const [path, body] of [
      ["/columns/set-description", { table_id: starter.table_id, column_id: notes.column_id, description: tooLong }],
      ["/columns/add", { table_id: starter.table_id, display: "Wordy", type: "text", description: tooLong }],
      ["/tables/create", { display: "Wordy table", columns: [{ name: "C", type: "text", description: tooLong }] }],
    ] as const) {
      const res = await doFetch(actor, path, { ...body, actor: HUMAN });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain(`max ${DATABASE_MAX_COLUMN_DESCRIPTION_CHARS} chars`);
    }
  });

  it("keeps the description through a type change, and through its revert", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const { column } = await doJson<{ column: ColumnSpec }>(actor, "/columns/add", {
      table_id: starter.table_id,
      display: "Amount",
      type: "text",
      description: "USD, net of refunds",
      actor: HUMAN,
    });
    const retyped = await doJson<{ column: ColumnSpec }>(actor, "/columns/set-type", {
      table_id: starter.table_id,
      column_id: column.column_id,
      type: "number",
      actor: HUMAN,
    });
    expect(retyped.column.type).toBe("number");
    expect(retyped.column.description).toBe("USD, net of refunds");

    const op = (await doJson<{ ops: Array<{ op_id: string; kind: string }> }>(actor, "/ops")).ops.find((o) => o.kind === "columns.set_type")!;
    await doJson(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    const back = (await schemaOf(actor)).tables[0]!.columns.find((c) => c.column_id === column.column_id)!;
    expect(back.type).toBe("text");
    expect(back.description).toBe("USD, net of refunds");
  });

  it("restores the previous description when a set_description is reverted", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const describe_ = (description: string) =>
      doJson(actor, "/columns/set-description", { table_id: starter.table_id, column_id: notes.column_id, description, actor: HUMAN });
    await describe_("first words");
    await describe_("second words");
    const op = (await doJson<{ ops: Array<{ op_id: string; kind: string }> }>(actor, "/ops")).ops[0]!;
    expect(op.kind).toBe("columns.set_description");
    await doJson(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    const back = (await schemaOf(actor)).tables[0]!.columns.find((c) => c.column_id === notes.column_id)!;
    expect(back.description).toBe("first words");
  });
});
