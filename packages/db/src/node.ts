/**
 * Node singletons: the Settings page's stored values and the boot record. No
 * secret is stored here; API keys, webhook or SMTP URLs and the identity
 * provider's client secret are files, and these rows carry only fingerprints and redacted labels.
 */
import { randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { SEARCH_LANGUAGES, type SearchLanguage } from "@stuga/protocol/domain/search-languages";
import type { NodeAiSettingsRow, NodeSettingsRow, NodeStateRow, StoredChatEndpoint } from "./types.js";
import { jsonb } from "./sql.js";
import type { Sql } from "./client.js";

/** Null when nothing has been saved; the provider defaults apply. */
export async function getNodeAiSettings(sql: Sql): Promise<NodeAiSettingsRow | null> {
  const rows = await sql<NodeAiSettingsRow[]>`SELECT * FROM node_ai_settings WHERE id = TRUE`;
  return rows[0] ?? null;
}

/** A full upsert, never a patch: the row describes one coherent set of endpoints. */
export async function upsertNodeAiSettings(
  sql: Sql,
  input: {
    chatEnabled: boolean | null;
    embedEnabled: boolean | null;
    chatDefaultModel: string | null;
    chatEndpoints: StoredChatEndpoint[];
    embedProvider: string | null;
    embedBaseUrl: string | null;
    embedModel: string | null;
    embedApiKeyFp: string | null;
    searchMaxDistance: number | null;
    retrievalMaxDistance: number | null;
    updatedBy: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO node_ai_settings ${sql({
      id: true,
      chat_enabled: input.chatEnabled,
      embed_enabled: input.embedEnabled,
      chat_default_model: input.chatDefaultModel,
      chat_endpoints: jsonb(sql, input.chatEndpoints),
      embed_provider: input.embedProvider,
      embed_base_url: input.embedBaseUrl,
      embed_model: input.embedModel,
      embed_api_key_fp: input.embedApiKeyFp,
      search_max_distance: input.searchMaxDistance,
      retrieval_max_distance: input.retrievalMaxDistance,
      updated_by: input.updatedBy,
    })}
    ON CONFLICT (id) DO UPDATE SET
      chat_enabled           = EXCLUDED.chat_enabled,
      embed_enabled          = EXCLUDED.embed_enabled,
      chat_default_model     = EXCLUDED.chat_default_model,
      chat_endpoints         = EXCLUDED.chat_endpoints,
      embed_provider         = EXCLUDED.embed_provider,
      embed_base_url         = EXCLUDED.embed_base_url,
      embed_model            = EXCLUDED.embed_model,
      embed_api_key_fp       = EXCLUDED.embed_api_key_fp,
      search_max_distance    = EXCLUDED.search_max_distance,
      retrieval_max_distance = EXCLUDED.retrieval_max_distance,
      updated_by             = EXCLUDED.updated_by,
      updated_at             = now()`;
}

export async function clearNodeAiSettings(sql: Sql): Promise<void> {
  await sql`DELETE FROM node_ai_settings WHERE id = TRUE`;
}

/** Null when nothing has been saved. */
export async function getNodeSettings(sql: Sql): Promise<NodeSettingsRow | null> {
  const rows = await sql<NodeSettingsRow[]>`
    SELECT node_name, max_upload_bytes, audit_retention_days, database_ops_keep, ai_usage_retention_days,
           ask_thread_retention_days, notify_sink, notify_webhook_label, smtp_label, email_from,
           brand_accent_color, update_check, backup_auto, backup_hour, time_zone,
           idp_issuer, idp_client_id, idp_client_secret_label, idp_label, idp_scopes,
           updated_by, updated_at
    FROM node_settings WHERE id = TRUE`;
  return rows[0] ?? null;
}

/** Everything the Settings page stores on the row. The caller resolves every field against the row it read. */
export interface NodeSettingsInput {
  nodeName: string | null;
  maxUploadBytes: number | null;
  auditRetentionDays: number | null;
  databaseOpsKeep: number | null;
  aiUsageRetentionDays: number | null;
  askThreadRetentionDays: number | null;
  notifySink: string | null;
  notifyWebhookLabel: string | null;
  smtpLabel: string | null;
  emailFrom: string | null;
  brandAccentColor: string | null;
  /** Null takes the default, which looks for a newer version. */
  updateCheck: boolean | null;
  /** Null takes the default, which backs up daily. */
  backupAuto: boolean | null;
  /** Null takes the default hour, 3. */
  backupHour: number | null;
  /** Null is UTC. */
  timeZone: string | null;
  /** Null removes the provider; the columns are written together. */
  identityProvider: {
    issuer: string;
    clientId: string;
    clientSecretLabel: string | null;
    label: string | null;
    scopes: string | null;
  } | null;
  updatedBy: string;
}

/** The identity provider a settings row held, without its secret's fingerprint. */
export interface StoredProviderColumns {
  issuer: string;
  clientId: string;
  label: string | null;
  scopes: string | null;
}

/**
 * Settings writers one at a time, plain reads unaffected: the issuer a write
 * compares against is the one it replaces, not one a concurrent save put there.
 */
async function lockSettings(tx: TransactionSql): Promise<void> {
  await tx`LOCK TABLE node_settings IN SHARE ROW EXCLUSIVE MODE`;
}

/**
 * Forget everything tied to the identity provider: flows and tickets in flight,
 * and every account's subject. A subject means nothing under another issuer,
 * and could name someone else there. Returns the accounts unlinked.
 */
async function forgetProviderLinks(tx: TransactionSql): Promise<number> {
  await tx`DELETE FROM oidc_flows`;
  await tx`DELETE FROM oidc_tickets`;
  const unlinked = await tx`UPDATE users SET oidc_sub = NULL, updated_at = now() WHERE oidc_sub IS NOT NULL`;
  return unlinked.count;
}

/**
 * Write the settings row. When the identity provider's issuer changes in any
 * direction (none to one, one to none, one to another, compared exactly) every
 * link to the old one goes in the same transaction, so no subject ever outlives
 * the issuer that vouched for it. Returns the accounts unlinked.
 */
export async function saveNodeSettings(sql: Sql, input: NodeSettingsInput): Promise<{ unlinkedAccounts: number }> {
  return (await sql.begin(async (tx) => {
    await lockSettings(tx);
    const [before] = await tx<{ idp_issuer: string | null }[]>`SELECT idp_issuer FROM node_settings WHERE id = TRUE`;
    const idp = input.identityProvider;
    await tx`
      INSERT INTO node_settings ${tx({
        id: true,
        node_name: input.nodeName,
        max_upload_bytes: input.maxUploadBytes,
        audit_retention_days: input.auditRetentionDays,
        database_ops_keep: input.databaseOpsKeep,
        ai_usage_retention_days: input.aiUsageRetentionDays,
        ask_thread_retention_days: input.askThreadRetentionDays,
        notify_sink: input.notifySink,
        notify_webhook_label: input.notifyWebhookLabel,
        smtp_label: input.smtpLabel,
        email_from: input.emailFrom,
        brand_accent_color: input.brandAccentColor,
        update_check: input.updateCheck,
        backup_auto: input.backupAuto,
        backup_hour: input.backupHour,
        time_zone: input.timeZone,
        idp_issuer: idp?.issuer ?? null,
        idp_client_id: idp?.clientId ?? null,
        idp_client_secret_label: idp?.clientSecretLabel ?? null,
        idp_label: idp?.label ?? null,
        idp_scopes: idp?.scopes ?? null,
        updated_by: input.updatedBy,
      })}
      ON CONFLICT (id) DO UPDATE SET
        node_name                 = EXCLUDED.node_name,
        max_upload_bytes          = EXCLUDED.max_upload_bytes,
        audit_retention_days      = EXCLUDED.audit_retention_days,
        database_ops_keep         = EXCLUDED.database_ops_keep,
        ai_usage_retention_days   = EXCLUDED.ai_usage_retention_days,
        ask_thread_retention_days = EXCLUDED.ask_thread_retention_days,
        notify_sink               = EXCLUDED.notify_sink,
        notify_webhook_label      = EXCLUDED.notify_webhook_label,
        smtp_label                = EXCLUDED.smtp_label,
        email_from                = EXCLUDED.email_from,
        brand_accent_color        = EXCLUDED.brand_accent_color,
        update_check              = EXCLUDED.update_check,
        backup_auto               = EXCLUDED.backup_auto,
        backup_hour               = EXCLUDED.backup_hour,
        time_zone                 = EXCLUDED.time_zone,
        idp_issuer                = EXCLUDED.idp_issuer,
        idp_client_id             = EXCLUDED.idp_client_id,
        idp_client_secret_label   = EXCLUDED.idp_client_secret_label,
        idp_label                 = EXCLUDED.idp_label,
        idp_scopes                = EXCLUDED.idp_scopes,
        updated_by                = EXCLUDED.updated_by,
        updated_at                = now()`;
    const issuerChanged = (before?.idp_issuer ?? null) !== (idp?.issuer ?? null);
    return { unlinkedAccounts: issuerChanged ? await forgetProviderLinks(tx) : 0 };
  })) as { unlinkedAccounts: number };
}

/**
 * Delete the settings row, the identity provider with it, and every link to a
 * provider, in one transaction. The search languages stay: the indexes were
 * built for them. Returns the provider that was set, for the audit.
 */
export async function resetNodeSettings(
  sql: Sql,
): Promise<{ identityProvider: StoredProviderColumns | null; unlinkedAccounts: number }> {
  return (await sql.begin(async (tx) => {
    await lockSettings(tx);
    const [before] = await tx<
      Array<{
        idp_issuer: string | null;
        idp_client_id: string | null;
        idp_label: string | null;
        idp_scopes: string | null;
        search_languages: string[] | null;
      }>
    >`
      DELETE FROM node_settings WHERE id = TRUE
      RETURNING idp_issuer, idp_client_id, idp_label, idp_scopes, search_languages`;
    if (before?.search_languages) {
      await tx`INSERT INTO node_settings (id, search_languages) VALUES (TRUE, ${before.search_languages}::text[])`;
    }
    const identityProvider =
      before?.idp_issuer && before.idp_client_id
        ? { issuer: before.idp_issuer, clientId: before.idp_client_id, label: before.idp_label, scopes: before.idp_scopes }
        : null;
    // With no provider left, no subject can mean anything, whether or not one was set a moment ago.
    return { identityProvider, unlinkedAccounts: await forgetProviderLinks(tx) };
  })) as { identityProvider: StoredProviderColumns | null; unlinkedAccounts: number };
}

/**
 * The languages keyword search was set up for, or null when nobody has chosen,
 * which is none. A language this build does not know is left out.
 */
export async function getSearchLanguages(sql: Sql): Promise<SearchLanguage[] | null> {
  const [row] = await sql<{ search_languages: string[] | null }[]>`
    SELECT search_languages FROM node_settings WHERE id = TRUE`;
  const stored = row?.search_languages;
  return stored ? SEARCH_LANGUAGES.filter((l) => stored.includes(l)) : null;
}

/** Save the search languages alone; the rest of the row is left as it is. `[]` is a choice: none. */
export async function saveSearchLanguages(
  sql: Sql,
  languages: readonly SearchLanguage[],
  updatedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO node_settings (id, search_languages, updated_by)
    VALUES (TRUE, ${[...languages]}::text[], ${updatedBy})
    ON CONFLICT (id) DO UPDATE SET
      search_languages = EXCLUDED.search_languages,
      updated_by       = EXCLUDED.updated_by,
      updated_at       = now()`;
}

/** Null on a database no node has finished booting against. */
export async function getNodeState(sql: Sql): Promise<NodeStateRow | null> {
  const rows = await sql<NodeStateRow[]>`
    SELECT node_id, app_version, first_boot_at, last_boot_at,
           update_checked_at, update_feed, update_check_error,
           backup_attempted_at, backup_error
    FROM node_state WHERE id = TRUE`;
  return rows[0] ?? null;
}

/** Record one scheduled backup: when it was tried, and why it failed, or null when it did not. */
export async function recordBackupAttempt(sql: Sql, result: { at: Date; error: string | null }): Promise<void> {
  await sql`UPDATE node_state SET backup_attempted_at = ${result.at}, backup_error = ${result.error} WHERE id = TRUE`;
}

/**
 * Record one look for a newer version. A look that failed keeps what the last good one listed, so
 * a node that lost its way out still knows what it learned.
 */
export async function recordUpdateCheck(sql: Sql, result: { feed: unknown } | { error: string }): Promise<void> {
  if ("feed" in result) {
    await sql`
      UPDATE node_state
      SET update_checked_at = now(), update_feed = ${jsonb(sql, result.feed)}, update_check_error = NULL
      WHERE id = TRUE`;
    return;
  }
  await sql`
    UPDATE node_state SET update_checked_at = now(), update_check_error = ${result.error} WHERE id = TRUE`;
}


const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 16 characters of lowercase base32: 80 random bits, and nothing that reads as a hostname prefix. */
function newNodeId(): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of randomBytes(10)) {
    // Fewer than 5 unread bits carry over, so 12 bits hold everything still to be read.
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((value >>> bits) & 31);
    }
  }
  return out;
}

