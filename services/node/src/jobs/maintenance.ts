/** The maintenance tick: heal what indexing left behind, and purge what retention says may go. */
import { AiError, chunkEmbedInput } from "@stuga/ai";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { sweepExpiredImports } from "../databases/imports/staging.js";
import { destroyActorStorage } from "../documents/access.js";
import { lookForUpdates } from "../updates/check.js";
import { VERSION } from "../version.js";
import { type JobDeps, type JobsEnv, isTerminal, jobDeps } from "./deps.js";

/** Chunks the reconcile sweep embeds per tick. */
const RECONCILE_CHUNKS_PER_TICK = 40;
/** A chunk that fails to embed this many times drops out of the reconcile set. */
const MAX_EMBED_ATTEMPTS = 5;
const BACKFILL_WORKSPACES_PER_TICK = 3;
const BACKFILL_DOCS_PER_TICK = 300;
const AGENT_KEY_RETENTION_DAYS = 30;
/** Registration is open to anyone who reaches the node, so unused OAuth clients expire; a client re-registers when its id stops working. */
const OAUTH_CLIENT_RETENTION_DAYS = 90;
const NOTIFICATION_RETENTION_DAYS = 90;
const REFRESH_SESSION_GRACE_DAYS = 7;
/** How long a closed run stays in the review inbox; the actors keep their own ledgers. */
const AGENT_RUN_RETENTION_DAYS = 365;
/** A feed consumer polling less often than this restarts from the newest id. */
const EVENT_RETENTION_DAYS = 30;

/** Embed chunks left without a vector by an earlier failure, a bounded number per tick. */
async function reconcileMissingEmbeddings(env: JobsEnv, d: JobDeps): Promise<void> {
  const ai = env.aiSettings.current();
  if (!ai.embed.enabled) return;
  const chunks = await d.db.findChunksMissingEmbeddings(RECONCILE_CHUNKS_PER_TICK, MAX_EMBED_ATTEMPTS);
  if (chunks.length === 0) return;
  let healed = 0;
  let gaveUp = 0;
  for (const c of chunks) {
    const text = chunkEmbedInput(c.title, c.heading_path, c.content, c.is_first);
    try {
      const res = await d.embed(ai, [text]);
      const vector = res.embeddings[0];
      if (!vector) throw new AiError("embed returned no vector", 0, false);
      await d.db.setChunkEmbedding(c.doc_id, c.chunk_index, vector, env.embeddingDims);
      healed++;
    } catch (err) {
      // Counted either way, so even transient failures are bounded by MAX_EMBED_ATTEMPTS.
      await d.db.bumpChunkEmbedAttempt(c.doc_id, c.chunk_index).catch(() => {});
      if (isTerminal(err)) {
        gaveUp++;
        d.log.error("reconcile: terminal embed failure, attempt recorded", { docId: c.doc_id, chunkIndex: c.chunk_index, err: String(err) });
      } else {
        d.log.warn("reconcile: transient embed failure, will retry next tick", { docId: c.doc_id, chunkIndex: c.chunk_index, err: String(err) });
      }
    }
  }
  if (healed > 0 || gaveUp > 0) {
    d.log.warn(`reconcile: healed ${healed}/${chunks.length} chunk(s) in place${gaveUp ? `, ${gaveUp} terminal` : ""}`);
  }
}

/**
 * Re-index the documents of workspaces armed for an embedding backfill, one job
 * per document, forward-only over a keyset cursor.
 */
async function backfillWorkspaces(env: JobsEnv, d: JobDeps): Promise<void> {
  if (!env.aiSettings.current().embed.enabled) return;
  const workspaces = await d.db.listWorkspacesAwaitingBackfill(BACKFILL_WORKSPACES_PER_TICK);
  for (const ws of workspaces) {
    const docs = await d.db.listDocsNeedingEmbeddingBackfill(ws.workspace_id, BACKFILL_DOCS_PER_TICK, ws.embedding_backfill_cursor);
    if (docs.length === 0) {
      await d.db.advanceEmbeddingBackfill(ws.workspace_id, null);
      d.log.info("backfill: workspace complete", { workspaceId: ws.workspace_id });
      continue;
    }
    for (const doc of docs) {
      await env.jobs.send({
        kind: "index_doc",
        docId: doc.doc_id,
        snapshotSeq: doc.snapshot_seq,
        title: doc.title,
        // The text is unchanged, which is exactly what the content-hash dedup would skip.
        force: true,
        reason: "embedding_backfill",
      });
    }
    // Past the last document enqueued, not the last one embedded.
    await d.db.advanceEmbeddingBackfill(ws.workspace_id, docs[docs.length - 1]!.doc_id);
    d.log.info("backfill: enqueued", { workspaceId: ws.workspace_id, docs: docs.length });
  }
}

/**
 * Hard-delete documents whose trash retention elapsed, in the order "Delete
 * forever" uses: a database's remaining row pages go to the trash, the
 * snapshot sweep is queued, the row cascade takes the rest, and the actor is
 * destroyed. A document that fails before its row is gone is retried next tick.
 */
