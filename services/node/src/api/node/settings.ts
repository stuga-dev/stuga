/** `/api/node/settings`: every node setting the Settings page edits that is not AI. */
import { ProviderError, fetchProviderMetadata, sha256Hex } from "@stuga/auth";
import {
  countAccountsWithoutPassword,
  getNodeSettings,
  resetNodeSettings as resetSettingsRow,
  saveNodeSettings as saveSettingsRow,
  type NodeSettingsRow,
} from "@stuga/db";
import { MAX_NODE_NAME_CHARS, UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";
import { NOTIFY_SINKS } from "@stuga/protocol/domain/notify";
import { SEARCH_LANGUAGES, parseSearchLanguages, type SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import type { Ctx } from "../../auth/context.js";
import { removeSecretFile, writeSecretFile } from "../../config/secrets.js";
import {
  DEFAULT_IDP_SCOPES,
  IDP_CLIENT_SECRET_FILE,
  SMTP_URL_FILE,
  WEBHOOK_URL_FILE,
  type ResolvedNodeSettings,
  fingerprintUrl,
  issuerHost,
  notifyIncomplete,
  redactUrl,
} from "../../config/settings/node.js";
import type { NotifyConfig } from "../../env.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";
import { deliver } from "../../jobs/sinks.js";
import { parseSmtpUrl } from "../../jobs/smtp.js";
import { MAX_UPLOAD_BYTES_CEILING } from "../../media/media.js";
import { isLoopbackHost } from "../../net/addresses.js";
import { knownTimeZone } from "../../config/time-zone.js";

interface NotifyProbe {
  ok: boolean;
  sink: string;
  message?: string;
}

/** Send one real notification through a candidate sink. */
async function probeNotify(cfg: NotifyConfig, nodeUrl: string): Promise<NotifyProbe> {
  if (cfg.sink === "none") return { ok: true, sink: cfg.sink, message: "No sink is configured, so nothing was sent." };
  const incomplete = notifyIncomplete(cfg);
  if (incomplete) return { ok: false, sink: cfg.sink, message: incomplete };
  try {
    await deliver(cfg, {
      recipient: "node-administrator",
      recipientEmail: cfg.emailFrom ?? null,
      title: "Stuga test notification",
      body: "This is a test from your node's settings page. If you are reading it, the sink works.",
      url: nodeUrl,
    });
    return { ok: true, sink: cfg.sink };
  } catch (e) {
    return { ok: false, sink: cfg.sink, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Trim, or null for a value the caller cleared. Undefined stays undefined. */
function optional(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Where the identity provider sends people back; one per origin the SPA is served from. */
const CALLBACK_PATH = "/auth/oidc/callback";

/** The identity provider as the row stores it; the secret is a file. */
interface StoredIdentityProvider {
  issuer: string;
  clientId: string;
  label: string | null;
  scopes: string | null;
}

function storedIdentityProvider(row: NodeSettingsRow | null): StoredIdentityProvider | null {
  if (!row?.idp_issuer || !row.idp_client_id) return null;
  return { issuer: row.idp_issuer, clientId: row.idp_client_id, label: row.idp_label, scopes: row.idp_scopes };
}

/** For the audit row: everything the provider section holds but the secret. */
function auditedProvider(p: StoredIdentityProvider | null) {
  return p ? { issuer: p.issuer, client_id: p.clientId, label: p.label, scopes: p.scopes } : null;
}

/** Printable text of at most `max` characters, or an error sentence. */
function plainText(v: string, max: number, what: string): string | null {
  if (v.length > max) return `the ${what} must be ${max} characters or fewer`;
  if (UNSAFE_TEXT.test(v)) return `the ${what} cannot contain control characters`;
  return null;
}

/** A name people read the node by: printable, and showing at least one character. */
function nameProblem(v: string): string | null {
  return plainText(v, MAX_NODE_NAME_CHARS, "name") ?? (hasVisibleText(v) ? null : "the name must contain a visible character");
}

/**
 * Validate the identity provider section: an issuer the node can reach and
 * that answers as an OpenID provider with the authorization-code flow. What is
 * stored is the provider's own spelling of its issuer.
 */
async function parseIdentityProvider(
  raw: unknown,
  stored: StoredIdentityProvider | null,
): Promise<{ provider: StoredIdentityProvider | null; secret: string | null | undefined } | { error: string; status: number }> {
  if (raw === null) return { provider: null, secret: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "identity_provider must be an object or null", status: 400 };
  const body = raw as Record<string, unknown>;

  const typedIssuer = typeof body.issuer === "string" ? body.issuer.trim() : "";
  const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
  if (!typedIssuer) return { error: "the identity provider needs an issuer URL", status: 400 };
  if (!clientId) return { error: "the identity provider needs a client ID", status: 400 };
  const clientIdProblem = plainText(clientId, 512, "client ID");
  if (clientIdProblem) return { error: clientIdProblem, status: 400 };

  let url: URL;
  try {
    url = new URL(typedIssuer);
  } catch {
    return { error: "the issuer must be an absolute URL, e.g. https://id.example.com", status: 400 };
  }
  // A token endpoint answers with credentials, so plain http is for a provider on this machine only.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return { error: "the issuer must be an https URL (http only for a provider on this machine)", status: 400 };
  }
  if (url.search || url.hash) return { error: "the issuer cannot have a query or a fragment", status: 400 };

  let label = stored?.label ?? null;
  if (body.label !== undefined) {
    label = optional(body.label) ?? null;
    const problem = label === null ? null : plainText(label, 60, "button label");
    if (problem) return { error: problem, status: 400 };
  }
  let scopes = stored?.scopes ?? null;
  if (body.scopes !== undefined) {
    scopes = optional(body.scopes)?.split(/\s+/).join(" ") ?? null;
    const problem = scopes === null ? null : plainText(scopes, 512, "scopes");
    if (problem) return { error: problem, status: 400 };
    if (scopes !== null && !scopes.split(" ").includes("openid")) return { error: "the scopes must include openid", status: 400 };
  }

  let secret: string | null | undefined;
  if (body.client_secret !== undefined && body.client_secret !== null) {
    if (typeof body.client_secret !== "string") return { error: "the client secret must be a string", status: 400 };
    const trimmed = body.client_secret.trim();
    if (trimmed.length > 4096) return { error: "the client secret is too long", status: 400 };
    secret = trimmed === "" ? null : trimmed;
  }

  let issuer: string;
  try {
    issuer = (await fetchProviderMetadata(typedIssuer)).issuer;
  } catch (e) {
    if (e instanceof ProviderError) return { error: `${e.message}. Check the issuer URL.`, status: 400 };
    throw e;
  }
  return { provider: { issuer, clientId, label, scopes }, secret };
}

interface SettingsCandidate {
  /** The row the save is resolved against; null when nothing has been saved. */
  row: NodeSettingsRow | null;
  sent: {
    nodeName: boolean;
    limits: boolean;
    maintenance: boolean;
    notify: boolean;
    branding: boolean;
    updates: boolean;
    backups: boolean;
    timeZone: boolean;
    identityProvider: boolean;
    search: boolean;
  };
  /** Null names the node after its host. */
  nodeName: string | null;
  maxUploadBytes: number | null;
  auditRetentionDays: number | null;
  databaseOpsKeep: number | null;
  aiUsageRetentionDays: number | null;
  askThreadRetentionDays: number | null;
  notify: NotifyConfig;
  notifySink: string | null;
  emailFrom: string | null;
  /** undefined keeps what is on file, null deletes it, a string replaces it. */
  webhookUrl: string | null | undefined;
  smtpUrl: string | null | undefined;
  brandAccentColor: string | null;
  /** Null takes the default, which looks for a newer version. */
  updateCheck: boolean | null;
  /** Null takes the defaults: daily, at 3. */
  backupAuto: boolean | null;
  backupHour: number | null;
  /** Null is UTC. */
  timeZone: string | null;
  /** undefined keeps what is on file, null deletes it, a data: URL replaces it. */
  identityProvider: StoredIdentityProvider | null;
  /** undefined keeps the client secret on file, null deletes it, a string replaces it. */
  idpClientSecret: string | null | undefined;
  /** undefined keeps them; a change rebuilds the search indexes. */
  searchLanguages: SearchLanguage[] | undefined;
}

/**
 * Validate a save against the row it is being applied to. `probe` is the
 * notification test, which reads only the notify group and never reaches out
 * to an identity provider.
 */
async function parseSettingsCandidate(
  ctx: Ctx,
  req: Request,
  opts: { probe?: boolean } = {},
): Promise<SettingsCandidate | { error: string; status: number }> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return { error: "expected a JSON body", status: 400 };

  // A read that fails fails the request: resolved against no row, a save would drop every stored setting.
  const row = await getNodeSettings(ctx.sql);
  const stored = ctx.env.settings.current();
  const sent = {
    nodeName: body.node_name !== undefined,
    limits: body.limits !== undefined,
    maintenance: body.maintenance !== undefined,
    notify: body.notify !== undefined,
    branding: body.branding !== undefined,
    updates: body.updates !== undefined,
    backups: body.backups !== undefined,
    timeZone: body.time_zone !== undefined,
    identityProvider: body.identity_provider !== undefined && !opts.probe,
    search: body.search !== undefined && !opts.probe,
  };
  if (!Object.values(sent).some(Boolean)) {
    return {
      error: "nothing to save: send node_name, limits, maintenance, notify, branding, updates, backups, time_zone, identity_provider or search",
      status: 400,
    };
  }
  const limits = (body.limits ?? {}) as Record<string, unknown>;
  const maintenance = (body.maintenance ?? {}) as Record<string, unknown>;
  const notify = (body.notify ?? {}) as Record<string, unknown>;
  const branding = (body.branding ?? {}) as Record<string, unknown>;
  const updates = (body.updates ?? {}) as Record<string, unknown>;
  const backups = (body.backups ?? {}) as Record<string, unknown>;
  const search = (body.search ?? {}) as Record<string, unknown>;

  // ---- the node's name. Empty goes back to the default, the host.
  let nodeName = row?.node_name ?? null;
  if (sent.nodeName) {
    if (body.node_name !== null && typeof body.node_name !== "string") return { error: "node_name must be a string", status: 400 };
    nodeName = optional(body.node_name) ?? null;
    const problem = nodeName === null ? null : nameProblem(nodeName);
    if (problem) return { error: problem, status: 400 };
  }

  // ---- limits
  let maxUploadBytes = row?.max_upload_bytes ?? null;
  if (sent.limits && limits.max_upload_mb !== undefined) {
    const mb = Number(limits.max_upload_mb);
    if (!Number.isInteger(mb)) return { error: "maximum upload size must be a whole number of megabytes", status: 400 };
    if (mb < 1) return { error: "maximum upload size must be at least 1 MB", status: 400 };
    const ceilingMb = Math.floor(MAX_UPLOAD_BYTES_CEILING / (1024 * 1024));
    if (mb > ceilingMb) {
      return {
        error: `maximum upload size cannot exceed ${ceilingMb} MB — the node holds each upload in memory while it arrives`,
        status: 400,
      };
    }
    maxUploadBytes = mb * 1024 * 1024;
  }

  // ---- maintenance. Days, with 0 keeping everything.
  let auditRetentionDays = row?.audit_retention_days ?? null;
  if (sent.maintenance && maintenance.audit_retention_days !== undefined) {
    const days = Number(maintenance.audit_retention_days);
    if (!Number.isInteger(days) || days < 0) {
      return { error: "audit retention must be a whole number of days (0 keeps every row)", status: 400 };
    }
    auditRetentionDays = days;
  }
  // A count of changes per database, not days; 0 keeps every change.
  let databaseOpsKeep = row?.database_ops_keep ?? null;
  if (sent.maintenance && maintenance.database_ops_keep !== undefined) {
    const n = Number(maintenance.database_ops_keep);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "database activity retention must be a whole number of changes (0 keeps every change)", status: 400 };
    }
    databaseOpsKeep = n;
  }
  let aiUsageRetentionDays = row?.ai_usage_retention_days ?? null;
  if (sent.maintenance && maintenance.ai_usage_retention_days !== undefined) {
    const days = Number(maintenance.ai_usage_retention_days);
    if (!Number.isInteger(days) || days < 0) {
      return { error: "AI usage retention must be a whole number of days (0 keeps every row)", status: 400 };
    }
    aiUsageRetentionDays = days;
  }
  let askThreadRetentionDays = row?.ask_thread_retention_days ?? null;
  if (sent.maintenance && maintenance.ask_thread_retention_days !== undefined) {
    const days = Number(maintenance.ask_thread_retention_days);
    if (!Number.isInteger(days) || days < 0) {
      return { error: "ask thread retention must be a whole number of days (0 keeps every thread)", status: 400 };
    }
    askThreadRetentionDays = days;
  }

  // ---- notify. The credentials are write-only: absent keeps, empty deletes.
  const notifySink = sent.notify && notify.sink !== undefined ? (optional(notify.sink) ?? null) : (row?.notify_sink ?? null);
  if (notifySink !== null && !NOTIFY_SINKS.includes(notifySink as (typeof NOTIFY_SINKS)[number])) {
    return { error: `unknown notification sink "${notifySink}"`, status: 400 };
  }
  const emailFrom = sent.notify && notify.email_from !== undefined ? (optional(notify.email_from) ?? null) : (row?.email_from ?? null);
  if (emailFrom !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFrom)) {
    return { error: `"${emailFrom}" is not an email address`, status: 400 };
  }
  const webhookUrl = sent.notify ? optional(notify.webhook_url) : undefined;
  if (typeof webhookUrl === "string") {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      return { error: "the webhook URL must be an absolute URL", status: 400 };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "the webhook URL must be http(s)", status: 400 };
    }
  }
  const smtpUrl = sent.notify ? optional(notify.smtp_url) : undefined;
  if (typeof smtpUrl === "string") {
    try {
      parseSmtpUrl(smtpUrl);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "the SMTP URL is not valid", status: 400 };
    }
  }

  // The candidate sink, resolved against what stays on file, so validation and
  // the test button both see what would actually deliver.
  const effectiveWebhook = webhookUrl === undefined ? (stored.notify.webhookUrl ?? null) : webhookUrl;
  const effectiveSmtp = smtpUrl === undefined ? (stored.notify.smtpUrl ?? null) : smtpUrl;
  const candidate: NotifyConfig = { sink: notifySink ?? "none" };
  if (effectiveWebhook) candidate.webhookUrl = effectiveWebhook;
  if (effectiveSmtp) candidate.smtpUrl = effectiveSmtp;
  if (emailFrom) candidate.emailFrom = emailFrom;
  const incomplete = notifyIncomplete(candidate);
  if (sent.notify && incomplete) return { error: incomplete, status: 400 };

  // ---- branding
  let brandAccentColor = row?.brand_accent_color ?? null;
  if (sent.branding && branding.accent_color !== undefined) {
    const color = optional(branding.accent_color) ?? null;
    if (color !== null && !HEX_COLOR.test(color)) {
      return { error: "the accent color must be a 6-digit hex value, e.g. #2563eb", status: 400 };
    }
    brandAccentColor = color;
  }

  // ---- updates. Only a real boolean: "false" would otherwise read as on.
  let updateCheck = row?.update_check ?? null;
  if (sent.updates && updates.check !== undefined) {
    if (typeof updates.check !== "boolean") return { error: "updates.check must be true or false", status: 400 };
    updateCheck = updates.check;
  }

  // ---- backups. The daily one, and its hour in the node's time zone.
  let backupAuto = row?.backup_auto ?? null;
  if (sent.backups && backups.auto !== undefined) {
    if (typeof backups.auto !== "boolean") return { error: "backups.auto must be true or false", status: 400 };
    backupAuto = backups.auto;
  }
  let backupHour = row?.backup_hour ?? null;
  if (sent.backups && backups.hour !== undefined) {
    if (!Number.isInteger(backups.hour) || (backups.hour as number) < 0 || (backups.hour as number) > 23) {
      return { error: "backups.hour must be a whole hour from 0 to 23", status: 400 };
    }
    backupHour = backups.hour as number;
  }
  let timeZone = row?.time_zone ?? null;
  if (sent.timeZone) {
    if (body.time_zone === null) timeZone = null;
    else {
      timeZone = knownTimeZone(body.time_zone);
      if (!timeZone) return { error: `"${String(body.time_zone)}" is not a time zone this node knows, e.g. Europe/Berlin`, status: 400 };
    }
  }

  // ---- search languages: only the choices this build offers.
  let searchLanguages: SearchLanguage[] | undefined;
  if (sent.search && search.languages !== undefined) {
    const parsed = parseSearchLanguages(search.languages);
    if (!parsed) return { error: `search.languages must be a list of: ${SEARCH_LANGUAGES.join(", ")}`, status: 400 };
    searchLanguages = parsed;
  }

  // ---- identity provider. The client secret is write-only, like the notify credentials.
  let identityProvider = storedIdentityProvider(row);
  let idpClientSecret: string | null | undefined;
  if (sent.identityProvider) {
    const parsed = await parseIdentityProvider(body.identity_provider, identityProvider);
    if ("error" in parsed) return parsed;
    identityProvider = parsed.provider;
    idpClientSecret = parsed.secret;
  }

  return {
    row,
    sent,
    nodeName,
    maxUploadBytes,
    auditRetentionDays,
    databaseOpsKeep,
    aiUsageRetentionDays,
    askThreadRetentionDays,
    notify: candidate,
    notifySink,
    emailFrom,
    webhookUrl,
    smtpUrl,
    brandAccentColor,
    updateCheck,
    backupAuto,
    backupHour,
    timeZone,
    identityProvider,
    idpClientSecret,
    searchLanguages,
  };
}

