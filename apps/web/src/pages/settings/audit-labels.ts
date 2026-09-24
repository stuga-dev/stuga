/** The audit ledger in the reader's words, shared by the workspace and node ledgers. */
import type { AuditEvent } from "../../api";

/** Actions written by name. The generated `mcp.<tool>.<action>` family falls through to its code. */
export const ACTION_LABEL: Record<string, string> = {
  "access.denied": "Request refused",
  "node.access.denied": "Request refused",
  "acl.set": "Sharing changed",
  "audit.export": "Audit log exported",
  "audit.read": "Audit log read",
  "collection.create": "Collection created",
  "collection.delete": "Collection deleted",
  "collection.items.add": "Added to a collection",
  "collection.items.remove": "Removed from a collection",
  "collection.rename": "Collection renamed",
  "database.mutate": "Database changed",
  "database.propose": "Database change proposed",
  "doc.agent_instructions": "Agent instructions changed",
  "doc.agent_mode": "Agent review mode changed",
  "doc.create": "Created",
  "doc.delete": "Deleted permanently",
  "doc.propose": "Edit proposed",
  "doc.recover": "Document recovered",
  "doc.restore": "Restored from Trash",
  "doc.trash": "Moved to Trash",
  "doc.update": "Renamed or moved",
  "doc.write_rejected": "Edit refused",
  "folder.agent_instructions": "Folder agent instructions changed",
  "folder.create": "Folder created",
  "folder.delete": "Folder deleted",
  "folder.update": "Folder renamed or moved",
  "group.sync": "Group membership synced",
  "invite.create": "Invite link created",
  "invite.redeem": "Joined with an invite link",
  "invite.revoke": "Invite link revoked",
  "key.mint": "Agent key created",
  "key.revoke": "Agent key revoked",
  "key.rotate": "Agent key rotated",
  "key.update": "Agent key changed",
  "node.admins.grant": "Node admin granted",
  "node.admins.revoke": "Node admin revoked",
  "node.ai_settings.reset": "AI settings reset",
  "node.ai_settings.test": "AI settings tested",
  "node.ai_settings.update": "AI settings changed",
  "node.identity.link": "Identity provider linked",
  "node.identity.unlink": "Identity provider unlinked",
  "node.password_reset.mint": "Password reset link created",
  "node.settings.notify_test": "Notification test sent",
  "node.settings.reset": "Node settings reset",
  "node.settings.update": "Node settings changed",
  "run.ack": "Agent notice dismissed",
  "run.decide": "Agent changes reviewed",
  "run.revert": "Agent changes reverted",
  "share_link.create": "Share link created",
  "share_link.revoke": "Share link revoked",
  "webhook.create": "Webhook created",
  "webhook.delete": "Webhook deleted",
  "webhook.update": "Webhook changed",
  "workspace.agent_instructions": "Workspace agent instructions changed",
};

/** Transport codes, relabelled to say whether a person or a program made the request. */
const SOURCE_LABEL: Record<string, string> = {
  "web": "In the app",
  "ws": "In the app",
  "api-key": "Agent key",
  "mcp": "Connected agent",
  "internal": "This node",
  "cron": "Scheduled",
};

/** How the request reached the node, for the Via column. */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** What a row says it did. Some actions are worded from their detail, which carries the outcome. */
export function actionLabel(e: AuditEvent): string {
  if (e.action === "doc.propose" && e.detail?.mode === "auto_applied") return "Edit applied at once";
  if (e.action === "doc.create") return e.detail?.doc_type === "database" ? "Database created" : "Document created";
  if (e.action === "doc.update") {
    const d = e.detail ?? {};
    if (d.renamed && !d.moved) return "Renamed";
    if (d.moved && !d.renamed) return "Moved to another folder";
  }
  if (e.action === "run.decide") {
    if (e.detail?.decision === "accept") return "Agent changes accepted";
    if (e.detail?.decision === "reject") return "Agent changes rejected";
  }
  return ACTION_LABEL[e.action] ?? e.action;
}
