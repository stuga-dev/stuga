/**
 * The remote address's certificate (docs/remote-access.md): one file holding the key and the chain,
 * so both change together; the local evidence that a new one is needed; and getting one from the
 * CA, with the service publishing the DNS challenge. Only what the node sees for itself leads to a
 * new certificate, never a refusal from the service, so a service that misbehaves cannot spend the
 * zone's issuance budget.
 */
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeRemoteAccessRow, StoredRemoteError } from "@stuga/db";
import { AcmeClient, AcmeError, fetchDirectory, type AcmeClock, type AcmeDirectory } from "./acme/client.js";
import { pemBlocks } from "./acme/der.js";
import type { AcmeTransport } from "./acme/transport.js";
import { DnsNotVisible } from "./dns-check.js";
import { ensurePrivateDir, writeFileDurable } from "./files.js";
import { loadOrCreateAcmeAccountKey, pkcs8Pem, spkiSha256 } from "./keys.js";
import { generalBackoff, remoteError } from "./state.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const remoteDataDir = (dataDir: string): string => join(dataDir, "remote");
export const certificatePath = (dataDir: string): string => join(remoteDataDir(dataDir), "certificate.pem");

export interface LoadedCert {
  key: KeyObject;
  keyPem: string;
  /** Leaf first. */
  chainPem: string;
  leafPem: string;
  leaf: X509Certificate;
  notBefore: Date;
  notAfter: Date;
  /** Lowercase hex without leading zero bytes. */
  serial: string;
  spkiSha256: string;
}

export type CertOnDisk =
  | { kind: "missing" }
  | { kind: "unreadable"; why: string }
  | { kind: "mismatch" }
  | { kind: "ok"; cert: LoadedCert };

/** The key and the chain out of one PEM file; `mismatch` when the key is not the leaf's. */
export function parseCertificateFile(text: string): CertOnDisk {
  const keyPem = pemBlocks(text, "PRIVATE KEY")[0];
  const chain = pemBlocks(text, "CERTIFICATE");
  if (!keyPem || chain.length === 0) return { kind: "unreadable", why: "no key or no certificate" };
  let key: KeyObject;
  let leaf: X509Certificate;
  try {
    key = createPrivateKey(keyPem);
    leaf = new X509Certificate(chain[0]!);
  } catch (e) {
    return { kind: "unreadable", why: (e as Error).message };
  }
  if (!leaf.checkPrivateKey(key)) return { kind: "mismatch" };
  return {
    kind: "ok",
    cert: {
      key,
      keyPem,
      chainPem: chain.join(""),
      leafPem: chain[0]!,
      leaf,
      notBefore: new Date(leaf.validFrom),
      notAfter: new Date(leaf.validTo),
      serial: leaf.serialNumber.toLowerCase().replace(/^(00)+(?=.)/, ""),
      spkiSha256: spkiSha256(key),
    },
  };
}

