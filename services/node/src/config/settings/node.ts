/**
 * The node settings in force that are not AI: the node_settings row, its
 * credential files, and the defaults for whatever the row leaves unset.
 *
 * A webhook URL is a bearer credential, an SMTP URL carries a password and the
 * identity provider's client secret is one, so all three live under
 * <DATA_DIR>/secrets; the row holds only a redacted label or a fingerprint.
 */
import { sha256Hex } from "@stuga/auth";
import { getNodeSettings, type Sql } from "@stuga/db";
import { hostLabel } from "@stuga/protocol/domain/node-name";
import { isWebhookSink } from "@stuga/protocol/domain/notify";
import { DATABASE_OPS_KEEP } from "@stuga/protocol/databases/limits";
import type { NotifyConfig } from "../../env.js";
import { DEFAULT_MAX_UPLOAD_BYTES, bodyBytesFor } from "../../media/media.js";
import { readSecretFile } from "../secrets.js";
import { knownTimeZone } from "../time-zone.js";
import { createSettingsStore, type SettingsStore } from "./store.js";

/** Filenames under <DATA_DIR>/secrets. */
export const WEBHOOK_URL_FILE = "notify-webhook";
export const SMTP_URL_FILE = "notify-smtp";
export const IDP_CLIENT_SECRET_FILE = "idp-client-secret";

/** What the node asks the identity provider for when the row names nothing. */
export const DEFAULT_IDP_SCOPES = "openid profile email";

const DEFAULT_AUDIT_RETENTION_DAYS = 180;
/** A year keeps a full cycle for anyone who exports usage; the page reads the current month. */
const DEFAULT_AI_USAGE_RETENTION_DAYS = 365;
const DEFAULT_ASK_THREAD_RETENTION_DAYS = 365;

/** A stored credential's state for the settings page. Never the value. */
interface SecretState {
  set: boolean;
  label: string | null;
  /** The row records one but the file is gone: restored without its data directory. */
  stale: boolean;
}

interface NodeSecretState {
  webhook: SecretState;
  smtp: SecretState;
  idpClientSecret: SecretState;
}

/** What the settings row supplies. Null means "not set". */
interface NodeStoredSettings {
  nodeName?: string | null;
  maxUploadBytes?: number | null;
  auditRetentionDays?: number | null;
  databaseOpsKeep?: number | null;
  aiUsageRetentionDays?: number | null;
  askThreadRetentionDays?: number | null;
  notifySink?: string | null;
  notifyWebhookUrl?: string | null;
  smtpUrl?: string | null;
  emailFrom?: string | null;
  brandAccentColor?: string | null;
  updateCheck?: boolean | null;
  backupAuto?: boolean | null;
  backupHour?: number | null;
  timeZone?: string | null;
  idpIssuer?: string | null;
  idpClientId?: string | null;
  idpClientSecret?: string | null;
  idpLabel?: string | null;
  idpScopes?: string | null;
}

/** The node's colour, which marks the selected item. Null means "not set". */
interface NodeBranding {
  accentColor: string | null;
}

/** The identity provider people may sign in with, at most one; everything resolved to what is used. */
export interface IdentityProviderSettings {
  /** The provider's own spelling, which its id_tokens' `iss` must match exactly. */
  issuer: string;
  clientId: string;
  /** Null for a public client. */
  clientSecret: string | null;
  /** The sign-in button's text: the stored label, else the issuer's host. */
  label: string;
  scopes: string;
}

export interface ResolvedNodeSettings {
  /** The name an administrator gave the node, which the app shows in place of the product's. Null until there is one. */
  nodeName: string | null;
  /** What tells this node apart from others, to agents and in the switcher: the name, else PUBLIC_ORIGIN's host. Never empty. */
  nodeLabel: string;
  maxUploadBytes: number;
  /** Derived from the upload size, so the listener never refuses an upload the media route would accept. */
  maxBodyBytes: number;
  /** 0 keeps every audit row. */
  auditRetentionDays: number;
  /** Ops each database's Activity ledger keeps; 0 never prunes. */
  databaseOpsKeep: number;
  /** 0 keeps every ai_usage row. */
  aiUsageRetentionDays: number;
  /** Days an ask thread survives without a new turn; 0 keeps them all. */
  askThreadRetentionDays: number;
  notify: NotifyConfig;
  branding: NodeBranding;
  /** Whether the node looks for a newer version once a day. On unless an administrator turned it off. */
  updateCheck: boolean;
  /** The daily backup: on unless an administrator turned it off, at 3:00 unless they chose another hour. */
  backups: { auto: boolean; hour: number };
  /** The node's time zone for scheduled work, an IANA name; UTC until setup or an administrator names one. */
  timeZone: string;
  identityProvider: IdentityProviderSettings | null;
}

/** The hour the daily backup starts when nobody chose one: the small hours, when nobody is working. */
export const DEFAULT_BACKUP_HOUR = 3;

export type NodeSettingsStore = SettingsStore<ResolvedNodeSettings, NodeSecretState>;

