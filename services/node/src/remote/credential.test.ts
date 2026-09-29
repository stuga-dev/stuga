import { verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NodeRemoteAccessRow } from "@stuga/db";
import { makeTestCert } from "../testing/cert.js";
import {
  clampNextCheckin,
  clampRefreshAt,
  credentialClaims,
  DEFAULT_PROBE_REFRESH_SPACING_MS,
  DEFAULT_REFRESH_SPACING_MS,
  planServiceTick,
  proofOfPossession,
  type ServicePlanInput,
} from "./credential.js";
import relayCredential from "./testing/contract/relay-credential.request.json" with { type: "json" };
import credentialJwt from "./testing/contract/relay-credential.jwt.json" with { type: "json" };

const T = Date.parse("2026-10-02T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function input(over: Omit<Partial<ServicePlanInput>, "row"> & { row?: Partial<NodeRemoteAccessRow> } = {}): ServicePlanInput {
  const { row, ...rest } = over;
  return {
    now: T,
    row: {
      last_error: null,
      checkin_next_at: new Date(T + 6 * HOUR),
      credential_retry_at: null,
      credential_refresh_at: new Date(T + 6 * HOUR),
      credential_not_before: null,
      probe_failures: 0,
      ...row,
    } as NodeRemoteAccessRow,
    credential: { iat: T - HOUR, exp: T + 23 * HOUR },
    certUsable: true,
    checkinWanted: false,
    refreshWanted: false,
    lastRefreshAt: T - HOUR,
    lastProbeRefreshAt: null,
    refreshSpacingMs: DEFAULT_REFRESH_SPACING_MS,
    probeRefreshSpacingMs: DEFAULT_PROBE_REFRESH_SPACING_MS,
    ...rest,
  };
}

describe("when the service loop checks in", () => {
  it("does nothing between check-ins with a good credential", () => {
    expect(planServiceTick(input())).toEqual({ checkin: false, refresh: null });
  });

  it("checks in at start and when turned on, however recent the last one", () => {
    expect(planServiceTick(input({ checkinWanted: true }))).toEqual({ checkin: true, refresh: null });
  });

  it("checks in when next_checkin_at comes, or when there has never been one", () => {
    expect(planServiceTick(input({ now: T + 6 * HOUR, row: { credential_refresh_at: new Date(T + 7 * HOUR) } }))).toEqual({
      checkin: true,
      refresh: null,
    });
    expect(planServiceTick(input({ row: { checkin_next_at: null } }))).toEqual({ checkin: true, refresh: null });
  });

  it("checks in before every refresh, for its nonce", () => {
    expect(planServiceTick(input({ credential: null }))).toEqual({ checkin: true, refresh: "scheduled" });
  });

  it("holds the service's next_checkin_at between five minutes and a day away", () => {
    const now = 1_790_900_000;
    expect(clampNextCheckin(now, now + 10)).toBe(now + 300);
    expect(clampNextCheckin(now, now + 21_600)).toBe(now + 21_600);
    expect(clampNextCheckin(now, now + 7 * 86_400)).toBe(now + 86_400);
  });

  it("only checks in, hourly, while denied or retired, whatever the credential", () => {
    for (const code of ["denied", "retired"]) {
      const denied = { last_error: { code, message: "m", at: "" }, checkin_next_at: new Date(T + HOUR) };
      expect(planServiceTick(input({ credential: null, row: denied }))).toEqual({ checkin: false, refresh: null });
      expect(planServiceTick(input({ credential: null, now: T + HOUR, row: denied }))).toEqual({ checkin: true, refresh: null });
      expect(planServiceTick(input({ credential: null, checkinWanted: true, row: denied }))).toEqual({ checkin: true, refresh: null });
    }
  });

  it("waits out a backoff: a check-in someone asks for goes, a new credential does not", () => {
    const backingOff = { credential_retry_at: new Date(T + 5 * MIN) };
    expect(planServiceTick(input({ credential: null, row: backingOff }))).toEqual({ checkin: false, refresh: null });
    // At start, after 422 cert_invalid, say: the check-in, and the credential an hour on.
    expect(planServiceTick(input({ credential: null, checkinWanted: true, row: backingOff }))).toEqual({ checkin: true, refresh: null });
    expect(planServiceTick(input({ credential: null, now: T + 5 * MIN, row: backingOff }))).toEqual({ checkin: true, refresh: "scheduled" });
    // A denied node let back in gets one at once.
    expect(planServiceTick(input({ credential: null, refreshWanted: true, row: backingOff }))).toEqual({ checkin: true, refresh: "scheduled" });
  });
});

