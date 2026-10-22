/** Every query the job code runs, bound to one client, so tests can substitute an in-memory version. */
import {
  type AuditEventInsert,
  type SearchLanguage,
  type Sql,
  type WorkspaceEventInsert,
  advanceEmbeddingBackfill,
  advanceSnapshotSeq,
  agentRunClosed,
  changeRunsClosed,
  claimReviewPost,
  getChange,
  itemUnreleased,
  purgeWikiChanges,
  bumpChunkEmbedAttempt,
  clearDocChunks,
  colleagueApprovers,
  countAccounts,
  managersWhoCanRead,
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
  getUiLanguage,
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
  matchingReviewChannels,
  matchingWebhooks,
  pgJobQueue,
  previousVersionSeq,
  purgeAgentRuns,
  purgeAiUsage,
  purgeAskThreads,
  purgeAuditEvents,
  purgeExpiredOauthTokens,
  purgeKnownDevices,
  purgeOldNotifications,
  purgeOidcSignIns,
  purgePasswordResets,
  purgeReviewPosts,
  purgeRefreshSessions,
  purgeRevokedApiKeys,
  purgeUnusedOauthClients,
  purgeWorkspaceEvents,
  recordNotificationDelivery,
  recordUpdateCheck,
  recordVersion,
  recordWebhookDelivery,
  setChunkEmbedding,
  setDatabaseSearchText,
  syncDocMentions,
  trashPagesOf,
  updateWebhook,
  upsertAgentRun,
  webhookReaches,
} from "@stuga/db";
import type { IndexMessage, NotifyDeliverMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { folderReviewChain } from "../authz/review-mode.js";
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
    setDatabaseSearchText: (docId: string, text: string, languages: readonly SearchLanguage[]) =>
      setDatabaseSearchText(sql, docId, text, languages),
    /**
     * Store a notification and, when the row is new, queue its sink delivery in the same
     * transaction: a retried job then never finds its own row and skips a delivery that never ran.
     */
    insertNotification: (n: Parameters<typeof insertNotification>[1], delivery: NotifyDeliverMessage | null): Promise<boolean> =>
      sql.begin(async (tx) => {
        // Stamped with the channel as it is written, so it reads "Sending by …" until the first attempt.
        const isNew = await insertNotification(tx, { ...n, delivery_channel: n.delivery_channel ?? delivery?.channel ?? "none" });
        if (isNew && delivery) await pgJobQueue<IndexMessage>(tx).send({ ...delivery, notificationId: n.id });
        return isNew;
      }) as Promise<boolean>,
    /** How one delivery attempt of notification `id` went. */
    recordDelivery: (id: string, outcome: { delivered: true } | { error: string }) => recordNotificationDelivery(sql, id, outcome),
    insertAuditEvents: (batch: AuditEventInsert[]) => insertAuditEvents(sql, batch),
    userEmail: (alias: string) => getUserEmail(sql, alias),
    /** The language a person chose, and the one their browser last asked for at a sign-in. */
    uiLanguage: (alias: string) => getUiLanguage(sql, alias),
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
    purgeExpiredOauthTokens: () => purgeExpiredOauthTokens(sql),
    purgeOldNotifications: (days: number) => purgeOldNotifications(sql, days),
    purgeAuditEvents: (days: number) => purgeAuditEvents(sql, days),
    purgeAiUsage: (days: number) => purgeAiUsage(sql, days),
    purgeAskThreads: (days: number) => purgeAskThreads(sql, days),
    purgeRefreshSessions: (graceDays: number) => purgeRefreshSessions(sql, graceDays),
    purgePasswordResets: () => purgePasswordResets(sql),
    purgeKnownDevices: () => purgeKnownDevices(sql),
    purgeOidcSignIns: () => purgeOidcSignIns(sql),
    upsertAgentRun: (e: RunIndexEntry) => upsertAgentRun(sql, e),
    purgeAgentRuns: (days: number) => purgeAgentRuns(sql, days),
    insertWorkspaceEvent: (e: WorkspaceEventInsert) => insertWorkspaceEvent(sql, e),
    getWorkspaceEvent: (id: number) => getWorkspaceEvent(sql, id),
    purgeWorkspaceEvents: (days: number) => purgeWorkspaceEvents(sql, days),
    matchingWebhooks: (workspaceId: string, type: string, folderIds: string[], docId: string | null) =>
      matchingWebhooks(sql, workspaceId, type, folderIds, docId),
    webhookReaches: (webhookId: string, docId: string | null) => webhookReaches(sql, webhookId, docId),
    matchingReviewChannels: (workspaceId: string, folderIds: string[], docId: string) => matchingReviewChannels(sql, workspaceId, folderIds, docId),
    /**
     * Claim a review channel's one post about a run and queue its delivery in the same transaction:
     * false, and nothing queued, when the channel has posted about the run already.
     */
    claimReviewPost: (webhookId: string, runId: string, delivery: IndexMessage): Promise<boolean> =>
      sql.begin(async (tx) => {
        const claimed = await claimReviewPost(tx, webhookId, runId);
        if (claimed) await pgJobQueue<IndexMessage>(tx).send(delivery);
        return claimed;
      }) as Promise<boolean>,
    purgeReviewPosts: (days: number) => purgeReviewPosts(sql, days),
    /** Whether a run's mirror says it is closed: decided or reverted. */
    agentRunClosed: (runId: string) => agentRunClosed(sql, runId),
    /** Whether every run of a change is closed, as the mirror says. */
    changeRunsClosed: (changeId: string) => changeRunsClosed(sql, changeId),
    getChange: (changeId: string) => getChange(sql, changeId),
    /** A new page a change holds, or a row page of such a database: no review channel names it. */
    itemUnreleased: (docId: string) => itemUnreleased(sql, docId),
    purgeWikiChanges: (days: number) => purgeWikiChanges(sql, days),
    getWebhook: (webhookId: string) => getWebhook(sql, webhookId),
    recordWebhookDelivery: (webhookId: string, status: number | null, ok: boolean) => recordWebhookDelivery(sql, webhookId, status, ok),
    updateWebhook: (workspaceId: string, webhookId: string, patch: { active?: boolean }) =>
      updateWebhook(sql, workspaceId, webhookId, patch),
    nodeState: () => getNodeState(sql),
    nodeSettingsRow: () => getNodeSettings(sql),
    countAccounts: () => countAccounts(sql),
    listNodeAdmins: () => listNodeAdmins(sql),
    recordUpdateCheck: (result: Parameters<typeof recordUpdateCheck>[1]) => recordUpdateCheck(sql, result),
    /** The approver group a document's folders name now, or null. */
    docApproverGroup: async (doc: { parent_id: string | null; workspace_id: string }): Promise<string | null> =>
      (await folderReviewChain(sql, doc.parent_id, doc.workspace_id)).approverGroup,
    /** Who may approve a run at `colleague` on this item, which `reviewer` asked the AI for. */
    colleagueApprovers: (doc: Parameters<typeof colleagueApprovers>[1], reviewer: string, groups: string[]) =>
      colleagueApprovers(sql, doc, reviewer, groups),
    /** The item's owner and the workspace's owners and admins who can read it, `exclude` left out. */
    managersWhoCanRead: (doc: { workspace_id: string; acl_principals: string[]; owner: string }, exclude: string) =>
      managersWhoCanRead(sql, doc.workspace_id, doc, exclude),
    /** The folder ids above a document, outermost first; empty at the root. */
    docFolderAncestry: async (docId: string): Promise<string[]> => {
      const doc = await getDoc(sql, docId);
      if (!doc?.parent_id) return [];
      return (await getFolderAncestors(sql, doc.parent_id, doc.workspace_id)).map((f) => f.folder_id);
    },
  };
}

export type JobsDb = ReturnType<typeof jobsDb>;
