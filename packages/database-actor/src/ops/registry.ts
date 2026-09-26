/**
 * One definition per op kind, shared by direct writes, proposals and their
 * apply. Every mutation commits through `commitOp`, so an accepted proposal is
 * ledgered and reverts exactly like a direct write.
 */
import type { DatabaseActor as DatabaseActorIdentity, DatabaseOpKind, DatabaseRunOpPayload } from "@stuga/protocol/databases/types";
import type { Database } from "../database.js";
import { finalizeInverse, recordOp, type InverseJson } from "../ledger/ops-ledger.js";
import { setOpStatus } from "../ledger/runs.js";
import { OpError, type Body } from "../request.js";
import { newId, type SqlHandle } from "../schema-ops.js";
import { columnsAdd, columnsDelete, columnsRename, columnsSetDescription, columnsSetType } from "./columns.js";
import { rowsDelete, rowsInsert, rowsLinkPage, rowsLinkPages, rowsUpdate } from "./rows.js";
import type { SchemaView } from "./schema-view.js";
import { tablesCreate, tablesDelete, tablesRename } from "./tables.js";
import { viewsCreate, viewsDelete, viewsUpdate } from "./views.js";

export interface OpPayload {
  kind: Exclude<DatabaseOpKind, "revert">;
  table_id: string;
}

interface ApplyOptions {
  /** Applying a proposal: an op that finds nothing left to change is a conflict. */
  proposal: boolean;
  /** Whether an inverse was captured; an op recorded without one says so. */
  captured: boolean;
  now: number;
}

export interface OpDef<P extends OpPayload = OpPayload> {
  /** Validate input against the schema view and mint the ids the op will create. */
  parse(input: Body, view: SchemaView): P;
  /**
   * Read what the op will change, as its inverse, or null to record the op
   * without one. It runs again after a spill await, so it must be a pure read.
   */
  capture(sql: SqlHandle, p: P): InverseJson | null;
  /** Re-verify against live state and write, inside the transaction. The result is the route's response body. */
  apply(sql: SqlHandle, p: P, opts: ApplyOptions): { result: Record<string, unknown>; summary: string };
  /** The answer when the op would change nothing, which records no op. */
  unchanged?(sql: SqlHandle, p: P): Record<string, unknown> | null;
  /** Present on kinds an agent may propose. */
  proposal?: {
    /** The run op's summary, in the imperative. */
    describe(p: P, view: SchemaView): string;
    /** Ids the op creates, as the proposal response reports them. */
    minted(p: P): Record<string, string | string[]>;
    /** Ids the op needs to exist: live, or minted by an earlier op of the run. */
    references(p: P): string[];
  };
}

const OPS = {
  "tables.create": tablesCreate,
  "tables.rename": tablesRename,
  "tables.delete": tablesDelete,
  "columns.add": columnsAdd,
  "columns.rename": columnsRename,
  "columns.set_type": columnsSetType,
  "columns.set_description": columnsSetDescription,
  "columns.delete": columnsDelete,
  "views.create": viewsCreate,
  "views.update": viewsUpdate,
  "views.delete": viewsDelete,
  "rows.insert": rowsInsert,
  "rows.update": rowsUpdate,
  "rows.delete": rowsDelete,
  "rows.link_page": rowsLinkPage,
  "rows.link_pages": rowsLinkPages,
} satisfies Record<OpPayload["kind"], unknown>;

export function opDef(kind: OpPayload["kind"]): OpDef {
  return OPS[kind] as unknown as OpDef;
}

type ProposableDef = OpDef<DatabaseRunOpPayload> & { proposal: NonNullable<OpDef["proposal"]> };

/** The definition of a kind an agent may propose, or null. */
export function proposableDef(kind: unknown): ProposableDef | null {
  if (typeof kind !== "string" || !Object.hasOwn(OPS, kind)) return null;
  const def = OPS[kind as OpPayload["kind"]] as unknown as OpDef<DatabaseRunOpPayload>;
  return def.proposal ? (def as ProposableDef) : null;
}

/** The pending → decided transition a proposal's apply makes inside its transaction. */
interface RunOpClaim {
  runId: string;
  opId: string;
  status: "accepted" | "auto_applied";
  decidedBy: string;
}

/**
 * Commit one op: capture (and spill) its inverse, then apply it and record it
 * in one transaction, then nudge live grids. Spilling is the only await, so
 * everything the transaction relies on is re-read inside it. A claim makes the
 * proposal's pending → decided move part of the same transaction, so two
 * deciders can never both apply it.
 */
export async function commitOp(
  db: Database,
  def: OpDef,
  p: OpPayload,
  args: { actor: DatabaseActorIdentity; keep: number; claim?: RunOpClaim },
): Promise<Record<string, unknown>> {
  const locked = "this database is locked; unlock it to make changes";
  if (args.claim) db.requireUnlocked(locked);
  const opId = newId("op_");
  const first = def.capture(db.sql, p);
  const inverse = first === null ? null : await finalizeInverse(db.bucket, db.dbId, opId, p.kind, first, () => def.capture(db.sql, p) ?? first);
  let pruned: string[] = [];
  const result = db.storage.transactionSync(() => {
    const now = Date.now();
    if (args.claim) {
      db.requireUnlocked(locked);
      const { runId, opId: runOpId, status, decidedBy } = args.claim;
      if (!setOpStatus(db.sql, runId, runOpId, status, { decidedBy, ledgerOpId: opId })) {
        throw new OpError(409, "already_decided", "this change was already decided");
      }
    }
    const applied = def.apply(db.sql, p, { proposal: args.claim !== undefined, captured: inverse !== null, now });
    pruned = recordOp(
      db.sql,
      {
        opId,
        actor: args.actor,
        kind: p.kind,
        tableId: p.table_id,
        summary: applied.summary,
        inline: inverse?.inline ?? null,
        blobKey: inverse?.blobKey ?? null,
        reverts: null,
        keep: args.keep,
      },
      now,
    );
    return applied.result;
  });
  db.dropBlobs(pruned);
  db.sockets.broadcastChanged(p.table_id, "mutation", args.actor.is_agent ? null : args.actor.alias);
  return result;
}
