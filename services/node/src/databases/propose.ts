/** The agent write path for databases, and declarative table creation. */
import { principalId } from "@stuga/auth";
import { type DocRow, touchDoc } from "@stuga/db";
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS, DATABASE_MAX_COLUMNS, DATABASE_MAX_DISPLAY_LENGTH } from "@stuga/protocol/databases/limits";
import {
  DATABASE_COLUMN_TYPES,
  type DatabaseColumnType,
  type DatabaseRunSource,
  type DatabaseRunSummary,
} from "@stuga/protocol/databases/types";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { resolveReviewMode } from "../authz/review-mode.js";
import { afterDatabaseMutation, callDatabaseActor } from "./gate.js";
import { reconcileDocLinks } from "./row-pages.js";

export type DatabaseProposeOutcome =
  // `held`: an `auto` database parked this anyway, because the run still holds undecided ops.
  | { kind: "proposed"; run: DatabaseRunSummary; pending: number; minted: Record<string, unknown>; held: boolean }
  | { kind: "applied"; run: DatabaseRunSummary; result: Record<string, unknown> | null; minted: Record<string, unknown> }
  | { kind: "error"; status: number; message: string };

/** The answer to a proposal that went through, the same over REST and /mcp. */
export function databaseProposeBody(outcome: Exclude<DatabaseProposeOutcome, { kind: "error" }>) {
  if (outcome.kind === "proposed") {
    return { mode: "proposed" as const, run: outcome.run, pending: outcome.pending, minted: outcome.minted, held: outcome.held };
  }
  return { mode: "applied" as const, run: outcome.run, minted: outcome.minted, ...outcome.result };
}

/**
 * Forward one mutation to the actor's run ledger, which parks it for review or
 * applies it at once per the document's review mode. The caller has run the
 * ACL and lock gates. An applied op is announced from here; the actor announces
 * a parked one itself.
 */
