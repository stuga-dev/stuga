/**
 * Boot, in order: config → Postgres checks and writer lock → listener, which
 * says the node is starting until it serves → a backup when another version
 * served this database last → schema → settings and signing key → actor hosts,
 * stores and queue → routers → serving → background workers. The actors call
 * back in through `env.internal`, whose handler needs the finished env, so it
 * delegates through a slot filled last.
 */
import { join } from "node:path";
import {
  closeClients,
  countAccounts,
  createClient,
  embeddingColumnDims,
  initSchema,
  pgJobQueue,
  recordNodeBoot,
  runBootRepairs,
  startJobWorker,
} from "@stuga/db";
import { createRelyingParty, createVerifier, loadOrCreateSigningKey } from "@stuga/auth";
import { createActorNamespace, fsBlobStore } from "@stuga/runtime";
import { DOC_STORE_VERSION, DocActor, type DocActorEnv } from "@stuga/doc-actor";
import { DATABASE_STORE_VERSION, DatabaseActor, type DatabaseActorEnv } from "@stuga/database-actor";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { Heartbeat } from "@stuga/protocol/wire/opcodes";
import { inviteRedeemedAudit } from "../api/invites.js";
import { recordSignInAudit } from "../audit/record.js";
import { ConfigError, parseConfig } from "../config/env.js";
import { createAiSettingsStore } from "../config/settings/ai.js";
import { createNodeSettingsStore, issuerHost } from "../config/settings/node.js";
import type { NodeEnv } from "../env.js";
import { createApp, createRequestHandler } from "../http/dispatch.js";
import { createRateLimiters } from "../http/rate-limit.js";
import { withSecurityHeaders } from "../http/security-headers.js";
import { createIdentityRouter, identityDb } from "../identity/index.js";
import { handleInternalRequest } from "../internal/routes.js";
import { runMaintenanceTick } from "../jobs/maintenance.js";
import { handleJobBatch } from "../jobs/worker.js";
import { createServingGate } from "../http/serving-gate.js";
import { DEFAULT_MAX_UPLOAD_BYTES, bodyBytesFor } from "../media/media.js";
import { parseBackupEnv } from "../ops/env.js";
import { formatSetupCode, loadOrCreateSetupCode, removeSetupCode, setupLink } from "../identity/setup-code.js";
import { createHttpServer, type TlsOptions } from "../platform/http-server.js";
import { createInternalApi } from "../platform/internal-api.js";
import { startInterval } from "../platform/interval.js";
import { serveStatic } from "../platform/static.js";
import { VERSION, bootSummary } from "../version.js";
import { holdWriterLock } from "../writer-lock.js";
import { assertDatabaseLocale, assertPgSearch, assertPostgresVersion } from "./preflight.js";
import { runShutdown, SHUTDOWN_DEADLINE_MS } from "./shutdown.js";
import { backupBeforeUpgrade } from "./upgrade-backup.js";
import { createNodeBackups, notifyBackupFailed } from "../ops/node-backups.js";
import { createExclusive } from "../platform/exclusive.js";

const MAINTENANCE_INTERVAL_MS = 2 * 60_000;
/** How long a backup of the running node waits for the requests already being answered. */
const BACKUP_DRAIN_MS = 60_000;

/** Start the node, or exit 1 with the reason it cannot. */
export async function serve(): Promise<void> {
  await boot().catch((err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(`[node] configuration error: ${err.message}`);
    } else {
      console.error("[node] failed to start", err);
    }
    process.exit(1);
  });
}

