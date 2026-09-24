/**
 * Writing to the audit ledger and the workspace event feed from a request.
 * Everything here is best-effort and never awaited on the request path: the
 * ledger records what happened, it is not a gate on it.
 */
import { agentPrincipal, userPrincipal } from "@stuga/auth";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { AuditStatus } from "@stuga/protocol/domain/audit";
import type { WorkspaceEventType } from "@stuga/protocol/domain/events";
import type { AccountCtx, Ctx, Surface } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

/** What a route says about one audited action; the actor and source come from the context. */
export interface AuditInput {
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  /** The target's name as it reads now; an old row keeps the name it saw. */
  targetLabel?: string | null;
  /** Absent means "ok". */
  status?: AuditStatus;
  requestId?: string;
  detail?: Record<string, unknown>;
}

/** Who one event is attributed to, and in which workspace's ledger it lands. */
interface AuditActor {
  workspaceId: string | null;
  actor: string;
  actorKind: "human" | "agent";
  onBehalfOf: string | null;
  source: Surface;
  requestId?: string;
}

function sendAudit(jobs: NodeEnv["jobs"], by: AuditActor, input: AuditInput): void {
  const message: IndexMessage = {
    kind: "audit",
    // Stamped here, not at insert: the worker writes the row later.
    at: new Date(Date.now()).toISOString(),
    ...by,
    action: input.action,
    targetKind: input.targetKind ?? null,
    targetId: input.targetId ?? null,
    targetLabel: input.targetLabel ?? null,
    status: input.status ?? "ok",
    requestId: input.requestId ?? by.requestId,
    detail: input.detail,
  };
  try {
    void jobs.send(message).catch(() => {});
  } catch {
    /* the ledger is best-effort */
  }
}

/** Append one event to the audit ledger as this request's identity; account and node routes record no workspace. */
export function recordAudit(ctx: AccountCtx & { workspaceId?: string }, input: AuditInput): void {
  sendAudit(
    ctx.env.jobs,
    {
      workspaceId: ctx.workspaceId ?? null,
      actor: ctx.alias,
      actorKind: ctx.isAgent ? "agent" : "human",
      onBehalfOf: ctx.onBehalfOf ?? null,
      source: ctx.surface,
      requestId: ctx.requestId,
    },
    input,
  );
}

/**
 * Append one event for a person acting through the sign-in pages, which run
 * before any request context exists: registration is where an invite link
 * brings a new person into a workspace.
 */
export function recordSignInAudit(jobs: NodeEnv["jobs"], alias: string, workspaceId: string | null, input: AuditInput): void {
  sendAudit(jobs, { workspaceId, actor: alias, actorKind: "human", onBehalfOf: null, source: "web" }, input);
}

/** This caller without a workspace, for node-wide events, which belong to no one tenant. */
export function nodeAuditCtx(ctx: Ctx): AccountCtx {
  const { workspaceId: _drop, principals: _principals, role: _role, ...rest } = ctx;
  return rest;
}

/** How long one row stands for its repeats, so per-request rows (refusals, ledger reads) do not amplify traffic. */
export const AUDIT_DEDUP_MS = 60_000;

/** The most distinct keys the window holds at once; swept on every consultation. */
const AUDIT_DEDUP_KEYS = 2_000;

/** When each key last reached the ledger, epoch ms. Process-wide and in memory. */
const auditWindow = new Map<string, number>();

/**
 * True the first time a key is seen inside the window. In memory per process, so
 * a restart or eviction errs toward a duplicate row, never a missing one.
 * Insertion order is recency order, so the sweep stops at the first live entry.
 */
export function noteAuditWindow(key: string, now: number = Date.now()): boolean {
  for (const [seen, at] of auditWindow) {
    if (now - at < AUDIT_DEDUP_MS) break;
    auditWindow.delete(seen);
  }
  if (auditWindow.has(key)) return false;
  auditWindow.set(key, now);
  while (auditWindow.size > AUDIT_DEDUP_KEYS) {
    const oldest = auditWindow.keys().next();
    if (oldest.done) break;
    auditWindow.delete(oldest.value);
  }
  return true;
}

/** Refusal rows one principal can add per window: the dedup key holds a caller-chosen path, so only a quota bounds breadth. */
const AUDIT_DENIAL_QUOTA = 20;

/** Principals the quota tracks at once. */
const AUDIT_DENIAL_PRINCIPALS = 2_000;

/** Rows each principal has already spent, and when their window opened. */
const denialBudget = new Map<string, { since: number; rows: number }>();

