/** What the grid paints for agent proposals still awaiting review on its table. Nothing here is applied. */
import type { DbRunOpRowsInsert, RowValue } from "@stuga/protocol/databases/types";
import type { PendingOp } from "../../review/db-runs-context";

export interface GhostColumn {
  columnId: string;
  display: string;
  agent: string;
}

interface GhostInsert {
  runId: string;
  opId: string;
  agent: string;
  payload: DbRunOpRowsInsert;
}

interface PendingOverlay {
  /** Proposed columns, as extra tinted headers. */
  ghostCols: GhostColumn[];
  /** Row id → column id → proposed value, with the agent of the first proposal for the tooltip. */
  updates: Map<string, { agent: string; values: Record<string, RowValue> }>;
  /** Rows a proposal would delete. */
  deletes: Set<string>;
  /** One ghost-row group per insert op, decided as one change. */
  inserts: GhostInsert[];
}

/** Ops whose payload was elided on the wire paint nothing until their detail arrives. */
export function pendingOverlay(pending: readonly PendingOp[]): PendingOverlay {
  const overlay: PendingOverlay = { ghostCols: [], updates: new Map(), deletes: new Set(), inserts: [] };
  for (const { runId, agent, op } of pending) {
    const payload = op.payload;
    if (!payload || payload.kind !== op.kind) continue;
    switch (payload.kind) {
      case "columns.add":
        overlay.ghostCols.push({ columnId: payload.column_id, display: payload.display, agent });
        break;
      case "rows.update":
        for (const u of payload.updates) {
          const merged = overlay.updates.get(u._id) ?? { agent, values: {} };
          Object.assign(merged.values, u.values);
          overlay.updates.set(u._id, merged);
        }
        break;
      case "rows.delete":
        for (const id of payload.row_ids) overlay.deletes.add(id);
        break;
      case "rows.insert":
        overlay.inserts.push({ runId, opId: op.id, agent, payload });
        break;
    }
  }
  return overlay;
}
