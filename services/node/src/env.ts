/**
 * What request handlers, actors and job workers reach for: `NodeConfig` is what
 * the environment fixes at boot, `NodeServices` what the process wires up from
 * it, including the settings stores for everything editable at runtime.
 */
import type { Sql } from "@stuga/db";
import type { ActorNamespace, BlobStore, InternalApi, JobQueue } from "@stuga/runtime";
import type { AuthConfig, TokenVerifier } from "@stuga/auth";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { RateLimiter } from "./platform/rate-limit.js";
import type { AiSettingsStore, ProviderBaseUrls } from "./config/settings/ai.js";
import type { NodeSettingsStore } from "./config/settings/node.js";
import type { NodeBackups } from "./ops/node-backups.js";
import type { SearchLanguages } from "./search/languages.js";

export interface NotifyConfig {
  /** slack | teams | discord | email | webhook | none */
  sink: string;
  webhookUrl?: string;
  smtpUrl?: string;
  emailFrom?: string;
}

export interface NodeConfig {
  /** The origin browsers and agents reach this node at: minted URLs, the origin
   *  allow-set, cookie flags and the token issuer all derive from it. */
  publicOrigin: string;
  /** Further exact origins browsers may call from. Minted links still use `publicOrigin`. */
  extraOrigins: readonly string[];
  databaseUrl: string;
  /** Root of the node's on-disk state (blobs, actor SQLite files, keys, secrets). */
  dataDir: string;
  auth: AuthConfig;
  /** Width of `doc_chunks.embedding`, read from the catalog at boot. */
  embeddingDims: number;
  /** The HMAC root for socket tickets, media tickets and upload signatures. */
  internalSecret: string;
  mediaCookieSameSite: "Lax" | "Strict" | "None";
  /** Believe X-Forwarded-For / X-Real-IP. */
  trustProxyHeaders: boolean;
  bind: string;
  port: number;
  /** One sentence telling an operator how an environment change takes effect. */
  restartHint: string;
  /** One sentence telling an operator how this packaging moves to a newer version. */
  upgradeHint: string;
  /**
   * The packaging's upgrade helper, where it has one (the Mac package): the directory the node
   * drops a request into, and the file the helper reports on (STUGA_UPGRADE_REQUESTS, STUGA_UPGRADE_STATUS).
   */
  upgradeHelper?: { requests: string; status: string };
  /** The stdio server path for local clients, "" for none; unset means the bundled server. */
  stdioEntry: string | undefined;
  /** Base URL per AI provider when a settings row names none. */
  aiProviderBaseUrls: ProviderBaseUrls;
  /** Where the sample workspaces are published, laid out as a GitHub release list (SAMPLES_URL). */
  samplesUrl: string;
}

interface NodeServices {
  /** The AI configuration in force; the AI settings routes refresh it after a save. */
  aiSettings: AiSettingsStore;
  /** Every other setting the Settings page edits. */
  settings: NodeSettingsStore;
  /** The languages keyword search answers for, and the rebuild of its indexes when they change. */
  searchLanguages: SearchLanguages;
  /** Verifies a bearer session token against the node's own signing key. */
  verifier: TokenVerifier;
  /** One actor per prose document: the live CRDT session. */
  docs: ActorNamespace;
  /** One actor per structured database. */
  databases: ActorNamespace;
  /** Document snapshots, run-ledger payloads and other per-document blobs. */
  snapshots: BlobStore;
  /** Uploaded images, keyed by workspace + content hash. */
  media: BlobStore;
  jobs: JobQueue<IndexMessage>;
  /** Per-principal request budget. */
  rateLimit: RateLimiter;
  /** In-process calls into the internal handler on behalf of actors. */
  internal: InternalApi;
  /** A pooled Postgres client. Shared and long-lived; callers never end it. */
  sql: Sql;
  /** The version the boot before this one recorded, or null on the first boot. */
  previousVersion: string | null;
  /** Chosen by the first boot against this database and kept for good; the name can change, this cannot. */
  nodeId: string;
  /** The backups the running node takes of itself; absent where nothing can quiet the node (tests). */
  backups?: NodeBackups;
}

export type NodeEnv = NodeConfig & NodeServices;