async function nodeSettingsResponse(ctx: Ctx): Promise<Response> {
  const row = await getNodeSettings(ctx.sql);
  const saved = ctx.env.settings.current();
  const secrets = ctx.env.settings.secrets();
  const search = ctx.env.searchLanguages.status();

  return json({
    node_name: saved.nodeName,
    // What agents and the switcher call the node: the name, else its host.
    node_label: saved.nodeLabel,
    limits: {
      max_upload_mb: Math.floor(saved.maxUploadBytes / (1024 * 1024)),
      ceiling_mb: Math.floor(MAX_UPLOAD_BYTES_CEILING / (1024 * 1024)),
    },
    maintenance: {
      audit_retention_days: saved.auditRetentionDays,
      database_ops_keep: saved.databaseOpsKeep,
      ai_usage_retention_days: saved.aiUsageRetentionDays,
      ask_thread_retention_days: saved.askThreadRetentionDays,
    },
    notify: {
      sink: saved.notify.sink,
      email_from: saved.notify.emailFrom ?? null,
      // Never the credential: the label tells two sinks apart without being able to post to either.
      webhook_set: secrets.webhook.set,
      webhook_label: secrets.webhook.label,
      webhook_stale: secrets.webhook.stale,
      smtp_set: secrets.smtp.set,
      smtp_label: secrets.smtp.label,
      smtp_stale: secrets.smtp.stale,
    },
    branding: { accent_color: saved.branding.accentColor },
    // What the last look found is part of the node's version: GET /api/node/version.
    updates: { check: saved.updateCheck },
    // The backups themselves, and whether one is running: GET /api/node/backups.
    backups: { auto: saved.backups.auto, hour: saved.backups.hour },
    time_zone: saved.timeZone,
    // The languages chosen; while `rebuilding`, and after a rebuild that gave up (`error`), search uses those both sets share.
    search: {
      languages: search.languages,
      choices: SEARCH_LANGUAGES,
      rebuilding: search.rebuilding,
      error: search.error,
    },
    identity_provider: {
      issuer: row?.idp_issuer ?? null,
      client_id: row?.idp_client_id ?? null,
      label: row?.idp_label ?? null,
      default_label: row?.idp_issuer ? issuerHost(row.idp_issuer) : null,
      scopes: row?.idp_scopes ?? null,
      default_scopes: DEFAULT_IDP_SCOPES,
      client_secret_set: secrets.idpClientSecret.set,
      client_secret_label: secrets.idpClientSecret.label,
      client_secret_stale: secrets.idpClientSecret.stale,
      // Every origin the SPA may be served from starts its own sign-ins, so each needs registering.
      callback_urls: [ctx.env.publicOrigin, ...ctx.env.extraOrigins].map((o) => `${o}${CALLBACK_PATH}`),
      // Linked accounts with no password: once the provider goes, each needs one to sign in again.
      accounts_without_password: await countAccountsWithoutPassword(ctx.sql),
    },
    // How a change to the read-only `node` facts below takes effect.
    restart_hint: ctx.env.restartHint,
    node: {
      node_id: ctx.env.nodeId,
      public_origin: ctx.env.publicOrigin,
      extra_origins: ctx.env.extraOrigins,
      bind: ctx.env.bind,
      port: ctx.env.port,
      data_dir: ctx.env.dataDir,
      database: redactUrl(ctx.env.databaseUrl),
      embedding_dims: ctx.env.embeddingDims,
    },
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  });
}

