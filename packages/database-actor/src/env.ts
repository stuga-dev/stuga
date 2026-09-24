import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { BlobStore, JobQueue } from "@stuga/runtime";

export interface DatabaseActorEnv {
  /** Spilled payloads live under `<dbId>/db-ops/` (ledger inverses) and `<dbId>/db-runs/` (run ops). */
  snapshots: BlobStore;
  /** The actor's only way to reach Postgres-backed work: run_index, notify and event messages. */
  jobs: JobQueue<IndexMessage>;
}
