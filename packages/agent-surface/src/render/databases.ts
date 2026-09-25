/** What an agent reads back from database writes, imports, row pages and the database ledger. */
import { DATABASE_MAX_ROWS } from "@stuga/protocol/databases/limits";
import type {
  DatabaseImportError,
  DatabaseRunOpStatus,
  DatabaseRunSummary,
  DatabaseSchema,
} from "@stuga/protocol/databases/types";
import type { CreatedDoc, DatabaseProposeBody, RowPage } from "../backend.js";
import { MAX_STATUS_RUNS, instructionFields, tally } from "./docs.js";
import { instructionsPointer } from "./instructions.js";

/** Rows in one insert_rows call past which the result steers the agent to import. */
export const BULK_STEER_ROWS = 50;

const REJECTED_CHANGES_NOTE =
  "The user rejected some changes — do not blindly retry them; re-read the data and reconsider, or ask the user via a comment.";

/**
 * Said on the result of a big insert_rows batch: the description is read once,
 * this is read as the next batch is being written.
 */
export function bulkSteer(rowCount: number): string {
  if (rowCount < BULK_STEER_ROWS) return "";
  return (
    ` NOTE — that was ${rowCount} rows as one change. If more rows are coming, do NOT send another insert_rows batch: ` +
    `\`databases_add\` action:import takes a whole CSV/JSONL file at once (up to ${DATABASE_MAX_ROWS} rows) and lands it as ONE change the user reviews once.`
  );
}

/** A database write's result, with the ids the actor minted so the agent can name them next. */
export function renderDatabasePropose(res: DatabaseProposeBody, applied: string, note = ""): string {
  const { mode, run, pending, minted, held, instructions_labels, ...rest } = res;
  // A write needs no schema read, so the answer names what governs this database; `schema` carries the text.
  const instructions = instructionsPointer(instructions_labels, "`databases` action:schema");
  if (mode === "proposed") {
    const why = held
      ? " This database applies agent changes at once, but your earlier changes in this run are still waiting for the user."
      : "";
    return JSON.stringify({
      result:
        `Proposed — your change is waiting for the user to accept it (run ${run?.id}, ${pending} pending).${why} ` +
        `This is SUCCESS. Do NOT retry; continue your work. Your schema reads already include this pending change ` +
        `(query results note what is pending); check \`databases\` action:status for decisions.${note}${instructions}`,
      ...minted,
    });
  }
  if (mode === "applied") {
    return JSON.stringify({
      result:
        `Applied — ${applied} This database is set to apply agent changes at once, so it landed without review; the ` +
        `user has been notified and can review or revert it from the table's Activity panel.${note}${instructions}`,
      ...minted,
      ...rest,
    });
  }
  // A human credential's write is its own: there is no run to point at.
  return JSON.stringify({ result: `Applied — ${applied}${note}${instructions}`, ...rest });
}

export function renderDatabaseStatus(runs: DatabaseRunSummary[]): string {
  if (runs.length === 0) return "No change runs for this database yet.";
  const shown = runs.slice(0, MAX_STATUS_RUNS);
  const lines = shown.map((run) => {
    const counts: Record<DatabaseRunOpStatus, number> = { pending: 0, accepted: 0, rejected: 0, conflict: 0, auto_applied: 0 };
    for (const op of run.ops) counts[op.status] += 1;
    return `${run.id}: ${run.status}${run.reverted ? " (reverted)" : ""} — ${tally(counts)}`;
  });
  if (shown.some((r) => r.ops.some((o) => o.status === "rejected"))) lines.push(REJECTED_CHANGES_NOTE);
  return lines.join("\n");
}

/** A row's page is a document: point the agent at `markdown`, or it reaches for `query`. */
export function renderOpenPage(page: RowPage): string {
  const how = page.created ? "was just created for it" : page.restored ? "was in the trash and is restored" : "already existed";
  return JSON.stringify({
    result:
      `The row's page is document ${page.doc_id} — it ${how}. It is a prose document: read it with \`markdown\` ` +
      `action:read and change it with \`markdown_edit\` or \`markdown_append\` (proposed for review like any ` +
      `document edit). The row's cells stay in the table; the page is the row's body.`,
    doc_id: page.doc_id,
    created: page.created,
  });
}

/**
 * The database just created, with its starter table so the agent's next call can name it, and the instructions it
 * was placed under so its first write follows them.
 */
