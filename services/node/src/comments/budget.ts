/**
 * How many notifications one person's agents may cause: a ceiling on the pings an agent's comments
 * send, however it varies its mentions or threads, and whichever of its person's keys and
 * connectors it uses, over MCP or REST.
 */

/** Notices per rolling hour, per workspace and person, across all of that person's agents. */
export const AGENT_NOTICES_PER_HOUR = 60;

const HOUR_MS = 3_600_000;

/** Past this many tracked people, a reservation also drops everyone whose hour has passed. */
const SWEEP_AT = 1_000;

/**
 * A rolling hour's allowance per key, held in the node's memory: a restart forgets it, which at
 * worst lets one more hour's worth through. Reserved before a notice is queued, so two comments
 * racing cannot both spend the last of it.
 */
export class NoticeBudget {
  /** When each notice in the last hour was granted, oldest first. */
  private readonly granted = new Map<string, number[]>();

  constructor(
    private readonly perHour = AGENT_NOTICES_PER_HOUR,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take up to `wanted` notices from `key`'s allowance; how many it granted. */
  reserve(key: string, wanted: number): number {
    const at = this.now();
    if (this.granted.size > SWEEP_AT) this.sweep(at);
    const recent = this.recent(key, at);
    const take = Math.max(0, Math.min(wanted, this.perHour - recent.length));
    for (let i = 0; i < take; i++) recent.push(at);
    if (recent.length > 0) this.granted.set(key, recent);
    else this.granted.delete(key);
    return take;
  }

  private recent(key: string, at: number): number[] {
    return (this.granted.get(key) ?? []).filter((t) => t > at - HOUR_MS);
  }

  private sweep(at: number): void {
    // A Map may lose entries while it is iterated.
    for (const key of this.granted.keys()) {
      if (this.recent(key, at).length === 0) this.granted.delete(key);
    }
  }
}

/** The node's one allowance for agents' notices. */
export const agentNoticeBudget = new NoticeBudget();

/** Whose allowance an agent's notices come out of: its person's, in this workspace. */
export function agentBudgetKey(workspaceId: string, person: string): string {
  return `${workspaceId}\n${person}`;
}
