import { api } from "../lib/http/client";

/** One (model, kind) bucket of this month's AI activity. The index signature satisfies Astryx <Table>. */
/** Disjoint counts: a prompt the provider served from its cache is counted there, not in `input_tokens`. */
interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface UsageByModel extends TokenCounts {
  model: string;
  /** coauthor | table_coauthor | ask | embedding */
  kind: string;
  calls: number;
  [k: string]: unknown;
}

export interface UsageByPrincipal extends TokenCounts {
  alias: string;
  model: string;
  calls: number;
  [k: string]: unknown;
}

/** Everything the model read, cached or not. */
export function tokensRead(r: TokenCounts): number {
  return r.input_tokens + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0);
}

export interface UsageReport {
  period: { since: string; label: string };
  by_model: UsageByModel[];
  by_principal: UsageByPrincipal[];
}

export const Usage = {
  get: () => api<UsageReport>("/api/usage"),
};
