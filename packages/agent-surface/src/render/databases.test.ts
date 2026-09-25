import { describe, expect, it } from "vitest";
import type { DatabaseRunOp, DatabaseRunOpStatus, DatabaseRunSummary } from "@stuga/protocol/databases/types";
import {
  BULK_STEER_ROWS,
  bulkSteer,
  renderCreatedDatabase,
  renderDatabasePropose,
  renderDatabaseStatus,
  renderHandOff,
  renderImportCommit,
  renderOpenPage,
} from "./databases.js";

function ops(...statuses: DatabaseRunOpStatus[]): DatabaseRunOp[] {
  return statuses.map((status, i) => ({ id: `o${i + 1}`, kind: "rows.insert", table_id: "t1", summary: "Insert rows", status, review: "review" }));
}

function run(over: Partial<DatabaseRunSummary> = {}): DatabaseRunSummary {
  return {
    id: "run_0123456789ab",
    database_id: "db1",
    source: "connector",
    agent: "Connector",
    agent_alias: "agent-1",
    reviewer: "human-1",
    status: "open",
    ops: ops("pending"),
    acknowledged: false,
    auto_applied: false,
    review_mode: "review",
    created_at: 1,
    updated_at: 2,
    ...over,
  };
}

describe("renderDatabasePropose instructions pointer", () => {
  const labels = ['Folder "Ops"', 'Database "Tasks"'];

  it("names the levels below the workspace on a proposal and on an applied change", () => {
    const proposed = JSON.parse(renderDatabasePropose({ mode: "proposed", run: run(), pending: 1, instructions_labels: labels }, "2 rows added."));
    expect(proposed.result).toContain('apply here beyond the workspace\'s: Folder "Ops", Database "Tasks".');
    expect(proposed.result).toContain("`databases` action:schema");
    const applied = JSON.parse(renderDatabasePropose({ mode: "applied", run: run(), instructions_labels: labels }, "2 rows added."));
    expect(applied.result).toContain('Database "Tasks"');
    // Never a stray field beside the prose.
    expect(applied).not.toHaveProperty("instructions_labels");
  });

  it("says nothing when only the workspace's apply", () => {
    const out = JSON.parse(renderDatabasePropose({ mode: "proposed", run: run(), pending: 1 }, "2 rows added."));
    expect(out.result).not.toContain("Standing instructions");
  });
});

describe("renderDatabasePropose", () => {
  it("says Proposed is success and hands back the minted ids", () => {
    const out = JSON.parse(renderDatabasePropose({ mode: "proposed", run: run(), pending: 2, minted: { row_ids: ["r1", "r2"] } }, "inserted 2 row(s) into tasks."));
    expect(out).toEqual({
      result:
        "Proposed — your change is waiting for the user to accept it (run run_0123456789ab, 2 pending). This is SUCCESS. " +
        "Do NOT retry; continue your work. Your schema reads already include this pending change (query results note " +
        'what is pending); check `databases` action:status for decisions.',
      row_ids: ["r1", "r2"],
    });
  });

  it("explains a change an auto database held behind earlier pending work", () => {
    const out = JSON.parse(renderDatabasePropose({ mode: "proposed", run: run(), pending: 2, held: true }, "x")) as { result: string };
    expect(out.result).toContain("your earlier changes in this run are still waiting for the user");
  });

  it("says Applied for an auto database and keeps the actor's result", () => {
    const out = JSON.parse(
      renderDatabasePropose({ mode: "applied", run: run({ status: "applied" }), minted: { row_ids: ["r1"] }, inserted: 1 }, "inserted 1 row(s) into tasks."),
    );
    expect(out).toEqual({
      result:
        "Applied — inserted 1 row(s) into tasks. This database is set to apply agent changes at once, so it landed without " +
        "review; the user has been notified and can review or revert it from the table's Activity panel.",
      row_ids: ["r1"],
      inserted: 1,
    });
  });

  it("reports a human credential's direct write without claiming a run", () => {
    expect(JSON.parse(renderDatabasePropose({ inserted: 3 }, "inserted 3 row(s) into tasks."))).toEqual({
      result: "Applied — inserted 3 row(s) into tasks.",
      inserted: 3,
    });
  });
});

describe("renderDatabaseStatus", () => {
  it("says so when there are no runs", () => {
    expect(renderDatabaseStatus([])).toBe("No change runs for this database yet.");
  });

  it("tallies each run's ops and warns about rejected work", () => {
    expect(renderDatabaseStatus([run({ ops: ops("pending", "accepted", "accepted") })])).toBe(
      "run_0123456789ab: open — pending 1, accepted 2, rejected 0, conflict 0, auto_applied 0",
    );
    expect(renderDatabaseStatus([run({ ops: ops("rejected") })])).toContain(
      "The user rejected some changes — do not blindly retry them; re-read the data and reconsider, or ask the user via a comment.",
    );
  });

  it("shows only the three newest runs", () => {
    expect(renderDatabaseStatus([1, 2, 3, 4, 5].map((n) => run({ id: `run_${n}` }))).split("\n")).toHaveLength(3);
  });
});

