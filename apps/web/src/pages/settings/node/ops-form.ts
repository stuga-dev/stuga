import type { NodeOperationalSettings, NodeOperationalSettingsInput } from "../../../api";
import { isWebhookSink } from "@stuga/protocol/domain/notify";

/** The non-AI settings as the inputs bind them. Credentials start blank: they are write-only. */
export interface OpsForm {
  /** The name typed, or "" for none. */
  nodeName: string;
  maxUploadMb: number;
  auditRetentionDays: number;
  /** Ops each database's Activity feed keeps; 0 = every change. */
  databaseOpsKeep: number;
  /** Days of AI usage history kept; 0 = forever. */
  aiUsageRetentionDays: number;
  /** Days an Ask thread is kept after its last question; 0 = forever. */
  askThreadRetentionDays: number;
  notifySink: string;
  emailFrom: string;
  webhookUrl: string;
  smtpUrl: string;
  brandAccentColor: string;
}

export function toOpsForm(s: NodeOperationalSettings): OpsForm {
  return {
    nodeName: s.node_name ?? "",
    maxUploadMb: s.limits.max_upload_mb,
    auditRetentionDays: s.maintenance.audit_retention_days,
    databaseOpsKeep: s.maintenance.database_ops_keep,
    aiUsageRetentionDays: s.maintenance.ai_usage_retention_days,
    askThreadRetentionDays: s.maintenance.ask_thread_retention_days,
    notifySink: s.notify.sink,
    emailFrom: s.notify.email_from ?? "",
    webhookUrl: "",
    smtpUrl: "",
    brandAccentColor: s.branding.accent_color ?? "",
  };
}

/** A credential travels only for a sink that uses it: blank keeps the stored one, `cleared` deletes it. */
export function notifyInput(form: OpsForm, cleared: { webhook: boolean; smtp: boolean }): NodeOperationalSettingsInput {
  const notify: NonNullable<NodeOperationalSettingsInput["notify"]> = { sink: form.notifySink };
  if (form.notifySink === "email") notify.email_from = form.emailFrom.trim();
  if (isWebhookSink(form.notifySink)) {
    if (cleared.webhook) notify.webhook_url = "";
    else if (form.webhookUrl.trim()) notify.webhook_url = form.webhookUrl.trim();
  }
  if (form.notifySink === "email") {
    if (cleared.smtp) notify.smtp_url = "";
    else if (form.smtpUrl.trim()) notify.smtp_url = form.smtpUrl.trim();
  }
  return { notify };
}
