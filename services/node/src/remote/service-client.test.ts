import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestCert } from "../testing/cert.js";
import { proofOfPossession } from "./credential.js";
import { okpThumbprint, type BindingKey } from "./keys.js";
import {
  acceptableServiceOrigin,
  createServiceClient,
  parseCheckin,
  parseCredential,
  parseEnroll,
  ServiceError,
} from "./service-client.js";
import { startFakeRemoteService, type FakeRemoteService } from "./testing/fake-service.js";

const CONTRACT = join(import.meta.dirname, "testing", "contract");
const sample = (name: string) => JSON.parse(readFileSync(join(CONTRACT, name), "utf8")) as Record<string, unknown>;
const API = "https://api.stuga.dev";

function bindingKey(): BindingKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = (privateKey.export({ format: "jwk" }) as { x: string }).x;
  return { privateKey, x, thumbprint: okpThumbprint(x) };
}

/** Keys and the type of each value, all the way down: what a sample fixes and its values do not. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape((value as Record<string, unknown>)[k])]));
  }
  return value === null ? "null" : typeof value;
}

/** A fetch that answers `status`/`body` and keeps what was sent. */
function answering(...answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const sent: Array<{ url: string; header: Record<string, unknown>; payload: Record<string, unknown>; contentType: string | null }> = [];
  const queue = [...answers];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const [h, p] = String(init.body).split(".");
    sent.push({
      url,
      header: JSON.parse(Buffer.from(h!, "base64url").toString()) as Record<string, unknown>,
      payload: JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>,
      contentType: new Headers(init.headers).get("content-type"),
    });
    const next = queue.shift() ?? answers.at(-1)!;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

describe("requests, against the contract's samples", () => {
  const cases: Array<[string, (c: ReturnType<typeof createServiceClient>, key: BindingKey) => Promise<unknown>, string]> = [
    ["enroll", (c, k) => c.enroll(API, k, "7K2M-9QXD-4TZB-H8PN"), "enroll.response.json"],
    ["rebind", (c, k) => c.rebind(API, k, "3NVQ-8RKW-6HXD-2PMB"), "rebind.response.json"],
    ["checkin", (c, k) => c.checkin(API, k, "k7f3q2"), "checkin.response.json"],
    ["acme-txt", (c, k) => c.acmeTxt(API, k, "k7f3q2", "LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0"), "acme-txt.response.json"],
    ["acme-txt-cleanup", (c, k) => c.acmeTxtCleanup(API, k, "k7f3q2"), "acme-txt-cleanup.response.json"],
    [
      "relay-credential",
      (c, k) => {
        const p = sample("relay-credential.request.json").payload as Record<string, string>;
        return c.relayCredential(API, k, "k7f3q2", { nonce: p.nonce!, certificate: p.certificate!, pop: p.pop! });
      },
      "relay-credential.response.json",
    ],
  ];

  it.each(cases)("%s: the same header and payload members, to the endpoint the payload names", async (name, call, response) => {
    const answer = sample(response) as { status: number; body: unknown };
    const { sent, fetchFn } = answering({ status: answer.status, body: answer.body });
    await call(createServiceClient({ fetch: fetchFn, now: () => 1_790_900_000_000 }), bindingKey());
    const expected = sample(`${name}.request.json`) as { protected: Record<string, unknown>; payload: Record<string, unknown> };
    const [req] = sent;
    expect(shape(req!.header)).toEqual(shape(expected.protected));
    expect(shape(req!.payload)).toEqual(shape(expected.payload));
    expect(req!.payload.aud).toBe(expected.payload.aud);
    expect(req!.url).toBe(expected.payload.aud);
    expect(req!.contentType).toBe("application/jose");
    expect(req!.payload).toMatchObject({ pv: 1, iat: 1_790_900_000, exp: 1_790_900_060 });
  });

  it("names the key by its thumbprint once bound, and embeds it only to enroll or rebind", async () => {
    const key = bindingKey();
    const { sent, fetchFn } = answering({ status: 200, body: sample("checkin.response.json").body });
    await createServiceClient({ fetch: fetchFn }).checkin(API, key, "k7f3q2");
    expect(sent[0]!.header).toEqual({ alg: "EdDSA", typ: "stuga-node+jwt", kid: key.thumbprint });
    const enroll = answering({ status: 201, body: sample("enroll.response.json").body });
    await createServiceClient({ fetch: enroll.fetchFn }).enroll(API, key, "7K2M-9QXD-4TZB-H8PN");
    expect(enroll.sent[0]!.header).toEqual({ alg: "EdDSA", typ: "stuga-node+jwt", jwk: { kty: "OKP", crv: "Ed25519", x: key.x } });
  });
});

describe("answers, against the contract's samples", () => {
  it("parses every response sample", () => {
    expect(parseEnroll(sample("enroll.response.json").body)).toEqual(sample("enroll.response.json").body);
    expect(parseEnroll(sample("rebind.response.json").body)).toEqual(sample("rebind.response.json").body);
    const checkin = sample("checkin.response.json").body as Record<string, unknown>;
    expect(parseCheckin(checkin)).toEqual(checkin);
    expect(parseCredential(sample("relay-credential.response.json").body)).toEqual(sample("relay-credential.response.json").body);
  });

  it("finds real values in the samples: the relay's certificate, the credential's signature", () => {
    const checkin = parseCheckin(sample("checkin.response.json").body);
    expect(checkin.relays[0]!.ca_pem).toContain("BEGIN CERTIFICATE");
    const jwt = sample("relay-credential.jwt.json") as { compact: string; signing_public_jwk: Record<string, string> };
    const [h, p, s] = jwt.compact.split(".");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwt.signing_public_jwk.x! }, format: "jwk" });
    expect(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s!, "base64url"))).toBe(true);
    expect((sample("relay-credential.response.json").body as { credential: string }).credential).toBe(jwt.compact);
  });

  it.each([
    ["error.stale-request.json", { status: 503, code: "stale_request" }],
    ["error.node-denied.json", { status: 403, code: "node_denied", detail: { reason: "abuse", serverTime: 1_790_900_000 } }],
    ["error.upgrade-required.json", { status: 426, code: "upgrade_required", detail: { minProtocol: 2, serverTime: 1_790_900_000 } }],
    ["error.issuance-budget.json", { status: 429, code: "issuance_budget", detail: { retryAfter: 86_400, serverTime: 1_790_900_000 } }],
  ])("turns %s into a ServiceError", async (name, expected) => {
    const s = sample(name) as { status: number; body: unknown; headers?: Record<string, string> };
    const { fetchFn } = answering({ status: s.status, body: s.body, ...(s.headers ? { headers: s.headers } : {}) });
    const err = await createServiceClient({ fetch: fetchFn }).checkin(API, bindingKey(), "k7f3q2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject(expected);
  });

  it("refuses an api it would have to reach over plain HTTP, but for loopback", () => {
    expect(acceptableServiceOrigin("https://api.stuga.dev")).toBe("https://api.stuga.dev");
    expect(acceptableServiceOrigin("http://api.stuga.dev")).toBeNull();
    expect(acceptableServiceOrigin("https://api.stuga.dev/v1")).toBeNull();
    expect(acceptableServiceOrigin("http://127.0.0.1:18080")).toBe("http://127.0.0.1:18080");
    const checkin = { ...(sample("checkin.response.json").body as Record<string, unknown>), api: "http://evil.stuga.test" };
    expect(parseCheckin(checkin).api).toBeNull();
  });

  it("refuses a relay name that is not one, since it becomes a file name", () => {
    const body = sample("checkin.response.json").body as { relays: Array<Record<string, unknown>> };
    const bad = { ...body, relays: [{ ...body.relays[0], name: "../relay" }] };
    expect(() => parseCheckin(bad)).toThrow(ServiceError);
  });
});