describe("when the credential is refreshed", () => {
  it("on schedule: none held, one expired, or refresh_at reached", () => {
    expect(planServiceTick(input({ credential: null })).refresh).toBe("scheduled");
    expect(planServiceTick(input({ credential: { iat: T - 25 * HOUR, exp: T - HOUR } })).refresh).toBe("scheduled");
    expect(planServiceTick(input({ row: { credential_refresh_at: new Date(T) } })).refresh).toBe("scheduled");
    // Right after another refresh, too: the schedule is not rate-limited.
    expect(planServiceTick(input({ credential: null, lastRefreshAt: T - 1000 })).refresh).toBe("scheduled");
  });

  it("not without a certificate to prove", () => {
    expect(planServiceTick(input({ credential: null, certUsable: false }))).toEqual({ checkin: false, refresh: null });
  });

  it("when a check-in names a time the credential predates, a minute after the last refresh at the soonest", () => {
    const row = { credential_not_before: new Date(T - 30 * MIN) };
    expect(planServiceTick(input({ row })).refresh).toBe("not_before");
    expect(planServiceTick(input({ row, lastRefreshAt: T - 30_000 })).refresh).toBeNull();
    expect(planServiceTick(input({ row: { credential_not_before: new Date(T - 2 * HOUR) } })).refresh).toBeNull();
  });

  it("after two failed self-checks in a row, at most once in ten minutes", () => {
    expect(planServiceTick(input({ row: { probe_failures: 1 } })).refresh).toBeNull();
    expect(planServiceTick(input({ row: { probe_failures: 2 } })).refresh).toBe("probe");
    expect(planServiceTick(input({ row: { probe_failures: 3 }, lastProbeRefreshAt: T - 9 * MIN })).refresh).toBeNull();
    expect(planServiceTick(input({ row: { probe_failures: 3 }, lastProbeRefreshAt: T - 10 * MIN })).refresh).toBe("probe");
    expect(planServiceTick(input({ row: { probe_failures: 2 }, lastRefreshAt: T - 30_000 })).refresh).toBeNull();
  });

  it("straight away when a denied node is let back in", () => {
    expect(planServiceTick(input({ refreshWanted: true, lastRefreshAt: T - 1000 })).refresh).toBe("scheduled");
  });

  it("uses the service's refresh_at, held between a tenth and half of the credential's life", () => {
    const iat = 1_790_900_030;
    expect(clampRefreshAt(iat, iat + 86_400, iat + 21_600)).toBe(iat + 21_600);
    expect(clampRefreshAt(iat, iat + 86_400, iat + 60)).toBe(iat + 8_640);
    expect(clampRefreshAt(iat, iat + 86_400, iat + 86_000)).toBe(iat + 43_200);
    expect(clampRefreshAt(iat, iat + 600, iat + 150)).toBe(iat + 150);
  });
});

describe("the proof of possession", () => {
  it("signs stuga-relay-pop:v1:<id>:<nonce> with the certificate's key, r||s in base64url", () => {
    const cert = makeTestCert({ dnsNames: ["k7f3q2.mystuga.com"] });
    const pop = proofOfPossession(cert.privateKey, "k7f3q2", "Zb3pq9Xk2mT7vR4sN8wQ1cH6yL0dF5gJ3aE9uB2oK7i");
    expect(pop).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const message = Buffer.from("stuga-relay-pop:v1:k7f3q2:Zb3pq9Xk2mT7vR4sN8wQ1cH6yL0dF5gJ3aE9uB2oK7i");
    expect(verify("sha256", message, { key: cert.privateKey, dsaEncoding: "ieee-p1363" }, Buffer.from(pop, "base64url"))).toBe(true);
  });

  it("is what the contract's sample proves with its certificate", async () => {
    const { X509Certificate } = await import("node:crypto");
    const { payload } = relayCredential;
    const key = new X509Certificate(payload.certificate).publicKey;
    const message = Buffer.from(`stuga-relay-pop:v1:${payload.iss}:${payload.nonce}`);
    expect(verify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(payload.pop, "base64url"))).toBe(true);
  });
});

describe("the credential's claims", () => {
  it("are read from the JWT without checking it", () => {
    expect(credentialClaims(credentialJwt.compact)).toEqual({ iat: credentialJwt.claims.iat, exp: credentialJwt.claims.exp });
    expect(credentialClaims("not-a-jwt")).toBeNull();
  });
});
