import type { AiConfig } from "@stuga/ai";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { BlobStore, InternalApi, JobQueue } from "@stuga/runtime";

/** What the node hands every DocActor at construction. */
export interface DocActorEnv {
  /** CRDT snapshots and run bodies. */
  snapshots: BlobStore;
  /** Index, notify, audit, usage and run-mirror jobs. */
  jobs: JobQueue<IndexMessage>;
  /** The AI configuration in force now; a turn resolves it once. */
  ai: () => AiConfig;
  /** The node's `/internal/*` handler, for the co-author's cross-document tools and media. */
  internal: InternalApi;
}