/**
 * The credential files a save or a reset leaves behind, applied only once the
 * row describing them has committed: a failed transaction changes nothing on
 * disk. The row is then the truth, so a file that fails to write is logged and
 * the rest still go; a missing one shows as stale beside its label.
 */
function applySecretFiles(ctx: Ctx, files: Array<[file: string, value: string | null | undefined]>): void {
  for (const [file, value] of files) {
    try {
      if (value === null) removeSecretFile(ctx.env.dataDir, file);
      else if (typeof value === "string") writeSecretFile(ctx.env.dataDir, file, value);
    } catch (e) {
      console.error(`[node] settings saved, but the secret file ${file} could not be ${value === null ? "removed" : "written"}`, e);
    }
  }
}

async function saveNodeSettings(ctx: Ctx, req: Request): Promise<Response> {
  const parsed = await parseSettingsCandidate(ctx, req);
  if ("error" in parsed) return error(parsed.status, parsed.error);

  const before = ctx.env.settings.current();
  const searchBefore = ctx.env.searchLanguages.status().languages;
  const { row } = parsed;

  // Labels for what the files will hold, written with the row; the files follow the commit.
  let webhookLabel = row?.notify_webhook_label ?? null;
  if (parsed.webhookUrl === null) webhookLabel = null;
  else if (typeof parsed.webhookUrl === "string") webhookLabel = fingerprintUrl(parsed.webhookUrl);
  let smtpLabel = row?.smtp_label ?? null;
  if (parsed.smtpUrl === null) smtpLabel = null;
  else if (typeof parsed.smtpUrl === "string") smtpLabel = redactUrl(parsed.smtpUrl);
  // Removing the provider removes its secret too.
  const idpSecret = parsed.identityProvider === null ? null : parsed.idpClientSecret;
  let idpSecretLabel = row?.idp_client_secret_label ?? null;
  if (idpSecret === null) idpSecretLabel = null;
  else if (typeof idpSecret === "string") idpSecretLabel = sha256Hex(idpSecret).slice(0, 8);

  // The search languages are written on their own, after the row: a save of them alone leaves the row as it is.
  const rowSent = Object.entries(parsed.sent).some(([group, sent]) => sent && group !== "search");

  // One transaction: a new issuer, or none, takes every subject linked under the old one with it.
  const { unlinkedAccounts } = !rowSent ? { unlinkedAccounts: 0 } : await saveSettingsRow(ctx.sql, {
    nodeName: parsed.nodeName,
    maxUploadBytes: parsed.maxUploadBytes,
    auditRetentionDays: parsed.auditRetentionDays,
    databaseOpsKeep: parsed.databaseOpsKeep,
    aiUsageRetentionDays: parsed.aiUsageRetentionDays,
    askThreadRetentionDays: parsed.askThreadRetentionDays,
    notifySink: parsed.notifySink,
    notifyWebhookLabel: webhookLabel,
    smtpLabel,
    emailFrom: parsed.emailFrom,
    brandAccentColor: parsed.brandAccentColor,
    updateCheck: parsed.updateCheck,
    backupAuto: parsed.backupAuto,
    backupHour: parsed.backupHour,
    timeZone: parsed.timeZone,
    identityProvider: parsed.identityProvider ? { ...parsed.identityProvider, clientSecretLabel: idpSecretLabel } : null,
    updatedBy: ctx.alias,
  });
  applySecretFiles(ctx, [
    [WEBHOOK_URL_FILE, parsed.webhookUrl],
    [SMTP_URL_FILE, parsed.smtpUrl],
    [IDP_CLIENT_SECRET_FILE, idpSecret],
  ]);
  // Once a change has committed it is audited, even when the languages' write or the refresh then fails.
  let committed = rowSent;
  try {
    if (parsed.searchLanguages) {
      // Online: the answer says it is rebuilding, and search keeps answering meanwhile.
      await ctx.env.searchLanguages.save(parsed.searchLanguages, ctx.alias);
      committed = true;
    }
    await ctx.env.settings.refresh();
  } finally {
    if (committed) auditSave(ctx, parsed, { ...before, searchLanguages: searchBefore }, unlinkedAccounts);
  }
  return nodeSettingsResponse(ctx);
}