export async function proposeDatabaseOp(
  ctx: Ctx,
  doc: DocRow,
  op: Record<string, unknown>,
  source: DatabaseRunSource,
): Promise<DatabaseProposeOutcome> {
  const review = resolveReviewMode(ctx, doc);
  const res = await callDatabaseActor(ctx, doc.doc_id, "runs/propose", {
    op,
    source,
    review: review.mode,
    agent: ctx.displayName || ctx.alias,
    client: ctx.client ?? null,
    model: ctx.model ?? null,
    reviewer: ctx.isAgent ? ctx.onBehalfOf : principalId(doc.owner),
    workspace_id: ctx.workspaceId,
    doc_title: doc.title || "Untitled",
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    const msg = (body as { message?: string } | null)?.message ?? "the proposal was refused";
    return { kind: "error", status: res.ok ? 502 : res.status, message: msg };
  }
  const run = body.run as DatabaseRunSummary;
  const minted = (body.minted ?? {}) as Record<string, unknown>;
  if (body.mode === "applied") {
    await afterDatabaseMutation(ctx, doc, summarizeApplied(run));
    // An applied op may have deleted rows that had pages.
    await reconcileDocLinks(ctx, doc);
    return { kind: "applied", run, result: (body.result ?? null) as Record<string, unknown> | null, minted };
  }
  await touchDoc(ctx.sql, doc.doc_id).catch(() => {});
  recordAudit(ctx, {
    action: "database.propose",
    targetKind: "database",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: {
      run_id: run.id,
      mode: "proposed",
      pending: Number(body.pending ?? 0),
      review: review.mode,
    },
  });
  return {
    kind: "proposed",
    run,
    pending: Number(body.pending ?? 0),
    minted,
    held: body.parked_behind_pending === true,
  };
}

/** One line for the applied-at-once notification body, from the run's newest op. */
function summarizeApplied(run: DatabaseRunSummary): string {
  const last = run.ops[run.ops.length - 1];
  return last ? `${last.summary}.` : "Made changes.";
}

/** A column as a declarative create names it: `{ name|display, type, choices?, description? }`. */
export interface ColumnSpecInput {
  display: string;
  type: DatabaseColumnType;
  choices?: string[];
  /** Short help text: what the column holds. */
  description?: string;
}

/** Shape-check a `columns` list before anything is proposed or created, so one bad column leaves no partial table. */
export function parseColumnSpecs(raw: unknown): { ok: true; columns: ColumnSpecInput[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "columns must be an array of { name, type, choices?, description? }" };
  if (raw.length > DATABASE_MAX_COLUMNS) return { ok: false, message: `too many columns (max ${DATABASE_MAX_COLUMNS})` };
  const columns: ColumnSpecInput[] = [];
  const seen = new Set<string>();
  for (const [i, c] of raw.entries()) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return { ok: false, message: `columns[${i}] must be an object` };
    const spec = c as Record<string, unknown>;
    const nameRaw = spec.name ?? spec.display;
    const display = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!display) return { ok: false, message: `columns[${i}] needs a name` };
    if (display.length > DATABASE_MAX_DISPLAY_LENGTH) return { ok: false, message: `columns[${i}] name too long (max ${DATABASE_MAX_DISPLAY_LENGTH} chars)` };
    const type = spec.type;
    if (typeof type !== "string" || !(DATABASE_COLUMN_TYPES as readonly string[]).includes(type)) {
      return { ok: false, message: `columns[${i}] "${display}": type must be one of ${DATABASE_COLUMN_TYPES.join(", ")}` };
    }
    if (spec.choices !== undefined && (!Array.isArray(spec.choices) || !spec.choices.every((x) => typeof x === "string"))) {
      return { ok: false, message: `columns[${i}] "${display}": choices must be an array of strings` };
    }
    if (type === "single_select" && !Array.isArray(spec.choices)) {
      return { ok: false, message: `columns[${i}] "${display}": single_select needs choices` };
    }
    const key = display.toLowerCase();
    if (seen.has(key)) return { ok: false, message: `column "${display}" is listed twice` };
    seen.add(key);
    if (spec.description !== undefined && typeof spec.description !== "string") {
      return { ok: false, message: `columns[${i}] "${display}": description must be a string` };
    }
    const description = typeof spec.description === "string" ? spec.description.trim() : "";
    if (description.length > DATABASE_MAX_COLUMN_DESCRIPTION_CHARS) {
      return { ok: false, message: `columns[${i}] "${display}": description too long (max ${DATABASE_MAX_COLUMN_DESCRIPTION_CHARS} chars)` };
    }
    const out: ColumnSpecInput = { display, type: type as DatabaseColumnType };
    if (Array.isArray(spec.choices)) out.choices = spec.choices as string[];
    if (description) out.description = description;
    columns.push(out);
  }
  return { ok: true, columns };
}

/**
 * An agent's declarative create: the table, then each column, as consecutive
 * proposals on one run; a later op may reference the id a pending earlier one
 * minted. A refusal midway names what did land.
 */
export async function proposeTableWithColumns(
  ctx: Ctx,
  doc: DocRow,
  display: string,
  columns: ColumnSpecInput[],
  source: DatabaseRunSource,
): Promise<DatabaseProposeOutcome> {
  const first = await proposeDatabaseOp(ctx, doc, { kind: "tables.create", display }, source);
  if (first.kind === "error") return first;
  const tableId = String(first.minted.table_id ?? "");
  const columnIds: string[] = [];
  let last = first;
  for (const [i, c] of columns.entries()) {
    const outcome = await proposeDatabaseOp(
      ctx,
      doc,
      { kind: "columns.add", table: tableId, display: c.display, type: c.type, choices: c.choices, description: c.description },
      source,
    );
    if (outcome.kind === "error") {
      return {
        kind: "error",
        status: outcome.status,
        message:
          `table "${display}" was ${first.kind} (table_id ${tableId}) with ${i} of ${columns.length} columns, ` +
          `but column "${c.display}" was refused: ${outcome.message}`,
      };
    }
    columnIds.push(String(outcome.minted.column_id ?? ""));
    last = outcome;
  }
  const minted = { table_id: tableId, column_ids: columnIds };
  return last.kind === "proposed"
    ? { kind: "proposed", run: last.run, pending: last.pending, minted, held: last.held }
    : { kind: "applied", run: last.run, result: { table_id: tableId, column_ids: columnIds }, minted };
}
