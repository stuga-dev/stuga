/**
 * The gates a client's SYNC_STEP_2 or UPDATE passes before it may touch the
 * CRDT, in order: lock, rollback fence, editor tier, agent gate, rate window,
 * table growth. Each refusal kind says which one said no.
 */
import * as Y from "yjs";
import { MAX_TABLE_COLS, MAX_TABLE_GROWTH_PER_WINDOW, MAX_TABLE_ROWS } from "@stuga/protocol/domain/limits";
import type { WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { DocSocket } from "../session.js";
import { checkTableGrowth } from "./table-guard.js";

// Per-connection sliding window; only a runaway client trips these.
const RATE_WINDOW_MS = 10_000;
const MAX_UPDATES_PER_WINDOW = 500;
const MAX_AI_PER_WINDOW = 10;

const LOCKED_MESSAGE = "This document is locked; unlock it to make changes.";
const VIEW_ONLY_MESSAGE = "You have view-only access to this document.";

interface RateWindow {
  start: number;
  updates: number;
  ai: number;
  tableGrowth: number;
}

/** One window per socket; the three budgets reset together. */
export class RateLimiter {
  private readonly windows = new WeakMap<DocSocket, RateWindow>();

  allow(ws: DocSocket, kind: "update" | "ai" | "table-growth"): boolean {
    const now = Date.now();
    let w = this.windows.get(ws);
    if (!w || now - w.start >= RATE_WINDOW_MS) {
      w = { start: now, updates: 0, ai: 0, tableGrowth: 0 };
      this.windows.set(ws, w);
    }
    if (kind === "update") return ++w.updates <= MAX_UPDATES_PER_WINDOW;
    if (kind === "table-growth") return ++w.tableGrowth <= MAX_TABLE_GROWTH_PER_WINDOW;
    return ++w.ai <= MAX_AI_PER_WINDOW;
  }
}

/**
 * True when `update` holds nothing `doc` lacks. A client's handshake always
 * carries its whole delete set, so an up-to-date tab's handshake is rarely
 * byte-empty; this compares it against the document instead.
 */
export function addsNothing(doc: Y.Doc, update: Uint8Array): boolean {
  try {
    return Y.snapshotContainsUpdate(Y.snapshot(doc), update);
  } catch {
    return false;
  }
}

export type WriteVerdict =
  | { verdict: "apply" }
  /** Nothing to apply and nothing to refuse: acknowledge without touching the document. */
  | { verdict: "ack" }
  | {
      verdict: "refuse";
      kind: WriteRejectedPayload["kind"];
      message: string;
      resetReason?: string;
      /** The client is told its tier or the lock, but attempted no write, so the ledger is not. */
      notice?: true;
    };

export interface GateState {
  docId: string;
  locked: boolean;
  /** Rollback generation; 0 means the document was never restored. */
  epoch: number;
  doc: Y.Doc;
  rate: RateLimiter;
}

export function judgeWrite(opcode: number, update: Uint8Array, ws: DocSocket, s: GateState): WriteVerdict {
  const meta = ws.meta;
  // A handshake with nothing new is an open, not a write. A session that may not
  // write still gets its refusal, because that frame is how the client learns it
  // is view-only or locked, but it is not audited.
  const opening = opcode === Opcode.SYNC_STEP_2 && addsNothing(s.doc, update);
  if (opening) {
    if (s.locked) return { verdict: "refuse", kind: "locked", message: LOCKED_MESSAGE, notice: true };
    if (!meta.canWrite) return { verdict: "refuse", kind: "acl", message: VIEW_ONLY_MESSAGE, notice: true };
    return { verdict: "ack" };
  }
  if (s.locked) return { verdict: "refuse", kind: "locked", message: LOCKED_MESSAGE };
  // Rollback fence: after a restore, a socket that has not acked the current
  // generation holds superseded state that would re-merge rolled-back content.
  // At epoch 0 there is no superseded generation to protect.
  if (s.epoch > 0 && !meta.epochAcked) {
    console.warn("ws write refused: stale rollback generation", { docId: s.docId, alias: meta.alias, epoch: s.epoch });
    return {
      verdict: "refuse",
      kind: "epoch",
      message: "This document was restored to an earlier version; reloading.",
      resetReason: "stale rollback generation",
    };
  }
  if (!meta.canWrite) return { verdict: "refuse", kind: "acl", message: VIEW_ONLY_MESSAGE };
  // Agent content must go through /runs/propose so a person reviews it. Keyed on
  // the server-stamped `agentAuth`, never the client-chosen label, and applied
  // to SYNC_STEP_2 too, which is a write.
  if (meta.agentAuth) {
    return {
      verdict: "refuse",
      kind: "approval_required",
      message: "Agent edits must use the propose API; direct document writes from agents are disabled.",
    };
  }
  if (!s.rate.allow(ws, "update")) return { verdict: "refuse", kind: "rate-limit", message: "Too many updates; slow down." };
  const growth = checkTableGrowth(s.doc, update, () => s.rate.allow(ws, "table-growth"));
  if (growth === "table-cap") {
    return {
      verdict: "refuse",
      kind: "table-cap",
      message: `A table in this document would exceed ${MAX_TABLE_COLS} columns or ${MAX_TABLE_ROWS} rows.`,
    };
  }
  if (growth === "structural-rate") {
    return { verdict: "refuse", kind: "structural-rate", message: "Too many table structure changes; slow down." };
  }
  return { verdict: "apply" };
}
