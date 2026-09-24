/**
 * The live channel: sockets that carry JSON frames (run updates, "rows
 * changed") to the people looking at a database. They decide nothing; whether
 * a proposal parks or applies is the database's own `agent_mode`.
 */
import type { DatabaseChangedPayload } from "@stuga/protocol/wire/db-socket";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { ActorSocket, ActorState } from "@stuga/runtime";

export interface SessionMeta {
  alias: string;
  /** Stamped by the node from the verified credential: an agent is never sent its own review. */
  agentAuth: boolean;
}

export class Sockets {
  constructor(private readonly state: ActorState<SessionMeta>) {}

  send(ws: ActorSocket<SessionMeta>, frame: Uint8Array): void {
    try {
      ws.send(frame);
    } catch {
      /* socket closing */
    }
  }

  /** A run frame, to the reviewer's own non-agent sockets. */
  sendToReviewer(reviewer: string, frame: Uint8Array): void {
    for (const ws of this.state.getWebSockets()) {
      if (!ws.meta.agentAuth && ws.meta.alias === reviewer) this.send(ws, frame);
    }
  }

  /**
   * Tell every socket the rows moved so grids refetch. `exceptAlias` skips the
   * person who made the change: their grid already shows it, and a refetch
   * would wipe the cell they are editing.
   */
  broadcastChanged(tableId: string | null, reason: DatabaseChangedPayload["reason"], exceptAlias: string | null = null): void {
    const frame = encodeJson(Opcode.DB_CHANGED, { table_id: tableId, reason } satisfies DatabaseChangedPayload);
    for (const ws of this.state.getWebSockets()) {
      if (exceptAlias !== null && !ws.meta.agentAuth && ws.meta.alias === exceptAlias) continue;
      this.send(ws, frame);
    }
  }
}