describe("the clock", () => {
  it("takes the service's time from a stale_request and sends once more; still stale is as good as no answer", async () => {
    const stale = sample("error.stale-request.json") as { status: number; body: { server_time: number } };
    const ok = sample("checkin.response.json") as { status: number; body: unknown };
    const local = 1_790_900_000 - 3600;
    const { sent, fetchFn } = answering(stale, ok);
    const client = createServiceClient({ fetch: fetchFn, now: () => local * 1000 });
    await client.checkin(API, bindingKey(), "k7f3q2");
    expect(sent.map((s) => s.payload.iat)).toEqual([local, stale.body.server_time]);
    expect(client.clockOffset()).toBe(3600);

    const twice = answering(stale, stale);
    const err = await createServiceClient({ fetch: twice.fetchFn, now: () => local * 1000 }).checkin(API, bindingKey(), "k7f3q2").catch((e: unknown) => e);
    expect(twice.sent).toHaveLength(2);
    expect(err).toMatchObject({ status: 503, code: "stale_request" });
  });

  it("takes a network error or a timeout as a 503", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(createServiceClient({ fetch: fetchFn }).checkin(API, bindingKey(), "k7f3q2")).rejects.toMatchObject({ status: 503, code: "network" });
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(createServiceClient({ fetch: hang, timeoutMs: 20 }).checkin(API, bindingKey(), "k7f3q2")).rejects.toMatchObject({ status: 503 });
  });

  it("takes an unknown error code by its status", async () => {
    const { fetchFn } = answering({ status: 418, body: { error: "teapot", message: "no" } });
    await expect(createServiceClient({ fetch: fetchFn }).checkin(API, bindingKey(), "k7f3q2")).rejects.toMatchObject({ status: 418, code: "teapot" });
    const bare = answering({ status: 502, body: "not json" });
    await expect(createServiceClient({ fetch: bare.fetchFn }).checkin(API, bindingKey(), "k7f3q2")).rejects.toMatchObject({ status: 502, code: "unavailable" });
  });
});

