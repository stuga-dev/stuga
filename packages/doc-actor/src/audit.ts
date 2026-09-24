/**
 * The document actor's rows in the audit ledger: write refusals and in-app
 * co-author proposals. The actor holds no database, so rows ride the job queue,
 * best-effort — the refusal or proposal already happened either way.
 *
 * Rows carry the document id and never a label: the only name the actor could
 * produce is derived from the body, and ledger readers (workspace admins) are
 * not the document's ACL.
 */
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { JobQueue } from "@stuga/runtime";
import { safeSend, type DocSocket, type SessionMeta } from "./session.js";

type RefusalKind = WriteRejectedPayload["kind"];

/**
 * The refusals that decide who may write. `epoch`, `rate-limit`, `table-cap` and
 * `structural-rate` would turn away the owner's frame just the same, so they
 * are backpressure, not permission decisions.
 */
const AUDITED_REFUSALS: ReadonlySet<RefusalKind> = new Set(["acl", "locked", "approval_required"]);

/** One row per (alias, kind) per window: a tab re-sending against a locked document would otherwise bury the ledger. */
const AUDIT_DEDUP_MS = 60_000;
const AUDIT_DEDUP_KEYS = 256;

function send(jobs: JobQueue<IndexMessage>, message: IndexMessage, what: string, docId: string): void {
  try {
    void jobs.send(message).catch((err: unknown) => console.warn(`${what} enqueue failed`, { docId, err: String(err) }));
  } catch {
    /* best-effort */
  }
}

export class Refusals {
  /** When each (alias, kind) last reached the ledger. Insertion order is recency order. */
  private readonly lastAudited = new Map<string, number>();

  constructor(
    private readonly jobs: JobQueue<IndexMessage>,
    private readonly docId: () => string,
  ) {}

  /**
   * Tell the client a write was refused. A `notice` is the same frame telling a
   * socket the document's state (a lock, a lowered tier, a view-only open);
   * nobody attempted a write, so it is not recorded.
   */
  reject(ws: DocSocket, kind: RefusalKind, message: string, cause: "attempt" | "notice" = "attempt"): void {
    safeSend(ws, encodeJson(Opcode.WRITE_REJECTED, { kind, message } satisfies WriteRejectedPayload));
    if (cause === "attempt") this.record(ws.meta, kind);
  }

  private record(meta: SessionMeta, kind: RefusalKind): void {
    if (!AUDITED_REFUSALS.has(kind)) return;
    if (!this.claim(meta.alias, kind, Date.now())) return;
    send(
      this.jobs,
      {
        kind: "audit",
        at: new Date().toISOString(),
        workspaceId: meta.workspaceId,
        // The bare alias, spelled as the node's own rows spell it.
        actor: meta.alias,
        actorKind: meta.agentAuth ? "agent" : "human",
        ...(meta.onBehalfOf ? { onBehalfOf: meta.onBehalfOf } : {}),
        source: "ws",
        action: "doc.write_rejected",
        status: "denied",
        targetKind: "doc",
        targetId: this.docId(),
        detail: { kind, ...(meta.agent ? { agent: meta.agent } : {}), dedup_window_ms: AUDIT_DEDUP_MS },
      },
      "write-rejection audit",
      this.docId(),
    );
  }

  /**
   * Claim the row for one (alias, kind), at most once per window. Trimmed on every
   * consult (expired first, then oldest past the key cap), so dropping an entry
   * can only cost a duplicate row, never a missing one.
   */
  private claim(alias: string, kind: RefusalKind, now: number): boolean {
    for (const [seen, at] of this.lastAudited) {
      if (now - at < AUDIT_DEDUP_MS) break;
      this.lastAudited.delete(seen);
    }
    const key = `${alias}\u0000${kind}`;
    if (this.lastAudited.has(key)) return false;
    this.lastAudited.set(key, now);
    while (this.lastAudited.size > AUDIT_DEDUP_KEYS) {
      const oldest = this.lastAudited.keys().next();
      if (oldest.done) break;
      this.lastAudited.delete(oldest.value);
    }
    return true;
  }
}

/**
 * Record a co-author proposal staged on this document. It never passes the
 * node's routes, where every other agent edit is recorded; its cross-document
 * proposals do, so they are not recorded here.
 */
export function recordPanelPropose(
  jobs: JobQueue<IndexMessage>,
  docId: string,
  meta: SessionMeta,
  panelAlias: string,
  runId: string,
  pending: number,
): void {
  send(
    jobs,
    {
      kind: "audit",
      at: new Date().toISOString(),
      workspaceId: meta.workspaceId,
      actor: panelAlias,
      actorKind: "agent",
      onBehalfOf: meta.alias,
      source: "ws",
      action: "doc.propose",
      status: "ok",
      targetKind: "doc",
      targetId: docId,
      // A panel run always parks for review.
      detail: { run_id: runId, mode: "proposed", edit: "cited_edits", pending, review: "review" },
    },
    "panel propose audit",
    docId,
  );
}
