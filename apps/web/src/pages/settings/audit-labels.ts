/** The audit ledger in the reader's words, shared by the workspace and node ledgers. */
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import type { AuditEvent } from "../../api";
import { t, type MessageKey } from "../../i18n/i18n";
import { principalName } from "../../state/identity";

/** An agent's tool call, `mcp.<tool>.<action>`, by what the tool does; the exact code stays in the row's tooltip. */
const AGENT_TOOL_LABEL: Record<string, MessageKey> = {
  workspaces: "settings.audit.agentTool.workspaces",
  docs: "settings.audit.agentTool.docs",
  search: "settings.audit.agentTool.search",
  retrieve: "settings.audit.agentTool.search",
  markdown: "settings.audit.agentTool.markdown",
  comments: "settings.audit.agentTool.comments",
  folders: "settings.audit.agentTool.folders",
  events: "settings.audit.agentTool.events",
  collections: "settings.audit.agentTool.collections",
  databases: "settings.audit.agentTool.databases",
  query: "settings.audit.agentTool.query",
  docs_create: "settings.audit.agentTool.docsCreate",
  markdown_append: "settings.audit.agentTool.markdownAppend",
  markdown_edit: "settings.audit.agentTool.markdownEdit",
  comments_add: "settings.audit.agentTool.commentsAdd",
  media_upload: "settings.audit.agentTool.mediaUpload",
  collections_edit: "settings.audit.agentTool.collectionsEdit",
  databases_add: "settings.audit.agentTool.databasesAdd",
  databases_change: "settings.audit.agentTool.databasesChange",
};

/** The tool a `mcp.<tool>.<action>` code names, or null for any other action. */
function agentTool(action: string): string | null {
  const m = /^mcp\.([^.]+)\./.exec(action);
  return m ? m[1]! : null;
}

/**
 * Rows as the log lists them: an agent's tool call is dropped where another row of the same request
 * already says what it did ("Edit proposed"), so one agent action reads as one row. A call with no
 * such row (a read, a refusal) stays.
 */
export function foldAgentCalls<E extends Pick<AuditEvent, "action" | "request_id">>(events: readonly E[]): E[] {
  const described = new Set(events.filter((e) => e.request_id && agentTool(e.action) === null).map((e) => e.request_id));
  return events.filter((e) => !(e.request_id && agentTool(e.action) !== null && described.has(e.request_id)));
}

/** Actions written by name. The generated `mcp.<tool>.<action>` family is worded by its tool. */
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
  "member.add": "settings.audit.action.memberAdd",
  "member.remove": "settings.audit.action.memberRemove",
  "member.role": "settings.audit.action.memberRole",
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
  "share_link.redeem": "settings.audit.action.shareLinkRedeem",
  "share_link.revoke": "settings.audit.action.shareLinkRevoke",
  "share_link.role": "settings.audit.action.shareLinkRole",
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
  if (key) return t(key);
  const tool = agentTool(action);
  if (tool === null) return action;
  const toolKey = AGENT_TOOL_LABEL[tool];
  return toolKey ? t(toolKey) : t("settings.audit.agentTool.other");
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
  if (e.action === "member.remove" && e.detail?.left === true) return t("settings.audit.action.memberLeft");
  if (e.action === "run.decide") {
    if (e.detail?.decision === "accept") return t("settings.audit.action.agentChangesAccepted");
    if (e.detail?.decision === "reject") return t("settings.audit.action.agentChangesRejected");
  }
  return actionName(e.action);
}

const ROLE_LABEL: Record<WorkspaceRole, MessageKey> = {
  owner: "settings.roles.owner",
  admin: "settings.roles.admin",
  member: "settings.roles.member",
  guest: "settings.roles.guest",
};

function roleName(role: unknown): string | null {
  return typeof role === "string" && Object.hasOwn(ROLE_LABEL, role) ? t(ROLE_LABEL[role as WorkspaceRole]) : null;
}

/** One `acl.set` tier list as recorded: p readers, w writers, c commenters. */
type Tiers = { p?: unknown; w?: unknown; c?: unknown };