export function renderCreatedDatabase(doc: CreatedDoc, schema: DatabaseSchema | null): string {
  const first = schema?.tables[0];
  return JSON.stringify({
    database_id: doc.doc_id,
    title: doc.title,
    ...(first
      ? {
          table_id: first.table_id,
          table: first.name,
          columns: first.columns.map((c) => ({
            column_id: c.column_id,
            name: c.name,
            type: c.type,
            ...(c.description ? { description: c.description } : {}),
          })),
        }
      : {}),
    ...instructionFields(doc),
  });
}

/** When the data cannot reach the node, the person finishes the import; the agent must not try another way. */
export function renderHandOff(pageUrl: string, why: string): string {
  return (
    `${why} Do NOT try another way and do NOT fall back to insert_rows. Tell the user in one sentence that this file has ` +
    `to come from them, and give them this link (attach the file to your reply if you made it): ${pageUrl} — it opens the ` +
    `table's Import dialog, where they drop the file in. Then stop; the import is theirs to finish.`
  );
}

/**
 * The commit's outcome, phrased so a failure is fixed and a success is not
 * retried. `sources` names what the retry replaces ("content", or "file/content").
 */
export function renderImportCommit(status: number, body: Record<string, unknown>, sources: string): { text: string; isError: boolean } {
  if (status === 422) {
    const errors = (body.errors ?? []) as DatabaseImportError[];
    return {
      isError: true,
      text:
        `${String(body.message)} The upload is kept, so do NOT re-send the data: call import again with ` +
        `import_id: "${String(body.import_id)}" in place of ${sources}, plus on_error: "skip_bad_rows" to load the rows ` +
        `that passed, or plus column_map / date_order to fix how the file is read. ` +
        JSON.stringify({
          import_id: body.import_id,
          rows_total: body.rows_total,
          rows_failed: body.rows_failed,
          errors,
          errors_truncated: body.errors_truncated,
          ignored_columns: body.ignored_columns,
          notes: body.notes,
          guessed_date_order: body.guessed_date_order,
        }),
    };
  }
  if (status >= 400) return { isError: true, text: String(body.error ?? "the import was refused") };
  if (body.dry_run === true) {
    const ready = Number(body.rows_ready ?? 0);
    const bad = Number(body.rows_failed ?? 0);
    return {
      isError: false,
      text: JSON.stringify({
        result:
          `Checked ${body.rows_total} row${body.rows_total === 1 ? "" : "s"}: ${ready} ready, ${bad} with problems. NOTHING was loaded. ` +
          `The upload is kept: call import again with import_id: "${String(body.import_id)}" in place of ${sources} to load it` +
          (bad > 0 ? ` (plus on_error: "skip_bad_rows" to leave the bad rows out).` : "."),
        ...body,
      }),
    };
  }
  const n = Number(body.rows_ingested ?? 0);
  const skipped = Number(body.rows_skipped ?? 0);
  const run = body.run as DatabaseRunSummary | undefined;
  const skippedNote = skipped > 0 ? ` ${skipped} bad row${skipped === 1 ? "" : "s"} were skipped (listed in errors).` : "";
  const replay = body.already_applied === true ? " (This import had already been committed; nothing was loaded twice.)" : "";
  const guessed =
    body.guessed_date_order === "mdy" || body.guessed_date_order === "dmy"
      ? ` Ambiguous dates like 1/4/26 were read as ${body.guessed_date_order === "mdy" ? "month/day/year" : "day/month/year"}; ` +
        `if that is wrong, commit again with date_order: "${body.guessed_date_order === "mdy" ? "dmy" : "mdy"}".`
      : "";
  const result =
    body.mode === "proposed"
      ? `Proposed — the import of ${n} row${n === 1 ? "" : "s"} is ONE change waiting for the user to accept it` +
        `${run ? ` (run ${run.id})` : ""}. This is SUCCESS: do NOT retry or re-upload. Your schema reads and ` +
        `query results already reflect the pending rows; check \`databases\` action:status for the decision.${skippedNote}${replay}${guessed}`
      : `Applied — imported ${n} row${n === 1 ? "" : "s"}. The user was notified and can revert the whole import from the ` +
        `table's Activity panel.${skippedNote}${replay}${guessed}`;
  const { run: _run, ...rest } = body;
  return { isError: false, text: JSON.stringify({ result, ...rest, ...(run ? { run_id: run.id } : {}) }) };
}
