/**
 * The remote-access row (docs/remote-access.md): one per node, created on the first write. Each function
 * writes only its own columns, so the loops that share the row never undo one another. No secret
 * is stored here; the keys and the certificate are files under the data directory.
 */
import type { NodeRemoteAccessRow, StoredRemoteError, StoredRemoteRelay } from "./types.js";
import { jsonb, type Queryable } from "./sql.js";

const DEFAULTS: NodeRemoteAccessRow = {
  enabled: false,
  enabled_by: null,
  enabled_at: null,
  remote_id: null,
  hostname: null,
  api_url: null,
  binding_thumbprint: null,
  bound_at: null,
  binding_failing_since: null,
  relays: [],
  acme_directory: null,
  acme_profile: null,
  acme_reissue_before: null,
  acme_account_directory: null,
  acme_account_url: null,
  ca_terms_accepted_by: null,
  ca_terms_accepted_at: null,
  ca_terms_url: null,
  cert_serial: null,
  cert_directory: null,
  cert_not_before: null,
  cert_not_after: null,
  cert_renew_at: null,
  cert_reissue_before: null,
  cert_failures: 0,
  cert_retry_at: null,
  cert_account_url: null,
  cert_ari_next_at: null,
  cert_ari_window_start: null,
  cert_ari_window_end: null,
  cert_alerted_serial: null,
  checkin_at: null,
  checkin_next_at: null,
  credential_ttl: null,
  credential_not_before: null,
  credential_issued_at: null,
  credential_expires_at: null,
  credential_refresh_at: null,
  credential_failures: 0,
  credential_retry_at: null,
  probe_at: null,
  probe_ok_at: null,
  probe_failures: 0,
  connector_config_sha256: null,
  connector_config_changed_at: null,
  last_error: null,
  updated_at: null,
};

/** The row, or every column's default when nothing has been written. */
export async function getRemoteAccess(sql: Queryable): Promise<NodeRemoteAccessRow> {
  const [row] = await sql<Array<NodeRemoteAccessRow & { id: boolean }>>`SELECT * FROM node_remote_access WHERE id = TRUE`;
  if (!row) return { ...DEFAULTS, relays: [] };
  const { id: _id, ...rest } = row;
  return rest;
}

/**
 * Set `columns` on the row, creating it first. Not one INSERT … ON CONFLICT: Postgres checks the
 * row it would insert before it finds the conflict, and a partial row fails the table's CHECK.
 */
async function update(sql: Queryable, columns: Record<string, unknown>): Promise<void> {
  await sql`INSERT INTO node_remote_access (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE node_remote_access SET ${sql(columns)}, updated_at = now() WHERE id = TRUE`;
}

export interface RemoteBinding {
  remoteId: string;
  hostname: string;
  apiUrl: string;
  thumbprint: string;
  boundAt: Date;
}

/** A new or restored binding, which ends any run of refusals from the service. */
export async function saveRemoteBinding(sql: Queryable, b: RemoteBinding): Promise<void> {
  await update(sql, {
    remote_id: b.remoteId,
    hostname: b.hostname,
    api_url: b.apiUrl,
    binding_thumbprint: b.thumbprint,
    bound_at: b.boundAt,
    binding_failing_since: null,
  });
}

export type RemoteEnabled =
  | { enabled: true; by: string; at: Date; caTermsAcceptedBy: string; caTermsAcceptedAt: Date }
  | { enabled: false };

/** On, with who turned it on and accepted the CA's terms; or off, which keeps that record. */
export async function setRemoteEnabled(sql: Queryable, e: RemoteEnabled): Promise<void> {
  if (!e.enabled) {
    await update(sql, { enabled: false });
    return;
  }
  await update(sql, {
    enabled: true,
    enabled_by: e.by,
    enabled_at: e.at,
    ca_terms_accepted_by: e.caTermsAcceptedBy,
    ca_terms_accepted_at: e.caTermsAcceptedAt,
  });
}

export interface RemoteCheckin {
  at: Date;
  nextAt: Date;
  apiUrl: string;
  hostname: string;
  relays: StoredRemoteRelay[];
  acmeDirectory: string;
  acmeProfile: string | null;
  acmeReissueBefore: Date | null;
  credentialTtl: number;
  credentialNotBefore: Date | null;
}

/** What a check-in answered. A check-in that got through ends any run of refusals. */
export async function recordRemoteCheckin(sql: Queryable, c: RemoteCheckin): Promise<void> {
  await update(sql, {
    checkin_at: c.at,
    checkin_next_at: c.nextAt,
    api_url: c.apiUrl,
    hostname: c.hostname,
    relays: jsonb(sql, c.relays),
    acme_directory: c.acmeDirectory,
    acme_profile: c.acmeProfile,
    acme_reissue_before: c.acmeReissueBefore,
    credential_ttl: c.credentialTtl,
    credential_not_before: c.credentialNotBefore,
    binding_failing_since: null,
  });
}