/**
 * The audit row of a committed save. The provider and the unlinked count come
 * from the request and the transaction, so a failed refresh cannot lose them.
 */
function auditSave(
  ctx: Ctx,
  parsed: SettingsCandidate,
  before: ResolvedNodeSettings & { searchLanguages: SearchLanguage[] },
  unlinkedAccounts: number,
): void {
  const after = ctx.env.settings.current();
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.settings.update",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    // Everything but credentials, before and after: the only record of a repointed sink.
    detail: {
      before: {
        node_name: before.nodeName,
        max_upload_bytes: before.maxUploadBytes,
        audit_retention_days: before.auditRetentionDays,
        database_ops_keep: before.databaseOpsKeep,
        ai_usage_retention_days: before.aiUsageRetentionDays,
        ask_thread_retention_days: before.askThreadRetentionDays,
        notify_sink: before.notify.sink,
        brand_accent_color: before.branding.accentColor,
        update_check: before.updateCheck,
        backups: before.backups,
        time_zone: before.timeZone,
        identity_provider: auditedProvider(storedIdentityProvider(parsed.row)),
        search_languages: before.searchLanguages,
      },
      after: {
        node_name: after.nodeName,
        max_upload_bytes: after.maxUploadBytes,
        audit_retention_days: after.auditRetentionDays,
        database_ops_keep: after.databaseOpsKeep,
        ai_usage_retention_days: after.aiUsageRetentionDays,
        ask_thread_retention_days: after.askThreadRetentionDays,
        notify_sink: after.notify.sink,
        brand_accent_color: after.branding.accentColor,
        update_check: after.updateCheck,
        backups: after.backups,
        time_zone: after.timeZone,
        identity_provider: auditedProvider(parsed.identityProvider),
        identity_provider_secret_changed: parsed.idpClientSecret !== undefined,
        search_languages: ctx.env.searchLanguages.status().languages,
        ...(unlinkedAccounts > 0 ? { identity_provider_unlinked_accounts: unlinkedAccounts } : {}),
      },
    },
  });
}