describe("renderOpenPage", () => {
  it("names the document, says how it came to be, and points at the markdown tool", () => {
    const fresh = JSON.parse(renderOpenPage({ doc_id: "d1", created: true, restored: false })) as { result: string };
    expect(fresh).toMatchObject({ doc_id: "d1", created: true });
    expect(fresh.result).toContain("just created");
    expect(fresh.result).toContain("`markdown`");
    expect(JSON.parse(renderOpenPage({ doc_id: "d1", created: false, restored: true })).result).toContain("restored");
    expect(JSON.parse(renderOpenPage({ doc_id: "d1", created: false, restored: false })).result).toContain("already existed");
  });
});

describe("renderCreatedDatabase", () => {
  it("reports the starter table so the next call can name it", () => {
    const schema = {
      database_id: "db9",
      tables: [
        {
          table_id: "t1",
          name: "bookings",
          display: "Bookings",
          position: 0,
          row_count: 0,
          columns: [
            { column_id: "c1", name: "ref", display: "Ref", type: "text" as const, position: 0, options: null, description: "Booking reference, 6 letters" },
            { column_id: "c2", name: "nights", display: "Nights", type: "number" as const, position: 1, options: null },
          ],
          views: [],
        },
      ],
    };
    expect(JSON.parse(renderCreatedDatabase({ doc_id: "db9", title: "Hotel" }, schema))).toEqual({
      database_id: "db9",
      title: "Hotel",
      table_id: "t1",
      table: "bookings",
      // A column that was described says so; one that was not stays three fields.
      columns: [
        { column_id: "c1", name: "ref", type: "text", description: "Booking reference, 6 letters" },
        { column_id: "c2", name: "nights", type: "number" },
      ],
    });
    expect(JSON.parse(renderCreatedDatabase({ doc_id: "db9", title: "Hotel" }, null))).toEqual({ database_id: "db9", title: "Hotel" });
  });

  it("carries the instructions the database was placed under", () => {
    const instructions = [{ kind: "folder" as const, id: "f1", title: "Ops", text: "Name tables in English." }];
    expect(JSON.parse(renderCreatedDatabase({ doc_id: "db9", title: "Hotel", instructions, instructions_cut: ['Folder "Ops"'] }, null))).toEqual({
      database_id: "db9",
      title: "Hotel",
      instructions,
      instructions_cut: ['Folder "Ops"'],
    });
  });
});

describe("imports", () => {
  it("hands the import to the user with the link and nothing else to try", () => {
    const text = renderHandOff("http://node.test/doc/db1?import=t1", "Could not read /home/claude/x.csv.");
    expect(text).toContain("Could not read /home/claude/x.csv.");
    expect(text).toContain("http://node.test/doc/db1?import=t1");
    expect(text).toContain("do NOT fall back to insert_rows");
    expect(text).toContain("Then stop");
  });

  it("steers a big insert_rows batch to import and leaves a small one alone", () => {
    expect(bulkSteer(BULK_STEER_ROWS - 1)).toBe("");
    const steer = bulkSteer(500);
    expect(steer).toContain("500 rows");
    expect(steer).toContain("do NOT send another insert_rows batch");
    expect(renderDatabasePropose({ mode: "applied", run: run() }, "inserted 500 row(s).", steer)).toContain("do NOT send another insert_rows batch");
  });

  it("words a commit so a success is not retried", () => {
    const proposed = renderImportCommit(200, { mode: "proposed", rows_ingested: 2400, rows_skipped: 3, run: { id: "run_1" } }, "content");
    expect(proposed.isError).toBe(false);
    expect(proposed.text).toContain("Proposed — the import of 2400 rows is ONE change waiting");
    expect(proposed.text).toContain("do NOT retry");
    expect(proposed.text).toContain("3 bad rows were skipped");
    expect(JSON.parse(proposed.text)).toMatchObject({ run_id: "run_1" });
    expect(JSON.parse(proposed.text)).not.toHaveProperty("run");

    const applied = renderImportCommit(200, { mode: "applied", rows_ingested: 1, rows_skipped: 0, already_applied: true, guessed_date_order: "mdy" }, "content");
    expect(applied.text).toContain("Applied — imported 1 row.");
    expect(applied.text).toContain("nothing was loaded twice");
    expect((JSON.parse(applied.text) as { result: string }).result).toContain('commit again with date_order: "dmy"');
  });

  it("words a refused commit so the retry goes by import_id, naming what it replaces", () => {
    const failed = renderImportCommit(422, { message: "2 of 5 rows failed validation; nothing was loaded", import_id: "imp_1", errors: [] }, "file/content");
    expect(failed.isError).toBe(true);
    expect(failed.text.startsWith("2 of 5 rows failed")).toBe(true);
    expect(failed.text).toContain('import_id: "imp_1" in place of file/content');
    expect(renderImportCommit(410, { error: "this import has expired" }, "content")).toEqual({ isError: true, text: "this import has expired" });
  });

  it("says a dry run loaded nothing", () => {
    const dry = renderImportCommit(200, { dry_run: true, rows_total: 2, rows_ready: 1, rows_failed: 1, import_id: "imp_1" }, "content");
    expect(dry.text).toContain("NOTHING was loaded");
    expect(dry.text).toContain('on_error: \\"skip_bad_rows\\"');
  });
});
