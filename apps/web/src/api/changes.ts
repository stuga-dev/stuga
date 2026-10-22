import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { NewPageState } from "@stuga/protocol/domain/changes";
import type { RunStanding } from "@stuga/protocol/domain/runs";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { api } from "../lib/http/client";
import type { RunDeciders } from "./runs";

/** One page of a change as its card shows it: its runs as the reader may read them, and who decides them. */
export interface ChangePage {
  doc_id: string;
  doc_kind: "prose" | "database";
  title: string;
  /** The folders above it the reader can open, root first. */
  path: string[];
  locked: boolean;
  /** The level its waiting changes are decided at. */
  level: ReviewMode;
  /** A page the change made. */
  new: boolean;
  /** For a new page: held until approved, released, or removed. */
  state?: NewPageState;
  /** Why a removed page was declined, for whoever reads its changes. */
  note?: string;
  runs: Array<AgentRunSummary | DatabaseRunSummary>;
  /** For a held page with no change of its own yet: where the reader stands on approving it. */
  page_you?: RunStanding;
  /** Who may decide its waiting changes, for whoever reads them. */
  deciders?: RunDeciders;
  /** Its changes wait behind another of the agent's changes to it. */
  queued_behind?: { run_id: string; change_id: string | null; change_title?: string };
}

/** A change: one piece of an agent's work across several pages, reviewed as one. */
export interface ChangeCard {
  change: {
    change_id: string;
    /** The agent's words about waiting text: null for a reader who reads none of it. */
    title: string | null;
    summary: string | null;
    agent: string;
    agent_alias: string;
    agent_name: string;
    client: string | null;
    model: string | null;
    asked_by: string;
    created_at: string;
    updated_at: string;
  };
  pages: ChangePage[];
}

/** Why changes are left after Approve all. */
export type LeftReason = "view_only" | "locked" | "refused" | "queued" | "gone" | "own" | "colleague" | "group" | "reviewer" | "nobody";

/** What a change decision did to one page. */
export interface ChangePageOutcome {
  doc_id: string;
  title: string;
  approved: number;
  declined: number;
  conflicts: number;
  left: number;
  reasons: LeftReason[];
  state?: NewPageState;
}

/** A change as the inbox lists it: one row for all its runs the reader can see. */
export interface InboxChange {
  change_id: string;
  title: string | null;
  agent: string;
  agent_alias: string;
  agent_name: string;
  source: string;
  client: string | null;
  model: string | null;
  reviewer: string;
  run_ids: string[];
  pages: number;
  page_titles: string[];
  pending: number;
  /** Of those, the ones the reader may approve now. */
  pending_yours?: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  applied: number;
  level: ReviewMode;
  you: { accept: boolean; reject: boolean; queued?: true; waits_for?: "colleague" | "nobody" | "group" };
  can_decide: boolean;
  status: "open" | "decided";
  created_at: string;
  updated_at: string;
}

export const Changes = {
  get: (changeId: string) => api<ChangeCard>(`/api/changes/${encodeURIComponent(changeId)}`),
  /**
   * `accept` approves every change of it the reader may approve, page by page; `reject` declines every
   * one they may decline, each with the note. Not atomic: the answer says per page what was decided.
   */
  decide: (changeId: string, decision: "accept" | "reject", note?: string) =>
    api<{ change_id: string; decision: "accept" | "reject"; atomic: false; pages: ChangePageOutcome[] }>(
      `/api/changes/${encodeURIComponent(changeId)}/decision`,
      { method: "POST", body: JSON.stringify({ decision, ...(note ? { note } : {}) }) },
    ),
};
