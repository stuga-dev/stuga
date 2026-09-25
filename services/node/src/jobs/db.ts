/** Every query the job code runs, bound to one client, so tests can substitute an in-memory version. */
import {
  type AuditEventInsert,
  type Sql,
  type WorkspaceEventInsert,
  advanceEmbeddingBackfill,
  advanceSnapshotSeq,
  bumpChunkEmbedAttempt,
  clearDocChunks,
  countAccounts,
  deleteDoc,
  findChunksMissingEmbeddings,
  findExpiredTrash,
  getDoc,
  getEmbeddingHash,
  getFolderAncestors,
  getNodeSettings,
  getNodeState,
  getReusableChunkEmbeddings,
  getUserDisplayName,
  getUserEmail,
  getWebhook,
  getWorkspaceEvent,
  indexDoc,
  insertAiUsage,
  insertAuditEvents,
  insertNotification,
  insertWorkspaceEvent,
  listDocsNeedingEmbeddingBackfill,
  listNodeAdmins,
  listWorkspacesAwaitingBackfill,
  matchingWebhooks,
  pgJobQueue,
  previousVersionSeq,
  purgeAgentRuns,
  purgeAiUsage,
  purgeAskThreads,
  purgeAuditEvents,
  purgeOldNotifications,
  purgeOidcSignIns,
  purgePasswordResets,
  purgeRefreshSessions,
  purgeRevokedApiKeys,
  purgeUnusedOauthClients,
  purgeWorkspaceEvents,
  recordUpdateCheck,
  recordVersion,
  recordWebhookDelivery,
  setChunkEmbedding,
  syncDocMentions,
  trashPagesOf,
  updateWebhook,
  upsertAgentRun,
} from "@stuga/db";
import type { IndexMessage, NotifyDeliverMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { mentionReaders } from "../mentions/recipients.js";
import { queueSnapshotSweep } from "./snapshot-sweep.js";

export function jobsDb(sql: Sql) {
  return {
    getDoc: (docId: string) => getDoc(sql, docId),
    previousVersionSeq: (docId: string, beforeSeq: number) => previousVersionSeq(sql, docId, beforeSeq),
    recordVersion: (v: Parameters<typeof recordVersion>[1]) => recordVersion(sql, v),
    clearDocChunks: (docId: string) => clearDocChunks(sql, docId),
    getEmbeddingHash: (docId: string) => getEmbeddingHash(sql, docId),
    getReusableChunkEmbeddings: (docId: string, dims: number) => getReusableChunkEmbeddings(sql, docId, dims),
    insertAiUsage: (u: Parameters<typeof insertAiUsage>[1]) => insertAiUsage(sql, u),
    indexDoc: (input: Parameters<typeof indexDoc>[1]) => indexDoc(sql, input),
    advanceSnapshotSeq: (docId: string, snapshotSeq: number) => advanceSnapshotSeq(sql, docId, snapshotSeq),
    /**
     * Store a notification and, when the row is new, queue its sink delivery in the same
     * transaction: a retried job then never finds its own row and skips a delivery that never ran.
     */
    insertNotification: (n: Parameters<typeof insertNotification>[1], delivery: NotifyDeliverMessage | null): Promise<boolean> =>
      sql.begin(async (tx) => {
        const isNew = await insertNotification(tx, n);
        if (isNew && delivery) await pgJobQueue<IndexMessage>(tx).send(delivery);
        return isNew;
      }) as Promise<boolean>,
    insertAuditEvents: (batch: AuditEventInsert[]) => insertAuditEvents(sql, batch),
    userEmail: (alias: string) => getUserEmail(sql, alias),
    displayNameOf: (alias: string) => getUserDisplayName(sql, alias),
    /** Replace the document's mention set; the people not in it before. */
    syncDocMentions: (docId: string, aliases: string[]) => syncDocMentions(sql, docId, aliases),
    mentionReaders: (doc: Parameters<typeof mentionReaders>[1], aliases: string[], author: string | null) =>
      mentionReaders(sql, doc, aliases, author),
    findChunksMissingEmbeddings: (limit: number, maxAttempts: number) => findChunksMissingEmbeddings(sql, limit, maxAttempts),
    setChunkEmbedding: (docId: string, chunkIndex: number, embedding: number[], dims: number) =>
      setChunkEmbedding(sql, docId, chunkIndex, embedding, dims),
    bumpChunkEmbedAttempt: (docId: string, chunkIndex: number) => bumpChunkEmbedAttempt(sql, docId, chunkIndex),
    listWorkspacesAwaitingBackfill: (limit: number) => listWorkspacesAwaitingBackfill(sql, limit),
    listDocsNeedingEmbeddingBackfill: (workspaceId: string, limit: number, afterDocId: string | null) =>
      listDocsNeedingEmbeddingBackfill(sql, workspaceId, limit, afterDocId),
    advanceEmbeddingBackfill: (workspaceId: string, cursor: string | null) => advanceEmbeddingBackfill(sql, workspaceId, cursor),
    findExpiredTrash: (olderThanDays: number) => findExpiredTrash(sql, olderThanDays),
    trashPagesOf: (databaseId: string) => trashPagesOf(sql, databaseId),
    queueSnapshotSweep: (docId: string) => queueSnapshotSweep(sql, docId),
    deleteDoc: (docId: string) => deleteDoc(sql, docId),
    purgeRevokedApiKeys: (days: number) => purgeRevokedApiKeys(sql, days),
    purgeUnusedOauthClients: (days: number) => purgeUnusedOauthClients(sql, days),
    purgeOldNotifications: (days: number) => purgeOldNotifications(sql, days),
    purgeAuditEvents: (days: number) => purgeAuditEvents(sql, days),
    purgeAiUsage: (days: number) => purgeAiUsage(sql, days),
    purgeAskThreads: (days: number) => purgeAskThreads(sql, days),
    purgeRefreshSessions: (graceDays: number) => purgeRefreshSessions(sql, graceDays),
    purgePasswordResets: () => purgePasswordResets(sql),
    purgeOidcSignIns: () => purgeOidcSignIns(sql),
    upsertAgentRun: (e: RunIndexEntry) => upsertAgentRun(sql, e),
    purgeAgentRuns: (days: number) => purgeAgentRuns(sql, days),
    insertWorkspaceEvent: (e: WorkspaceEventInsert) => insertWorkspaceEvent(sql, e),
    getWorkspaceEvent: (id: number) => getWorkspaceEvent(sql, id),
    purgeWorkspaceEvents: (days: number) => purgeWorkspaceEvents(sql, days),
    matchingWebhooks: (workspaceId: string, type: string, folderIds: string[]) => matchingWebhooks(sql, workspaceId, type, folderIds),
    getWebhook: (webhookId: string) => getWebhook(sql, webhookId),
    recordWebhookDelivery: (webhookId: string, status: number | null, ok: boolean) => recordWebhookDelivery(sql, webhookId, status, ok),
    updateWebhook: (workspaceId: string, webhookId: string, patch: { active?: boolean }) =>
      updateWebhook(sql, workspaceId, webhookId, patch),
    nodeState: () => getNodeState(sql),
    nodeSettingsRow: () => getNodeSettings(sql),
    countAccounts: () => countAccounts(sql),
    listNodeAdmins: () => listNodeAdmins(sql),
    recordUpdateCheck: (result: Parameters<typeof recordUpdateCheck>[1]) => recordUpdateCheck(sql, result),
    /** The folder ids above a document, outermost first; empty at the root. */
    docFolderAncestry: async (docId: string): Promise<string[]> => {
      const doc = await getDoc(sql, docId);
      if (!doc?.parent_id) return [];
      return (await getFolderAncestors(sql, doc.parent_id, doc.workspace_id)).map((f) => f.folder_id);
    },
  };
}

export type JobsDb = ReturnType<typeof jobsDb>;
