import { api } from "../lib/http/client";

/** One (model, kind) bucket of this month's AI activity. The index signature satisfies Astryx <Table>. */
export interface UsageByModel {
  model: string;
  /** coauthor | table_coauthor | ask | embedding */
  kind: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  [k: string]: unknown;
}

export interface UsageByPrincipal {
  alias: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  [k: string]: unknown;
}

export interface UsageReport {
  period: { since: string; label: string };
  by_model: UsageByModel[];
  by_principal: UsageByPrincipal[];
}

export const Usage = {
  get: () => api<UsageReport>("/api/usage"),
};
