import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { api } from "../lib/http/client";

interface RunDetail {
  run: AgentRunSummary;
  /** `full` only: the document when the run opened. */
  baseline_markdown?: string;
  /** `full` only: the document after the run committed; null while it is open. */
  final_markdown?: string | null;
  /** `full` only: every hunk, untruncated. */
  hunks?: AgentRunHunk[];
}

/** One agent's editing session on one document: hunks awaiting review, or applied at once on an `auto` document. */
export const Runs = {
  /** Newest first, open runs hoisted. Each row costs the server a blob read, so ask only for what is shown. */
  list: (docId: string, limit: number) =>
    api<{ runs: AgentRunSummary[] }>(`/api/docs/${docId}/runs?limit=${limit}`),
  detail: (docId: string, runId: string, opts: { full?: boolean } = {}) =>
    api<RunDetail>(`/api/docs/${docId}/runs/${runId}${opts.full ? "?full=1" : ""}`),
  /**
   * Decide all pending hunks, or `hunkIds`. `blocked` hunks stay pending because
   * an earlier hunk they quote is still undecided; `conflicts` are gone for good.
   */
  decide: (docId: string, runId: string, decision: "accept" | "reject", hunkIds?: string[]) =>
    api<{ run: AgentRunSummary; applied: number; conflicts: number; blocked: number }>(
      `/api/docs/${docId}/runs/${runId}/decision`,
      { method: "POST", body: JSON.stringify({ decision, hunk_ids: hunkIds }) },
    ),
  /** 409 when the document has moved on underneath the run. */
  revert: (docId: string, runId: string) =>
    api<{ run: AgentRunSummary; reverted: number }>(`/api/docs/${docId}/runs/${runId}/revert`, {
      method: "POST",
    }),
  /** Dismiss the catch-up card everywhere. */
  ack: (docId: string, runId: string) =>
    api<{ ok: boolean }>(`/api/docs/${docId}/runs/${runId}/ack`, { method: "POST" }),
};

/** One run as the workspace inbox lists it: counts, not hunk text. */
export interface InboxRun {
  run_id: string;
  doc_id: string;
  doc_kind: "prose" | "database";
  doc_title: string;
  source: string;
  agent: string;
  agent_alias: string;
  /** The key's name while the key exists, else the run's own label. */
  agent_name: string;
  /** Labels the agent sent, if any. */
  client: string | null;
  model: string | null;
  reviewer: string;
  status: "open" | "applied" | "rejected" | "expired" | string;
  review_mode: ReviewMode;
  auto_applied: boolean;
  reverted: boolean;
  acknowledged: boolean;
  pending: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  applied: number;
  created_at: string;
  updated_at: string;
  /** Satisfies Astryx <Table>. */
  [k: string]: unknown;
}

export type InboxFilter = "attention" | "open" | "closed" | "all";

export interface AgentStats {
  agent_alias: string;
  agent: string;
  agent_name: string;
  runs: number;
  open_runs: number;
  pending: number;
  accepted: number;
  rejected: number;
  applied: number;
  reverted_runs: number;
  last_active_at: string;
  /** accepted / (accepted + rejected); null with nothing decided. */
  acceptance_rate: number | null;
  [k: string]: unknown;
}

/** The most runs one inbox request returns. */
export const INBOX_PAGE_LIMIT = 100;

export const Inbox = {
  list: (filter: InboxFilter = "attention", agent?: string, limit = INBOX_PAGE_LIMIT) => {
    const q = new URLSearchParams({ filter, limit: String(limit) });
    if (agent) q.set("agent", agent);
    return api<{ runs: InboxRun[]; filter: InboxFilter }>(`/api/runs?${q}`);
  },
  stats: () => api<{ agents: AgentStats[] }>("/api/agents/stats"),
};
