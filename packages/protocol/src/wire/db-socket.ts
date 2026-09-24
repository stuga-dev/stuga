import type { DatabaseRunSummary } from "../databases/types.js";

/** Payload of DB_RUN_UPDATED. */
export interface DatabaseRunUpdatedPayload {
  run: DatabaseRunSummary;
}

/** Payload of DB_RUN_DECIDED. */
export interface DatabaseRunDecidedPayload {
  run_id: string;
  decision: "accept" | "reject";
  op_ids: string[];
  /** Alias, or "policy:auto" where the database's `auto` setting landed it. */
  decided_by: string;
  run: DatabaseRunSummary;
}

/** Payload of DB_CHANGED, sent to every live socket. */
export interface DatabaseChangedPayload {
  /** The table whose rows changed, when the change was table-scoped. */
  table_id: string | null;
  reason: "mutation" | "run" | "revert";
}