export function resolveNodeSettings(stored: NodeStoredSettings | null, publicOrigin: string): ResolvedNodeSettings {
  const st = stored ?? {};
  const maxUploadBytes = st.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const notify: NotifyConfig = { sink: st.notifySink ?? "none" };
  if (st.notifyWebhookUrl) notify.webhookUrl = st.notifyWebhookUrl;
  if (st.smtpUrl) notify.smtpUrl = st.smtpUrl;
  if (st.emailFrom) notify.emailFrom = st.emailFrom;
  return {
    nodeName: st.nodeName || null,
    nodeLabel: st.nodeName || hostLabel(publicOrigin),
    maxUploadBytes,
    maxBodyBytes: bodyBytesFor(maxUploadBytes),
    auditRetentionDays: st.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    databaseOpsKeep: st.databaseOpsKeep ?? DATABASE_OPS_KEEP,
    aiUsageRetentionDays: st.aiUsageRetentionDays ?? DEFAULT_AI_USAGE_RETENTION_DAYS,
    askThreadRetentionDays: st.askThreadRetentionDays ?? DEFAULT_ASK_THREAD_RETENTION_DAYS,
    notify,
    branding: { accentColor: st.brandAccentColor ?? null },
    updateCheck: st.updateCheck ?? true,
    backups: { auto: st.backupAuto ?? true, hour: st.backupHour ?? DEFAULT_BACKUP_HOUR },
    timeZone: knownTimeZone(st.timeZone) ?? "UTC",
    identityProvider:
      st.idpIssuer && st.idpClientId
        ? {
            issuer: st.idpIssuer,
            clientId: st.idpClientId,
            clientSecret: st.idpClientSecret ?? null,
            label: st.idpLabel || issuerHost(st.idpIssuer),
            scopes: st.idpScopes || DEFAULT_IDP_SCOPES,
          }
        : null,
  };
}

/** The button text when the administrator chose none. */
export function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/** What a sink still needs before it can deliver anything, or null when it is complete. */
export function notifyIncomplete(cfg: NotifyConfig): string | null {
  if (isWebhookSink(cfg.sink) && !cfg.webhookUrl) return `a webhook URL is required to deliver to ${cfg.sink}`;
  if (cfg.sink === "email" && !cfg.smtpUrl) return "an SMTP URL is required to deliver by email";
  if (cfg.sink === "email" && !cfg.emailFrom) return "a From address is required to deliver by email";
  return null;
}

/**
 * A URL whose secret is its password, reduced to something safe to show: host,
 * port, user and path are addressing and stay. Not for a URL that is itself a
 * bearer credential; see `fingerprintUrl`.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "on file";
  }
  const user = url.username ? `${decodeURIComponent(url.username)}@` : "";
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${user}${url.host}${path}`;
}

/**
 * A URL that IS a bearer credential, reduced to something safe to show. The
 * secret can sit anywhere in the path, so none of it appears: the host plus a
 * short digest of the whole URL tells two sinks apart without narrowing a guess.
 */
export function fingerprintUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "on file";
  }
  const digest = sha256Hex(raw).slice(0, 6);
  return `${url.host} · ${digest}`;
}

export function createNodeSettingsStore(deps: { sql: Sql; dataDir: string; publicOrigin: string }): Promise<NodeSettingsStore> {
  return createSettingsStore(async () => {
    // A failed read rejects, so a refresh keeps the last good snapshot: defaults in its place would let the
    // maintenance tick purge with retentions the operator never chose.
    const row = await getNodeSettings(deps.sql);
    const webhookUrl = readSecretFile(deps.dataDir, WEBHOOK_URL_FILE);
    const smtpUrl = readSecretFile(deps.dataDir, SMTP_URL_FILE);
    const idpClientSecret = readSecretFile(deps.dataDir, IDP_CLIENT_SECRET_FILE);
    const secrets: NodeSecretState = {
      webhook: {
        set: webhookUrl !== null,
        label: row?.notify_webhook_label ?? null,
        stale: !!row?.notify_webhook_label && webhookUrl === null,
      },
      smtp: {
        set: smtpUrl !== null,
        label: row?.smtp_label ?? null,
        stale: !!row?.smtp_label && smtpUrl === null,
      },
      idpClientSecret: {
        set: idpClientSecret !== null,
        label: row?.idp_client_secret_label ?? null,
        stale: !!row?.idp_client_secret_label && idpClientSecret === null,
      },
    };
    if (secrets.webhook.stale || secrets.smtp.stale || secrets.idpClientSecret.stale) {
      console.warn("[node] a credential is recorded in the database but missing from DATA_DIR/secrets", {
        webhook: secrets.webhook.stale,
        smtp: secrets.smtp.stale,
        identityProviderClientSecret: secrets.idpClientSecret.stale,
      });
    }
    const value = resolveNodeSettings(
      {
        nodeName: row?.node_name ?? null,
        maxUploadBytes: row?.max_upload_bytes ?? null,
        auditRetentionDays: row?.audit_retention_days ?? null,
        databaseOpsKeep: row?.database_ops_keep ?? null,
        aiUsageRetentionDays: row?.ai_usage_retention_days ?? null,
        askThreadRetentionDays: row?.ask_thread_retention_days ?? null,
        notifySink: row?.notify_sink ?? null,
        notifyWebhookUrl: webhookUrl,
        smtpUrl,
        emailFrom: row?.email_from ?? null,
        brandAccentColor: row?.brand_accent_color ?? null,
        updateCheck: row?.update_check ?? null,
        backupAuto: row?.backup_auto ?? null,
        backupHour: row?.backup_hour ?? null,
        timeZone: row?.time_zone ?? null,
        idpIssuer: row?.idp_issuer ?? null,
        idpClientId: row?.idp_client_id ?? null,
        idpClientSecret,
        idpLabel: row?.idp_label ?? null,
        idpScopes: row?.idp_scopes ?? null,
      },
      deps.publicOrigin,
    );
    return { value, secrets };
  });
}