type DenialVerdict = "record" | "last" | "drop";

/** Spend one of a principal's refusal rows; eviction restores a budget, erring toward an extra row. */
function noteDenialBudget(principal: string, now: number = Date.now()): DenialVerdict {
  for (const [held, spent] of denialBudget) {
    if (now - spent.since < AUDIT_DEDUP_MS) break;
    denialBudget.delete(held);
  }
  let budget = denialBudget.get(principal);
  if (!budget) {
    budget = { since: now, rows: 0 };
    denialBudget.set(principal, budget);
    while (denialBudget.size > AUDIT_DENIAL_PRINCIPALS) {
      const oldest = denialBudget.keys().next();
      if (oldest.done) break;
      denialBudget.delete(oldest.value);
    }
  }
  if (budget.rows >= AUDIT_DENIAL_QUOTA) return "drop";
  budget.rows += 1;
  return budget.rows === AUDIT_DENIAL_QUOTA ? "last" : "record";
}

/** One refused request, as the front door describes it. */
interface DenialInput {
  method: string;
  path: string;
  httpStatus: number;
  /** The refusal sentence the caller was given, when it could be read. */
  message?: string;
  requestId?: string;
}

/** One row per (principal, route, status) per window, and at most AUDIT_DENIAL_QUOTA rows per principal. */
function recordDenial(ctx: AccountCtx & { workspaceId?: string }, input: DenialInput): void {
  // The node listing reads workspace-less rows only for `node.%` actions.
  const action = ctx.workspaceId ? "access.denied" : "node.access.denied";
  // The message stays out of the key, or rewording a refusal would defeat the window.
  const key = JSON.stringify([action, ctx.workspaceId ?? null, ctx.alias, input.path, input.httpStatus]);
  if (!noteAuditWindow(key)) return;
  const verdict = noteDenialBudget(JSON.stringify([ctx.workspaceId ?? null, ctx.alias]));
  if (verdict === "drop") return;
  recordAudit(ctx, {
    action,
    status: "denied",
    targetKind: "route",
    targetId: input.path,
    requestId: input.requestId,
    detail: {
      method: input.method,
      http_status: input.httpStatus,
      message: input.message,
      dedup_window_ms: AUDIT_DEDUP_MS,
      ...(verdict === "last"
        ? {
            quota_reached: {
              rows: AUDIT_DENIAL_QUOTA,
              window_ms: AUDIT_DEDUP_MS,
              note: "further refusals from this principal in this window are not recorded",
            },
          }
        : {}),
    },
  });
}

/** Refusals worth a row. 401 names no identity; 404 is how an ACL miss is answered and discloses nothing. */
const DENIED_STATUSES = new Set([403, 423, 429]);

/** The longest bare refusal body kept as the row's sentence. */
const REFUSAL_SENTENCE_MAX = 200;

/** The refusal a body states: `error()` JSON on the request path, a bare sentence on the upgrade. */
function refusalSentence(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === "string" ? parsed.error : undefined;
  } catch {
    const text = body.trim();
    return text && text.length <= REFUSAL_SENTENCE_MAX ? text : undefined;
  }
}

/**
 * Record a refusal the node answered with; the one place HTTP denials are
 * recorded. The sentence is read from a clone later, so the response is never
 * delayed, and a non-refusal is never cloned.
 */
export function noteDenial(
  ctx: AccountCtx & { workspaceId?: string },
  res: Response,
  input: Omit<DenialInput, "httpStatus" | "message">,
): void {
  if (!DENIED_STATUSES.has(res.status)) return;
  try {
    const copy = res.clone();
    const record = (message?: string) => recordDenial(ctx, { ...input, httpStatus: res.status, message });
    void copy
      .text()
      .then((body) => record(refusalSentence(body)))
      .catch(() => record());
  } catch {
    /* the ledger is best-effort */
  }
}

/** Append one row to the workspace event feed that agents poll and webhooks fan out from; best-effort. */
export function recordEvent(ctx: Ctx, type: WorkspaceEventType, docId: string | null, payload: Record<string, unknown> = {}): void {
  const message: IndexMessage = {
    kind: "event",
    workspaceId: ctx.workspaceId,
    type,
    docId,
    actor: ctx.isAgent ? agentPrincipal(ctx.alias) : userPrincipal(ctx.alias),
    actorKind: ctx.isAgent ? "agent" : "human",
    payload,
  };
  try {
    void ctx.env.jobs.send(message).catch(() => {});
  } catch {
    /* the feed is best-effort */
  }
}