export async function readCertificate(dataDir: string): Promise<CertOnDisk> {
  let text: string;
  try {
    text = await readFile(certificatePath(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", why: (e as Error).message };
  }
  return parseCertificateFile(text);
}

/** Key first, then the chain, written whole or not at all. */
export async function writeCertificate(dataDir: string, key: KeyObject, chainPem: string): Promise<void> {
  await ensurePrivateDir(remoteDataDir(dataDir), 0o700);
  await writeFileDurable(certificatePath(dataDir), `${pkcs8Pem(key)}${chainPem}`, 0o600);
}

/** Whether the leaf names exactly `hostname` and nothing else. */
export function namesExactly(cert: LoadedCert, hostname: string): boolean {
  return cert.leaf.subjectAltName === `DNS:${hostname}`;
}

/** Whether the certificate can serve `hostname` now. */
export function certUsable(cert: LoadedCert | null, hostname: string | null, now: number): cert is LoadedCert {
  return (
    cert !== null &&
    hostname !== null &&
    namesExactly(cert, hostname) &&
    cert.notBefore.getTime() <= now &&
    now < cert.notAfter.getTime()
  );
}

/** Two thirds into the certificate's life, less up to a twentieth of it. */
export function certRenewAt(notBefore: Date, notAfter: Date, rand: () => number): Date {
  const lifetime = notAfter.getTime() - notBefore.getTime();
  return new Date(notBefore.getTime() + (lifetime * 2) / 3 - rand() * (lifetime / 20));
}

/** After the CA's renewal information could not be had, or the CA offers none (RFC 9773 4.3.3). */
export const ARI_RETRY_MS = 6 * 60 * MINUTE;

/**
 * When to renew in the CA's window (RFC 9773 4.2): a time drawn evenly from it, kept while the
 * window stays the same; now, once the window has ended.
 */
export function ariRenewAt(
  window: { start: Date; end: Date },
  held: { start: Date | null; end: Date | null; renewAt: Date | null },
  now: number,
  rand: () => number,
): Date {
  const start = window.start.getTime();
  const end = window.end.getTime();
  if (end <= now) return new Date(now);
  const same = held.start?.getTime() === start && held.end?.getTime() === end;
  const kept = held.renewAt?.getTime();
  if (same && kept !== undefined && kept >= start && kept < end) return held.renewAt!;
  return new Date(start + rand() * (end - start));
}

export type IssuanceEvidence = "missing" | "unreadable" | "key_mismatch" | "names" | "due" | "reissue_requested";

/**
 * Why a new certificate is needed, from what the node itself holds, or null when it is not. When
 * the row does not describe the certificate on disk, its own dates decide when it is due.
 */
export function issuanceEvidence(disk: CertOnDisk, row: NodeRemoteAccessRow, now: number): IssuanceEvidence | null {
  if (disk.kind === "missing") return "missing";
  if (disk.kind === "unreadable") return "unreadable";
  if (disk.kind === "mismatch") return "key_mismatch";
  const { cert } = disk;
  if (!row.hostname || !namesExactly(cert, row.hostname)) return "names";
  const lifetime = cert.notAfter.getTime() - cert.notBefore.getTime();
  const renewAt =
    row.cert_serial === cert.serial && row.cert_renew_at ? row.cert_renew_at.getTime() : cert.notBefore.getTime() + (lifetime * 2) / 3;
  if (now >= renewAt || now >= cert.notAfter.getTime()) return "due";
  // Once per request. A CA may backdate notBefore (Let's Encrypt by an hour), so a certificate issued
  // in answer can still look older than the request; the row says which request it answers.
  const asked = row.acme_reissue_before?.getTime();
  const answered = row.cert_serial === cert.serial ? row.cert_reissue_before?.getTime() : undefined;
  if (asked && asked > cert.notBefore.getTime() && !(answered !== undefined && answered >= asked)) return "reissue_requested";
  return null;
}

/** What a failure to get a certificate means: the error to show, when to try again, and what to forget. */
export interface CertFailure {
  lastError: StoredRemoteError;
  /** Null: not until an administrator acts. */
  retryAt: Date | null;
  /** The CA no longer knows the account: make a new one next time. */
  forgetAccount?: true;
}

/** For a failure from the CA or the DNS check; the service's own refusals go through serviceFailure. */
export function certFailure(err: unknown, ctx: { now: Date; failures: number; rand: () => number }): CertFailure {
  const { now, failures, rand } = ctx;
  const after = (ms: number) => new Date(now.getTime() + ms);
  const general = () => after(generalBackoff(failures, rand));
  if (err instanceof DnsNotVisible) {
    const retryAt = general();
    return { lastError: remoteError("dns_not_visible", err.message, now, { retryAt }), retryAt };
  }
  if (err instanceof AcmeError) {
    if (err.is("userActionRequired")) {
      return { lastError: remoteError("acme_action_required", err.detail, now), retryAt: null };
    }
    if (err.is("rateLimited")) {
      const retryAt = after(Math.min(Math.max((err.retryAfter ?? 3600) * 1000, MINUTE), 7 * DAY));
      return { lastError: remoteError("acme_rate_limited", err.detail, now, { retryAt }), retryAt };
    }
    if (err.authorization) {
      // The CA allows few failed authorizations per name per hour.
      const retryAt = after(Math.max(15 * MINUTE, generalBackoff(failures, rand)));
      return { lastError: remoteError("acme_challenge_failed", err.detail, now, { retryAt }), retryAt };
    }
    const retryAt = general();
    return {
      lastError: remoteError("acme_error", err.detail, now, { retryAt }),
      retryAt,
      ...(err.is("accountDoesNotExist") ? { forgetAccount: true as const } : {}),
    };
  }
  const retryAt = general();
  return { lastError: remoteError("acme_error", (err as Error)?.message ?? String(err), now, { retryAt }), retryAt };
}

const DIRECTORY_CACHE_MS = DAY;

export type DirectoryCache = Map<string, { directory: AcmeDirectory; at: number }>;

/** The directory at `url`, fetched at most once a day. */
export async function cachedDirectory(cache: DirectoryCache, transport: AcmeTransport, url: string, now: number): Promise<AcmeDirectory> {
  const cached = cache.get(url);
  if (cached && now - cached.at < DIRECTORY_CACHE_MS) return cached.directory;
  const directory = await fetchDirectory(transport, url);
  cache.set(url, { directory, at: now });
  return directory;
}

/**
 * The directory's `meta.termsOfService`, which the Settings page links to: kept only when it is an
 * https URL, since the directory is whatever the service names. Null otherwise.
 */
export function caTermsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export interface ObtainDeps {
  transport: AcmeTransport;
  dataDir: string;
  directoryUrl: string;
  /** The account the node has, and the directory it is on. */
  account: { directory: string | null; url: string | null };
  hostname: string;
  profile: string | null;
  dns: { present(value: string): Promise<void>; verify(value: string): Promise<void>; cleanup(): Promise<void> };
  /** A new account was made: its URL and the terms it agreed to. */
  onAccount(account: { directory: string; url: string; termsUrl: string | null }): Promise<void>;
  /** The certificate this one renews, named to the CA only from the account that ordered it. */
  replaces?: { certId: string; accountUrl: string } | null;
  directories: DirectoryCache;
  clock: AcmeClock;
  newKey(): KeyObject;
}

/** A new key and a certificate for it: the account for this directory (made when missing), then an order. */
export async function obtainCertificate(d: ObtainDeps): Promise<{ key: KeyObject; chainPem: string; accountUrl: string }> {
  const directory = await cachedDirectory(d.directories, d.transport, d.directoryUrl, d.clock.now());
  const accountKey = await loadOrCreateAcmeAccountKey(d.dataDir, d.directoryUrl);
  const client = new AcmeClient({
    transport: d.transport,
    directory,
    accountKey,
    accountUrl: d.account.directory === d.directoryUrl ? d.account.url : null,
    clock: d.clock,
  });
  if (!client.accountUrl) {
    const url = await client.ensureAccount();
    await d.onAccount({ directory: d.directoryUrl, url, termsUrl: caTermsUrl(directory.meta?.termsOfService) });
  }
  const accountUrl = client.accountUrl!;
  // Only to a CA that offers renewal information (RFC 9773 5).
  const replaces = d.replaces && directory.renewalInfo && d.replaces.accountUrl === accountUrl ? d.replaces.certId : null;
  const key = d.newKey();
  const chainPem = await client.issue({ hostname: d.hostname, key, profile: d.profile, replaces, dns: d.dns });
  return { key, chainPem, accountUrl };
}