describe("the fake service, against the contract's samples", () => {
  let fake: FakeRemoteService | null = null;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it("answers every endpoint and every error in the samples' shapes", async () => {
    fake = await startFakeRemoteService({ acmeDirectory: "https://ca.stuga.test/dir", zone: "mystuga.com" });
    const answers = new Map<string, { status: number; body: unknown }>();
    const recording = (async (url: string, init: RequestInit) => {
      const res = await fetch(url, init);
      const body = (await res.clone().json()) as { error?: string };
      answers.set(body.error ? `error.${body.error}` : new URL(url).pathname, { status: res.status, body });
      return res;
    }) as unknown as typeof fetch;
    const client = createServiceClient({ fetch: recording });
    const bound = await client.enroll(fake.url, bindingKey(), fake.mintCode("enroll"));
    await client.rebind(fake.url, bindingKey(), fake.mintCode("rebind", bound.id));
    const key2 = bindingKey();
    const node = await client.enroll(fake.url, key2, fake.mintCode("enroll"));
    const checkin = await client.checkin(fake.url, key2, node.id);
    await client.acmeTxt(fake.url, key2, node.id, "LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0");
    await client.acmeTxtCleanup(fake.url, key2, node.id);
    const cert = makeTestCert({ dnsNames: [node.hostname] });
    await client.relayCredential(fake.url, key2, node.id, {
      nonce: checkin.nonce,
      certificate: cert.cert,
      pop: proofOfPossession(cert.privateKey, node.id, checkin.nonce),
    });
    fake.deny(node.id, { reason: "abuse" });
    await client.checkin(fake.url, key2, node.id).catch(() => {});
    fake.undeny(node.id);
    fake.setMinProtocol(2);
    await client.checkin(fake.url, key2, node.id).catch(() => {});
    fake.setMinProtocol(1);
    await createServiceClient({ fetch: recording, now: () => Date.now() - 3_600_000 })
      .checkin(fake.url, key2, node.id)
      .catch(() => {});
    fake.failNext("/v1/acme/txt", 429, { error: "issuance_budget", message: "Too many certificates were issued this week. Try again later.", retry_after: 86_400 });
    await client.acmeTxt(fake.url, key2, node.id, "LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0").catch(() => {});

    const pairs: Array<[string, string]> = [
      ["/v1/enroll", "enroll.response.json"],
      ["/v1/rebind", "rebind.response.json"],
      ["/v1/checkin", "checkin.response.json"],
      ["/v1/acme/txt", "acme-txt.response.json"],
      ["/v1/acme/txt/cleanup", "acme-txt-cleanup.response.json"],
      ["/v1/relay-credential", "relay-credential.response.json"],
      ["error.node_denied", "error.node-denied.json"],
      ["error.upgrade_required", "error.upgrade-required.json"],
      ["error.stale_request", "error.stale-request.json"],
      ["error.issuance_budget", "error.issuance-budget.json"],
    ];
    for (const [key, file] of pairs) {
      const expected = sample(file) as { status: number; body: unknown };
      const got = answers.get(key);
      expect(got, key).toBeDefined();
      expect(shape(got!.body), key).toEqual(shape(expected.body));
      expect(got!.status, key).toBe(expected.status);
    }
    // Every sample for the node is covered here or above.
    const covered = new Set([...pairs.map(([, f]) => f), "enroll.request.json", "rebind.request.json", "checkin.request.json"]);
    for (const f of readdirSync(CONTRACT).filter((n) => n.endsWith(".response.json") || n.startsWith("error."))) expect(covered, f).toContain(f);
  });
});