function listed(tiers: Tiers | undefined, tier: keyof Tiers): string[] {
  const list = tiers?.[tier];
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/** What one person, group or the workspace gained or lost in a sharing change. */
export interface SharingChange {
  principal: string;
  change: "added" | "changed" | "removed";
  /** What they can do now; absent for a removal. */
  level?: "edit" | "comment" | "view";
}

/**
 * A sharing change per principal, from the direct grants that entered and left (audit/acl-diff.ts).
 * Writers and commenters are readers too, so leaving the readers is losing access, and moving
 * between tiers without leaving them is a change of level.
 */
export function sharingChanges(detail: Record<string, unknown> | null | undefined): SharingChange[] {
  const added = detail?.added as Tiers | undefined;
  const removed = detail?.removed as Tiers | undefined;
  const has = (tiers: Tiers | undefined, tier: keyof Tiers, p: string) => listed(tiers, tier).includes(p);
  const principals = [...new Set((["p", "w", "c"] as const).flatMap((tier) => [...listed(added, tier), ...listed(removed, tier)]))];
  return principals.map((principal) => {
    if (has(removed, "p", principal)) return { principal, change: "removed" };
    const level = has(added, "w", principal) ? "edit" : has(added, "c", principal) ? "comment" : "view";
    return { principal, change: has(added, "p", principal) ? "added" : "changed", level };
  });
}

/** The people a row's detail names, for the name cache to look up. */
export function principalsIn(e: AuditEvent): string[] {
  return e.action === "acl.set" ? sharingChanges(e.detail).map((c) => c.principal) : [];
}

/** At most this many changes are spelled out on a row; the rest are counted. */
const SHOWN_CHANGES = 3;

/**
 * A second line saying what changed, where the row's detail tells: who a sharing change gave or
 * took access, a role change's before and after. Null for rows the action alone describes.
 */
export function actionSummary(e: AuditEvent): string | null {
  const d = e.detail ?? {};
  if (e.action === "acl.set") {
    const changes = sharingChanges(d);
    const parts = changes.slice(0, SHOWN_CHANGES).map(({ principal, change, level }) => {
      const name = principalName(principal);
      if (change === "removed") return t("settings.audit.share.removed", { name });
      return t(change === "added" ? "settings.audit.share.added" : "settings.audit.share.changed", { name, level: level ?? "view" });
    });
    if (changes.length > SHOWN_CHANGES) parts.push(t("settings.audit.share.more", { count: changes.length - SHOWN_CHANGES }));
    const inherits = d.inherits as { before?: unknown; after?: unknown } | undefined;
    if (inherits && inherits.before !== inherits.after) {
      parts.push(inherits.after === true ? t("settings.audit.share.inheritsAgain") : t("settings.audit.share.inheritsStopped"));
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  if (e.action === "member.role") {
    const before = roleName(d.before);
    const after = roleName(d.after);
    return before && after ? t("settings.audit.roleChange", { before, after }) : null;
  }
  if (e.action === "member.add" || e.action === "invite.redeem") {
    const role = roleName(d.role);
    return role ? t("settings.audit.asRole", { role }) : null;
  }
  return null;
}

/**
 * A row's target as people read it, where the recorded label is not enough: an invite link is named
 * by who it is for, else by what it admits as and its last characters, never by its reference.
 */
export function targetName(e: AuditEvent): string | null {
  if (e.target_kind !== "invite") return e.target_label;
  if (e.target_label) return t("settings.audit.inviteFor", { note: e.target_label });
  // The raw role, which the message selects on: the link's kind is one phrase in every language.
  const role = roleName(e.detail?.role) ? (e.detail?.role as string) : null;
  const hint = typeof e.detail?.hint === "string" ? e.detail.hint : null;
  if (role && hint) return t("settings.audit.inviteLinkHint", { role, hint });
  return role ? t("settings.audit.inviteLink", { role }) : t("settings.audit.inviteLinkAny");
}