/**
 * The version that last booted on this database and when, read before migrations
 * run, so on a database whose schema this build has not yet touched. Null when no
 * node has booted on it: a new database, or one migrations have not reached.
 */
export async function lastNodeBoot(sql: Sql): Promise<{ version: string; at: Date } | null> {
  const [table] = await sql<{ present: boolean }[]>`SELECT to_regclass('public.node_state') IS NOT NULL AS present`;
  if (!table?.present) return null;
  const [row] = await sql<{ app_version: string; last_boot_at: Date }[]>`
    SELECT app_version, last_boot_at FROM node_state WHERE id = TRUE`;
  return row ? { version: row.app_version, at: row.last_boot_at } : null;
}

/**
 * Stamp this boot, once the node has decided it can run. The first boot on a
 * database also picks the node's id, which later boots keep. Returns that id and
 * the version the previous boot recorded (null on a fresh database).
 */
export async function recordNodeBoot(sql: Sql, appVersion: string): Promise<{ nodeId: string; previousVersion: string | null }> {
  const previousVersion = (await getNodeState(sql))?.app_version ?? null;
  const [row] = await sql<Array<{ node_id: string }>>`
    INSERT INTO node_state ${sql({ id: true, node_id: newNodeId(), app_version: appVersion })}
    ON CONFLICT (id) DO UPDATE
      SET app_version = EXCLUDED.app_version, last_boot_at = now()
    RETURNING node_id`;
  return { nodeId: row!.node_id, previousVersion };
}