async function resetNodeSettings(ctx: Ctx): Promise<Response> {
  // The row, the provider and every link to one go together; the files only once that has committed.
  const { identityProvider, unlinkedAccounts } = await resetSettingsRow(ctx.sql);
  applySecretFiles(ctx, [
    [WEBHOOK_URL_FILE, null],
    [SMTP_URL_FILE, null],
    [IDP_CLIENT_SECRET_FILE, null],
  ]);
  // The reset has committed, so it is audited even when the refresh fails.
  try {
    await ctx.env.settings.refresh();
  } finally {
    recordAudit(nodeAuditCtx(ctx), {
      action: "node.settings.reset",
      targetKind: "node",
      targetId: ctx.env.publicOrigin,
      detail: {
        ...(identityProvider ? { identity_provider: auditedProvider(identityProvider) } : {}),
        ...(unlinkedAccounts > 0 ? { identity_provider_unlinked_accounts: unlinkedAccounts } : {}),
      },
    });
  }
  return nodeSettingsResponse(ctx);
}

export async function testNotifySink({ ctx, req }: WorkspaceCall): Promise<Response> {
  const parsed = await parseSettingsCandidate(ctx, req, { probe: true });
  if ("error" in parsed) return error(parsed.status, parsed.error);
  const probe = await probeNotify(parsed.notify, ctx.env.publicOrigin);
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.settings.notify_test",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    // An outbound request to a URL of the caller's choosing is recorded like a change.
    detail: { sink: parsed.notify.sink, ok: probe.ok },
  });
  // A failed probe answers the question the button asked: 200 with ok:false.
  return json(probe);
}

export async function getNodeSettingsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  return nodeSettingsResponse(ctx);
}

export async function saveNodeSettingsRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  return saveNodeSettings(ctx, req);
}

export async function resetNodeSettingsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  return resetNodeSettings(ctx);
}