async function boot(): Promise<void> {
  const cfg = parseConfig(process.env);

  // ---- database ------------------------------------------------------------
  const sql = createClient(cfg.databaseUrl);

  // Before any DDL, so a wrong server is refused before it is written to.
  await assertPostgresVersion(sql);
  await assertPgSearch(sql);
  await assertDatabaseLocale(sql);

  // Before any DDL, so migrations never run against a database a restore is replacing.
  // Losing the lock exits at once rather than shutting down gracefully: a job
  // batch still committing could land in a database a restore just put in place.
  const writer = await holdWriterLock(cfg.databaseUrl, (reason) => {
    console.error(`[node] ${reason}; stopping, because a node that cannot prove it is the only writer may be running beside a restore`);
    process.exit(1);
  });
  if (!writer.held) {
    throw new ConfigError(
      writer.reason === "another-node"
        ? "another Stuga node is already running against this database — two nodes on one database would each run their own copy of every document. Stop the other one first."
        : "a backup or restore of this database is in progress. Start the node again when it has finished.",
    );
  }

  // ---- listener ------------------------------------------------------------
  // Open as soon as the database is this node's: until it serves, the gate says what it is doing.
  const gate = createServingGate();
  let bodyLimit = (): number => bodyBytesFor(DEFAULT_MAX_UPLOAD_BYTES);
  let tls: TlsOptions | undefined;
  if (cfg.tlsCertDir) tls = { certDir: cfg.tlsCertDir, defaultHost: new URL(cfg.publicOrigin).hostname };
  const server = createHttpServer({
    handler: withSecurityHeaders(gate.handler),
    // A refused upgrade is an ordinary HTTP response; a completed handshake carries its own headers.
    upgrade: withSecurityHeaders(gate.upgrade),
    publicOrigin: cfg.publicOrigin,
    bind: cfg.bind,
    port: cfg.port,
    maxBodyBytes: () => bodyLimit(),
    ...(tls ? { tls } : {}),
  });
  const bound = await server.listen();

  // Stopped while starting: a backup in progress cleans up after itself first; anything else just stops.
  const starting = new AbortController();
  let backingUp = false;
  const stopWhileStarting = (signal: NodeJS.Signals) => {
    console.info(`[node] ${signal} while starting: stopping`);
    starting.abort();
    if (!backingUp) process.exit(0);
  };
  process.on("SIGTERM", stopWhileStarting);
  process.on("SIGINT", stopWhileStarting);

  // ---- a backup before an upgrade ------------------------------------------
  const backupEnv = parseBackupEnv(process.env);
  const upgrade = await backupBeforeUpgrade({
    sql,
    env: backupEnv,
    writer,
    signal: starting.signal,
    onStart: (from) => {
      backingUp = true;
      gate.pause("backing_up");
      console.info(`[node] this database was last served by Stuga ${from}; backing it up before upgrading to ${VERSION}`);
    },
  }).catch((err: unknown) => {
    if (starting.signal.aborted) process.exit(0);
    throw new ConfigError(
      `the backup this node takes before upgrading a database did not complete, so nothing was upgraded ` +
        `and the database is as the previous version left it: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  backingUp = false;
  if (upgrade.taken) {
    console.info(`[node] backed up Stuga ${upgrade.from}'s data before upgrading: ${upgrade.path}`);
  } else if (upgrade.reason === "already-taken") {
    console.info(`[node] upgrading from Stuga ${upgrade.from}; its data was backed up before an earlier attempt: ${upgrade.path}`);
  }
  if (upgrade.taken || upgrade.reason === "already-taken") gate.pause("upgrading");
  else gate.pause("starting");

  const schema = await initSchema(sql, { embeddingDims: cfg.embeddingDims }).catch((err: unknown) => {
    throw err instanceof ConfigError ? err : new ConfigError(err instanceof Error ? err.message : String(err));
  });

  const repairs = await runBootRepairs(sql, { searchLanguages: cfg.searchLanguages });
  if (repairs.updatedExtensions.length > 0) {
    console.info(`[node] extensions updated to this build's versions: ${repairs.updatedExtensions.join(", ")}`);
  }
  if (repairs.searchIndexChanges.length > 0) {
    console.info(
      `[node] SEARCH_LANGUAGES=${cfg.searchLanguages.join(",") || "(none)"}: ` +
        `${repairs.searchIndexChanges.join(", ")} (a + is one index built over the whole corpus, once)`,
    );
  }
  if (repairs.rebuiltSearchIndexes.length > 0) {
    console.info(`[node] search indexes rebuilt for this pg_search: ${repairs.rebuiltSearchIndexes.join(", ")}`);
  }

  // Only whoever holds the setup code may make the first account, which administers the node.
  let setupCode = (await countAccounts(sql)) === 0 ? await loadOrCreateSetupCode(cfg.dataDir) : null;

  // The column's width is fixed when the database is created; embeddings at any
  // other width would be refused by it.
  const columnDims = await embeddingColumnDims(sql);
  if (columnDims !== null && columnDims !== cfg.embeddingDims) {
    throw new ConfigError(
      `AI_EMBED_DIMS is ${cfg.embeddingDims} but this database stores doc_chunks.embedding as vector(${columnDims}). ` +
        `The column's width is fixed when the database is created and cannot be changed by configuration. ` +
        `Either set AI_EMBED_DIMS=${columnDims}, or re-create the column and re-embed — see docs/operations.md.`,
    );
  }
  cfg.embeddingDims = columnDims ?? cfg.embeddingDims;

  // Stamped only after every refusal above, so a build that did not start is never recorded.
  const { nodeId, previousVersion } = await recordNodeBoot(sql, VERSION);
  console.info(`[node] ${bootSummary({ version: VERSION, previousVersion, schema })}`);

  const aiSettings = await createAiSettingsStore({
    sql,
    dataDir: cfg.dataDir,
    embeddingDims: cfg.embeddingDims,
    baseUrls: cfg.aiProviderBaseUrls,
  });
  const settings = await createNodeSettingsStore({ sql, dataDir: cfg.dataDir, publicOrigin: cfg.publicOrigin });
  bodyLimit = () => settings.current().maxBodyBytes;

  const keys = await loadOrCreateSigningKey(cfg.auth.keyFile);
  const verifier = createVerifier(cfg.auth, keys);

  // ---- services ------------------------------------------------------------
  const snapshots = fsBlobStore(join(cfg.dataDir, "blobs", "snapshots"));
  const media = fsBlobStore(join(cfg.dataDir, "blobs", "media"));
  const jobs = pgJobQueue<IndexMessage>(sql);

  let internalEnv: NodeEnv | null = null;
  const internal = createInternalApi(async (req) =>
    internalEnv ? handleInternalRequest(req, internalEnv) : new Response("node is starting", { status: 503 }),
  );

  // `ai` is a getter: every actor shares this env object, so each turn reads the settings in force.
  const docEnv: DocActorEnv = { snapshots, jobs, ai: () => aiSettings.current(), internal };
  const heartbeat = { request: Heartbeat.PING, response: Heartbeat.PONG };
  const docs = createActorNamespace(DocActor, docEnv, {
    name: "docs",
    heartbeat,
    dir: join(cfg.dataDir, "actors", "docs"),
    storeVersion: DOC_STORE_VERSION,
  });
  const databaseEnv: DatabaseActorEnv = { snapshots, jobs };
  const databases = createActorNamespace(DatabaseActor, databaseEnv, {
    name: "databases",
    heartbeat,
    dir: join(cfg.dataDir, "actors", "databases"),
    storeVersion: DATABASE_STORE_VERSION,
  });

  const limiters = createRateLimiters();

  const { tlsCertDir: _tlsCertDir, webDistDir, ...nodeConfig } = cfg;
  const env: NodeEnv = {
    ...nodeConfig,
    docs,
    databases,
    snapshots,
    media,
    jobs,
    rateLimit: limiters.standard,
    internal,
    sql,
    aiSettings,
    settings,
    verifier,
    previousVersion,
    nodeId,
  };
  internalEnv = env;

  // ---- routers -------------------------------------------------------------
  const app = createApp(env);

  const identity = createIdentityRouter({
    auth: cfg.auth,
    publicOrigin: cfg.publicOrigin,
    extraOrigins: cfg.extraOrigins,
    db: identityDb(sql),
    keys,
    verifier,
    identityProvider: () => settings.current().identityProvider,
    relyingParty: createRelyingParty(),
    nodeName: () => settings.current().nodeName,
    nodeLabel: () => settings.current().nodeLabel,
    branding: () => settings.current().branding,
    setupCode: () => setupCode,
    onFirstAccount: (alias) => {
      console.info("[node] first account created; it administers this node", { alias });
      setupCode = null;
      void removeSetupCode(cfg.dataDir).catch((err: unknown) => console.warn("[node] could not remove the used setup code", err));
      // Setup may have turned the look for newer versions off, in the account's own transaction.
      void settings.refresh().catch(() => {});
    },
    onInviteRedeemed: ({ alias, tokenHash, workspaceId, role }) =>
      recordSignInAudit(jobs, alias, workspaceId, inviteRedeemedAudit(tokenHash, role)),
    // Node-level rows, like a minted password reset: how a person signs in belongs to no workspace.
    onIdentityChange: ({ alias, action, detail }) =>
      recordSignInAudit(jobs, alias, null, { action, targetKind: "node", targetId: cfg.publicOrigin, detail }),
    limiter: limiters.auth,
    trustProxyHeaders: cfg.trustProxyHeaders,
  });

  const spa = serveStatic(webDistDir);

  const handler = createRequestHandler({ identity, app, spa });

  // ---- serving -------------------------------------------------------------
  gate.open({ handler, upgrade: (req) => app.upgrade(req) });

  // ---- background work -----------------------------------------------------
  const startWorker = () => startJobWorker<IndexMessage>(sql, (batch) => handleJobBatch(env, batch));
  let worker = startWorker();

  // The backups the node takes while it runs: one at a time with the maintenance tick, since a tick
  // purges blobs and actors a backup must see whole.
  const exclusive = createExclusive();
  env.backups = createNodeBackups({
    sql,
    env: backupEnv,
    writer,
    schedule: () => ({ ...settings.current().backups, timeZone: settings.current().timeZone }),
    quiesce: async () => {
      gate.pause("maintenance");
      if (!(await gate.drain(BACKUP_DRAIN_MS))) {
        gate.open();
        throw new Error(`requests were still being answered after ${BACKUP_DRAIN_MS / 1000}s, so the node did not pause to back up`);
      }
      await worker.stop();
      const resume = async () => {
        docs.resume();
        databases.resume();
        worker = startWorker();
        gate.open();
      };
      try {
        await docs.pause();
        await databases.pause();
      } catch (err) {
        await resume();
        throw err;
      }
      return resume;
    },
    exclusive,
    notifyFailure: (message, at) => notifyBackupFailed(env, message, at),
  });

  const maintenance = startInterval(MAINTENANCE_INTERVAL_MS, () =>
    exclusive(async () => {
      // Also picks up hand edits to the settings tables.
      await aiSettings.refresh().catch(() => {});
      await settings.refresh().catch(() => {});
      await runMaintenanceTick(env);
      await env.backups?.runIfDue();
    }),
  );

  const claim = setupCode ? "unclaimed" : "claimed";
  const idp = settings.current().identityProvider;
  console.info(
    `[node] listening on ${tls ? "https" : "http"}://${bound.address}:${bound.port} (public origin ${cfg.publicOrigin}, ${claim}, ` +
      `identity provider ${idp ? issuerHost(idp.issuer) : "none"}, ai ${aiSettings.current().enabled ? "on" : "off"})`,
  );
  if (setupCode) {
    console.info(
      `[node] nobody has set up this node yet. Open ${setupLink(cfg.publicOrigin, setupCode)} to create its administrator ` +
        `(setup code ${formatSetupCode(setupCode)}).`,
    );
  }

  // ---- shutdown ------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[node] ${signal}: shutting down`);
    const result = await runShutdown([
      { name: "HTTP listener", run: () => server.close() },
      { name: "maintenance loop", run: () => maintenance.stop() },
      { name: "job worker", run: () => worker.stop() },
      { name: "document actors", run: () => docs.close() },
      { name: "database actors", run: () => databases.close() },
      { name: "Postgres connections", run: () => closeClients() },
      { name: "writer lock", run: () => writer.release() },
    ]);
    if (result.outcome === "failed") {
      console.error(`[node] shutdown error while closing the ${result.step}`, result.error);
      process.exitCode = 1;
    } else if (result.outcome === "deadline") {
      console.error(
        `[node] shutdown did not finish within ${SHUTDOWN_DEADLINE_MS / 1000}s, still waiting on the ${result.step}; exiting anyway ` +
          `(actor stores are SQLite in WAL mode, and clients resend unjournaled edits when they reconnect)`,
      );
      process.exitCode = 1;
    }
    process.exit();
  };
  process.off("SIGTERM", stopWhileStarting);
  process.off("SIGINT", stopWhileStarting);
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
