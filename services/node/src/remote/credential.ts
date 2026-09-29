/**
 * The relay credential and the check-ins it rests on (docs/remote-access.md): when to check in,
 * when to get a new credential and what to prove for it, and where the connector reads it. The
 * credential is a short-lived JWT; the node keeps it only in the connector's token files.
 */
import { sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { NodeRemoteAccessRow } from "@stuga/db";
import { tokenFile } from "./frpc-config.js";

const MINUTE = 60_000;

export interface HeldCredential {
  jwt: string;
  /** Unix seconds, from the service's clock. */
  iat: number;
  exp: number;
}

/** The claims a credential carries, read without checking it: the node is not its audience. */
export function credentialClaims(jwt: string): { iat: number; exp: number } | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat?: unknown; exp?: unknown };
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number") return null;
    return { iat: claims.iat, exp: claims.exp };
  } catch {
    return null;
  }
}

/** The credential the first relay's connector reads, or null when there is none to read. */
export async function readHeldCredential(dir: string, relays: readonly { name: string }[]): Promise<HeldCredential | null> {
  const first = relays[0];
  if (!first) return null;
  let jwt: string;
  try {
    jwt = (await readFile(tokenFile(dir, first.name), "utf8")).trim();
  } catch {
    return null;
  }
  const claims = credentialClaims(jwt);
  return claims ? { jwt, ...claims } : null;
}

/** Proof of the certificate's key, bound to the check-in's one-time nonce: ECDSA P-256, r||s, base64url. */
export function proofOfPossession(certKey: KeyObject, id: string, nonce: string): string {
  return sign("sha256", Buffer.from(`stuga-relay-pop:v1:${id}:${nonce}`, "utf8"), { key: certKey, dsaEncoding: "ieee-p1363" }).toString(
    "base64url",
  );
}

/** The service's `refresh_at`, held between a tenth and half of the credential's life. Unix seconds. */
export function clampRefreshAt(issuedAt: number, expiresAt: number, refreshAt: number): number {
  const ttl = expiresAt - issuedAt;
  return Math.min(Math.max(refreshAt, issuedAt + ttl / 10), issuedAt + ttl / 2);
}

/** The service's `next_checkin_at`, held between five minutes and a day from now. Unix seconds. */
export function clampNextCheckin(now: number, next: number): number {
  return Math.min(Math.max(next, now + 300), now + 86_400);
}

export type RefreshReason = "scheduled" | "not_before" | "probe";

export interface ServicePlanInput {
  now: number;
  row: NodeRemoteAccessRow;
  /** `iat` on the service's clock, as `credential_not_before` is; `exp` on this node's. Milliseconds. */
  credential: { iat: number; exp: number } | null;
  /** A certificate that serves the hostname now: without one there is nothing to prove. */
  certUsable: boolean;
  /** Start, enable, an administrator's kick, or a self-check through the relay while denied. */
  checkinWanted: boolean;
  /** A denied node was let back in: a credential straight away. */
  refreshWanted: boolean;
  lastRefreshAt: number | null;
  lastProbeRefreshAt: number | null;
  /** Least time between refreshes outside the schedule. */
  refreshSpacingMs: number;
  /** Least time between refreshes a failing self-check asks for. */
  probeRefreshSpacingMs: number;
}

export interface ServicePlan {
  checkin: boolean;
  refresh: RefreshReason | null;
}

/**
 * What the service loop does on this tick. A refresh is a check-in (for its nonce) and then the
 * credential; one outside the schedule waits a minute after the last, and one a failing
 * self-check asks for, ten. During a backoff a check-in someone asked for still goes, but no
 * refresh does until `credential_retry_at`. A denied node only checks in, hourly.
 */
export function planServiceTick(p: ServicePlanInput): ServicePlan {
  const { now, row } = p;
  const at = (d: Date | null) => (d ? d.getTime() : null);
  const code = row.last_error?.code;
  const checkinDue = p.checkinWanted || row.checkin_next_at === null || now >= row.checkin_next_at.getTime();
  if (code === "denied" || code === "retired") return { checkin: checkinDue, refresh: null };
  const retryAt = at(row.credential_retry_at);
  const backingOff = retryAt !== null && now < retryAt && !p.refreshWanted;
  if (backingOff && !p.checkinWanted) return { checkin: false, refresh: null };

  let refresh: RefreshReason | null = null;
  if (p.certUsable && !backingOff) {
    const spaced = p.lastRefreshAt === null || now - p.lastRefreshAt >= p.refreshSpacingMs;
    const held = p.credential !== null && p.credential.exp > now;
    const refreshAt = at(row.credential_refresh_at);
    const notBefore = at(row.credential_not_before);
    if (p.refreshWanted || !held || (refreshAt !== null && now >= refreshAt)) refresh = "scheduled";
    else if (notBefore !== null && p.credential!.iat < notBefore && spaced) refresh = "not_before";
    else if (
      row.probe_failures >= 2 &&
      spaced &&
      (p.lastProbeRefreshAt === null || now - p.lastProbeRefreshAt >= p.probeRefreshSpacingMs)
    ) {
      refresh = "probe";
    }
  }
  return { checkin: refresh !== null || checkinDue, refresh };
}

export const DEFAULT_REFRESH_SPACING_MS = MINUTE;
export const DEFAULT_PROBE_REFRESH_SPACING_MS = 10 * MINUTE;
