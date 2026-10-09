/** The audit ledger in the reader's words, shared by the workspace and node ledgers. */
import type { AuditEvent } from "../../api";
import { t, type MessageKey } from "../../i18n/i18n";

/** Actions written by name. The generated `mcp.<tool>.<action>` family falls through to its code. */
const ACTION_LABEL: Record<string, MessageKey> = {
  "access.denied": "settings.audit.action.accessDenied",
  "node.access.denied": "settings.audit.action.accessDenied",
  "acl.set": "settings.audit.action.aclSet",
  "audit.export": "settings.audit.action.auditExport",
  "audit.read": "settings.audit.action.auditRead",
  "collection.create": "settings.audit.action.collectionCreate",
  "collection.delete": "settings.audit.action.collectionDelete",
  "collection.items.add": "settings.audit.action.collectionItemsAdd",
  "collection.items.remove": "settings.audit.action.collectionItemsRemove",
  "collection.rename": "settings.audit.action.collectionRename",
  "database.mutate": "settings.audit.action.databaseMutate",
  "database.propose": "settings.audit.action.databasePropose",
  "doc.agent_instructions": "settings.audit.action.docAgentInstructions",
  "doc.agent_mode": "settings.audit.action.docAgentMode",
  "doc.create": "settings.audit.action.docCreate",
  "doc.delete": "settings.audit.action.docDelete",
  "doc.propose": "settings.audit.action.docPropose",
  "doc.recover": "settings.audit.action.docRecover",
  "doc.restore": "settings.audit.action.docRestore",
  "doc.trash": "settings.audit.action.docTrash",
  "doc.update": "settings.audit.action.docUpdate",
  "doc.write_rejected": "settings.audit.action.docWriteRejected",
  "folder.agent_instructions": "settings.audit.action.folderAgentInstructions",
  "folder.create": "settings.audit.action.folderCreate",
  "folder.delete": "settings.audit.action.folderDelete",
  "folder.update": "settings.audit.action.folderUpdate",
  "group.sync": "settings.audit.action.groupSync",
  "invite.create": "settings.audit.action.inviteCreate",
  "invite.redeem": "settings.audit.action.inviteRedeem",
  "invite.revoke": "settings.audit.action.inviteRevoke",
  "key.mint": "settings.audit.action.keyMint",
  "key.revoke": "settings.audit.action.keyRevoke",
  "key.rotate": "settings.audit.action.keyRotate",
  "key.update": "settings.audit.action.keyUpdate",
  "node.account.revoke_everything": "settings.audit.action.nodeAccountRevokeEverything",
  "node.admins.grant": "settings.audit.action.nodeAdminsGrant",
  "node.admins.revoke": "settings.audit.action.nodeAdminsRevoke",
  "node.ai_settings.calibrate": "settings.audit.action.nodeAiSettingsCalibrate",
  "node.ai_settings.reset": "settings.audit.action.nodeAiSettingsReset",
  "node.ai_settings.test": "settings.audit.action.nodeAiSettingsTest",
  "node.ai_settings.update": "settings.audit.action.nodeAiSettingsUpdate",
  "node.identity.link": "settings.audit.action.nodeIdentityLink",
  "node.identity.unlink": "settings.audit.action.nodeIdentityUnlink",
  "node.passkey.add": "settings.audit.action.nodePasskeyAdd",
  "node.passkey.remove": "settings.audit.action.nodePasskeyRemove",
  "node.password_reset.mint": "settings.audit.action.nodePasswordResetMint",
  "node.remote_access.connector_retry": "settings.audit.action.nodeRemoteAccessConnectorRetry",
  "node.remote_access.disable": "settings.audit.action.nodeRemoteAccessDisable",
  "node.remote_access.enable": "settings.audit.action.nodeRemoteAccessEnable",
  "node.session.wrong_address": "settings.audit.action.nodeSessionWrongAddress",
  "node.settings.notify_test": "settings.audit.action.nodeSettingsNotifyTest",
  "node.settings.reset": "settings.audit.action.nodeSettingsReset",
  "node.settings.update": "settings.audit.action.nodeSettingsUpdate",
  "node.sign_in.new_device": "settings.audit.action.nodeSignInNewDevice",
  "run.ack": "settings.audit.action.runAck",
  "run.decide": "settings.audit.action.runDecide",
  "run.revert": "settings.audit.action.runRevert",
  "share_link.create": "settings.audit.action.shareLinkCreate",
  "share_link.revoke": "settings.audit.action.shareLinkRevoke",
  "webhook.create": "settings.audit.action.webhookCreate",
  "webhook.delete": "settings.audit.action.webhookDelete",
  "webhook.update": "settings.audit.action.webhookUpdate",
  "workspace.agent_instructions": "settings.audit.action.workspaceAgentInstructions",
  "workspace.export": "settings.audit.action.workspaceExport",
  "workspace.import": "settings.audit.action.workspaceImport",
};

/** Transport codes, relabelled to say whether a person or a program made the request. */
const SOURCE_LABEL: Record<string, MessageKey> = {
  "web": "settings.audit.source.app",
  "ws": "settings.audit.source.app",
  "api-key": "settings.audit.source.apiKey",
  "mcp": "settings.audit.source.mcp",
  "internal": "settings.audit.source.internal",
  "cron": "settings.audit.source.cron",
};

/** How the request reached the node, for the Via column. */
export function sourceLabel(source: string): string {
  const key = SOURCE_LABEL[source];
  return key ? t(key) : source;
}

/** An action by its name alone, for a menu of actions; one without a name reads as its code. */
export function actionName(action: string): string {
  const key = ACTION_LABEL[action];
  return key ? t(key) : action;
}

/** What a row says it did. Some actions are worded from their detail, which carries the outcome. */
export function actionLabel(e: AuditEvent): string {
  if (e.action === "doc.propose" && e.detail?.mode === "auto_applied") return t("settings.audit.action.editAppliedAtOnce");
  if (e.action === "doc.create") {
    return e.detail?.doc_type === "database" ? t("settings.audit.action.databaseCreated") : t("settings.audit.action.documentCreated");
  }
  if (e.action === "doc.update") {
    const d = e.detail ?? {};
    if (d.renamed && !d.moved) return t("settings.audit.action.renamed");
    if (d.moved && !d.renamed) return t("settings.audit.action.moved");
  }
  if (e.action === "run.decide") {
    if (e.detail?.decision === "accept") return t("settings.audit.action.agentChangesAccepted");
    if (e.detail?.decision === "reject") return t("settings.audit.action.agentChangesRejected");
  }
  return actionName(e.action);
}