async function purgeExpiredTrash(env: JobsEnv, d: JobDeps): Promise<void> {
  const expired = await d.db.findExpiredTrash(TRASH_RETENTION_DAYS);
  for (const { doc_id: docId, doc_type: docType } of expired) {
    try {
      if (docType === "database") {
        // Before the row goes, or its foreign key releases the pages as ordinary documents.
        const pages = await d.db.trashPagesOf(docId).catch((err: unknown) => {
          d.log.warn("trash purge: could not trash a database's remaining pages", { docId, err: String(err) });
          return [] as string[];
        });
        if (pages.length > 0) d.log.info(`trash purge: ${pages.length} page(s) of database ${docId} moved to the trash with it`);
      }
      await d.db.queueSnapshotSweep(docId);
      await d.db.deleteDoc(docId);
      await destroyActorStorage(env, docId, docType);
    } catch (err) {
      d.log.error("trash purge failed for doc", { docId, err: String(err) });
    }
  }
  if (expired.length > 0) d.log.warn(`trash purge: hard-deleted ${expired.length} expired doc(s)`);
}

async function sweepStagedImports(env: JobsEnv, d: JobDeps): Promise<void> {
  const swept = await sweepExpiredImports(env, Date.now());
  if (swept > 0) d.log.info("swept expired import stagings", { swept });
}

async function purgeRetention(env: JobsEnv, d: JobDeps): Promise<void> {
  const keys = await d.db.purgeRevokedApiKeys(AGENT_KEY_RETENTION_DAYS);
  if (keys > 0) d.log.info("purged revoked agent keys", { purged: keys });
  const notifications = await d.db.purgeOldNotifications(NOTIFICATION_RETENTION_DAYS);
  if (notifications > 0) d.log.info("purged old notifications", { purged: notifications });
  const sessions = await d.db.purgeRefreshSessions(REFRESH_SESSION_GRACE_DAYS);
  if (sessions > 0) d.log.info("purged dead refresh sessions", { purged: sessions });
  const resets = await d.db.purgePasswordResets();
  if (resets > 0) d.log.info("purged spent/expired password resets", { purged: resets });
  const signIns = await d.db.purgeOidcSignIns();
  if (signIns > 0) d.log.info("purged expired identity-provider sign-ins", { purged: signIns });
  const clients = await d.db.purgeUnusedOauthClients(OAUTH_CLIENT_RETENTION_DAYS);
  if (clients > 0) d.log.info("purged unused oauth client registrations", { purged: clients });
  // A retention of 0 keeps that ledger whole.
  const { auditRetentionDays, aiUsageRetentionDays, askThreadRetentionDays } = env.settings.current();
  if (auditRetentionDays > 0) {
    const audit = await d.db.purgeAuditEvents(auditRetentionDays);
    if (audit > 0) d.log.info("purged audit events past retention", { purged: audit, retentionDays: auditRetentionDays });
  }
  if (aiUsageRetentionDays > 0) {
    const usage = await d.db.purgeAiUsage(aiUsageRetentionDays);
    if (usage > 0) d.log.info("purged AI usage rows past retention", { purged: usage, retentionDays: aiUsageRetentionDays });
  }
  if (askThreadRetentionDays > 0) {
    const threads = await d.db.purgeAskThreads(askThreadRetentionDays);
    if (threads > 0) d.log.info("purged idle ask threads past retention", { purged: threads, retentionDays: askThreadRetentionDays });
  }
  const runs = await d.db.purgeAgentRuns(AGENT_RUN_RETENTION_DAYS);
  if (runs > 0) d.log.info("purged closed agent runs from the inbox", { purged: runs });
  const events = await d.db.purgeWorkspaceEvents(EVENT_RETENTION_DAYS);
  if (events > 0) d.log.info("purged old workspace events", { purged: events });
}

/** One maintenance pass. A failing stage is logged and the rest still run; its work is retried next tick. */
export async function runMaintenanceTick(env: JobsEnv, deps: Partial<JobDeps> = {}): Promise<void> {
  const d = jobDeps(env, deps);
  const stages: Array<[string, () => Promise<void>]> = [
    ["reconcileMissingEmbeddings", () => reconcileMissingEmbeddings(env, d)],
    ["backfillWorkspaces", () => backfillWorkspaces(env, d)],
    ["purgeExpiredTrash", () => purgeExpiredTrash(env, d)],
    ["sweepStagedImports", () => sweepStagedImports(env, d)],
    ["purgeRetention", () => purgeRetention(env, d)],
    ["lookForUpdates", () => lookForUpdates(env, d, VERSION)],
  ];
  for (const [name, run] of stages) {
    try {
      await run();
    } catch (err) {
      d.log.error("maintenance stage failed; continuing with the rest of the tick", { stage: name, err: String(err) });
    }
  }
}