/** When the next check-in is due, apart from a whole check-in: a denied node checks in hourly. */
export async function setRemoteCheckinNext(sql: Queryable, nextAt: Date): Promise<void> {
  await update(sql, { checkin_next_at: nextAt });
}

/** The ACME account in use, the directory it belongs to, and the terms it agreed to. */
export async function recordRemoteAccount(
  sql: Queryable,
  a: { directory: string | null; url: string | null; termsUrl: string | null },
): Promise<void> {
  await update(sql, { acme_account_directory: a.directory, acme_account_url: a.url, ca_terms_url: a.termsUrl });
}

export interface RemoteCert {
  serial: string;
  /** The CA directory it came from; null for one found on disk that the row did not describe. */
  directory: string | null;
  notBefore: Date;
  notAfter: Date;
  renewAt: Date;
  /** The reissue request in hand when it was issued, which it answers; null when there was none, or unknown. */
  reissueBefore: Date | null;
  /** The ACME account that ordered it; null when unknown. */
  accountUrl: string | null;
}

/**
 * A certificate now in use, which ends any run of failures to get one. The CA's renewal window
 * belonged to the one before: it is asked for this one at once.
 */
export async function recordRemoteCert(sql: Queryable, c: RemoteCert): Promise<void> {
  await update(sql, {
    cert_serial: c.serial,
    cert_directory: c.directory,
    cert_not_before: c.notBefore,
    cert_not_after: c.notAfter,
    cert_renew_at: c.renewAt,
    cert_reissue_before: c.reissueBefore,
    cert_account_url: c.accountUrl,
    cert_failures: 0,
    cert_retry_at: null,
    cert_ari_next_at: null,
    cert_ari_window_start: null,
    cert_ari_window_end: null,
  });
}

/** The CA's renewal window, the time chosen in it, and when to ask again. The failure count stays. */
export async function recordRemoteCertAri(
  sql: Queryable,
  a: { windowStart: Date; windowEnd: Date; renewAt: Date; nextAt: Date },
): Promise<void> {
  await update(sql, {
    cert_ari_window_start: a.windowStart,
    cert_ari_window_end: a.windowEnd,
    cert_renew_at: a.renewAt,
    cert_ari_next_at: a.nextAt,
  });
}

/** When to ask the CA for the renewal window next, after it could not be had. */
export async function setRemoteCertAriNext(sql: Queryable, nextAt: Date): Promise<void> {
  await update(sql, { cert_ari_next_at: nextAt });
}

/** The certificate the administrators were warned about, or null once that is over. */
export async function setRemoteCertAlerted(sql: Queryable, serial: string | null): Promise<void> {
  await update(sql, { cert_alerted_serial: serial });
}

export async function recordRemoteCertFailure(sql: Queryable, f: { failures: number; retryAt: Date | null }): Promise<void> {
  await update(sql, { cert_failures: f.failures, cert_retry_at: f.retryAt });
}

/** A relay credential now in use, or none (all null), which ends any run of failures to get one. */
export async function recordRemoteCredential(
  sql: Queryable,
  c: { issuedAt: Date | null; expiresAt: Date | null; refreshAt: Date | null },
): Promise<void> {
  await update(sql, {
    credential_issued_at: c.issuedAt,
    credential_expires_at: c.expiresAt,
    credential_refresh_at: c.refreshAt,
    credential_failures: 0,
    credential_retry_at: null,
  });
}

export async function recordRemoteCredentialFailure(sql: Queryable, f: { failures: number; retryAt: Date | null }): Promise<void> {
  await update(sql, { credential_failures: f.failures, credential_retry_at: f.retryAt });
}

/** One self-check through the relay: a success resets the count of failures in a row. */
export async function recordRemoteProbe(sql: Queryable, p: { at: Date; ok: boolean }): Promise<void> {
  if (p.ok) {
    await update(sql, { probe_at: p.at, probe_ok_at: p.at, probe_failures: 0 });
    return;
  }
  await sql`INSERT INTO node_remote_access (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`;
  await sql`
    UPDATE node_remote_access
    SET probe_at = ${p.at}, probe_failures = probe_failures + 1, updated_at = now()
    WHERE id = TRUE`;
}

export async function recordRemoteConnectorConfig(sql: Queryable, c: { sha256: string; changedAt: Date }): Promise<void> {
  await update(sql, { connector_config_sha256: c.sha256, connector_config_changed_at: c.changedAt });
}

/** The first refusal of the binding in a run; a later one leaves the time it started. */
export async function setRemoteBindingFailing(sql: Queryable, since: Date): Promise<void> {
  await sql`INSERT INTO node_remote_access (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`;
  await sql`
    UPDATE node_remote_access
    SET binding_failing_since = COALESCE(binding_failing_since, ${since}), updated_at = now()
    WHERE id = TRUE`;
}

export async function setRemoteError(sql: Queryable, err: StoredRemoteError | null): Promise<void> {
  await update(sql, { last_error: err === null ? null : jsonb(sql, err) });
}
