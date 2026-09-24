/** What the job handlers read from the node, and the dependencies tests replace. */
import { AiError, type AiConfig, type EmbedResult, embed } from "@stuga/ai";
import type { NodeEnv, NotifyConfig } from "../env.js";
import { type JobsDb, jobsDb } from "./db.js";
import { type NotificationPayload, type SinkIo, deliver } from "./sinks.js";

export type JobsEnv = Pick<
  NodeEnv,
  "sql" | "snapshots" | "jobs" | "docs" | "databases" | "aiSettings" | "settings" | "publicOrigin" | "embeddingDims"
>;

export interface JobDeps {
  db: JobsDb;
  embed: (cfg: AiConfig, texts: string[]) => Promise<EmbedResult>;
  deliver: (cfg: NotifyConfig, n: NotificationPayload, io?: SinkIo) => Promise<void>;
  /** What webhook deliveries POST with. */
  fetch: typeof globalThis.fetch;
  log: Pick<Console, "info" | "warn" | "error">;
}

export function jobDeps(env: JobsEnv, deps: Partial<JobDeps>): JobDeps {
  return {
    db: deps.db ?? jobsDb(env.sql),
    embed: deps.embed ?? embed,
    deliver: deps.deliver ?? deliver,
    fetch: deps.fetch ?? globalThis.fetch,
    log: deps.log ?? console,
  };
}

/** A non-retryable AiError fails identically on every retry; anything else is worth retrying. */
export function isTerminal(err: unknown): boolean {
  return err instanceof AiError && !err.retryable;
}
