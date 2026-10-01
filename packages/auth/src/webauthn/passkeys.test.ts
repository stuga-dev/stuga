import { describe, expect, it } from "vitest";
import { SoftAuthenticator, type SoftAlgorithm } from "./testing/soft-authenticator.js";
import {
  PasskeyInvalid,
  challengeOf,
  challengeText,
  creationOptions,
  requestOptions,
  userHandleOf,
  verifyAssertion,
  verifyCreation,
  type PasskeySite,
  type StoredPasskey,
} from "./passkeys.js";

const SITE: PasskeySite = { rpId: "k7f3q2.mystuga.com", origin: "https://k7f3q2.mystuga.com", rpName: "Office" };
const USER = { alias: "u_bo", username: "bo", displayName: "Bo Larsson" };

async function register(auth: SoftAuthenticator, o: Parameters<SoftAuthenticator["create"]>[1] = {}) {
  const options = await creationOptions({ site: SITE, user: USER, challenge: "ticket-add", exclude: [] });
  const response = auth.create(options, o);
  return { options, response, challenge: challengeOf(response)! };
}

async function stored(auth: SoftAuthenticator, o: Parameters<SoftAuthenticator["create"]>[1] = {}): Promise<StoredPasskey> {
  const { response, challenge } = await register(auth, o);
  const made = await verifyCreation({ site: SITE, response, challenge });
  return {
    credentialId: made.credentialId,
    alias: USER.alias,
    publicKey: made.publicKey,
    signCount: made.signCount,
    transports: made.transports,
    backupEligible: made.backupEligible,
  };
}

async function signIn(auth: SoftAuthenticator, o: Parameters<SoftAuthenticator["get"]>[1] = {}) {
  const options = await requestOptions({ site: SITE, challenge: "ticket-sign-in" });
  const response = auth.get(options, o);
  return { options, response, challenge: challengeOf(response)! };
}

describe("passkey options", () => {
  it("asks for a discoverable passkey that verifies the person, without attestation, at this host only", async () => {
    const o = await creationOptions({ site: SITE, user: USER, challenge: "abc", exclude: [{ id: "AAAA", transports: ["internal"] }] });
    expect(o.rp).toEqual({ id: SITE.rpId, name: "Office" });
    expect(o.user.id).toBe(userHandleOf("u_bo"));
    expect(o.user.name).toBe("bo");
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    expect(o.excludeCredentials).toEqual([{ id: "AAAA", type: "public-key", transports: ["internal"] }]);
    expect(o.timeout).toBe(300_000);
    expect(o.hints ?? []).toEqual([]);
  });

  it("signs in with any passkey for the host, and confirms with the person's own", async () => {
    const any = await requestOptions({ site: SITE, challenge: "abc" });
    expect(any.rpId).toBe(SITE.rpId);
    expect(any.userVerification).toBe("required");
    expect(any.allowCredentials ?? []).toEqual([]);
    const own = await requestOptions({ site: SITE, challenge: "abc", allow: [{ id: "BBBB", transports: [] }] });
    expect(own.allowCredentials).toEqual([{ id: "BBBB", type: "public-key", transports: [] }]);
  });

  it("carries the challenge's text, which the response gives back", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const { challenge } = await register(auth);
    expect(challengeText(challenge)).toBe("ticket-add");
    expect(challengeOf({ response: { clientDataJSON: "not json" } })).toBeNull();
    expect(challengeOf(null)).toBeNull();
  });
});

describe("verifyCreation", () => {
  it.each<[SoftAlgorithm, number]>([
    [-8, -8],
    [-7, -7],
    [-257, -257],
  ])("keeps a passkey made with algorithm %d", async (alg, expected) => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const { response, challenge } = await register(auth, { alg });
    const made = await verifyCreation({ site: SITE, response, challenge });
    expect(made.algorithm).toBe(expected);
    expect(made.credentialId).toBe(response.id);
    expect(made.backupEligible).toBe(true);
    expect(made.synced).toBe(true);
    expect(made.transports).toEqual(["internal", "hybrid"]);
  });

  it("records a device-bound passkey as such", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin, flags: { be: false, bs: false } });
    const { response, challenge } = await register(auth, { transports: ["usb", "nfc"] });
    const made = await verifyCreation({ site: SITE, response, challenge });
    expect(made).toMatchObject({ backupEligible: false, synced: false, transports: ["usb", "nfc"] });
  });

  const refusals: Array<[string, Parameters<SoftAuthenticator["create"]>[1]]> = [
    ["the node's own network", { origin: "http://office.local:8787" }],
    ["the origin with a port", { origin: "https://k7f3q2.mystuga.com:8443" }],
    ["another node's host", { origin: "https://zz9zz9.mystuga.com" }],
    ["an RP ID of the parent domain", { rpId: "mystuga.com" }],
    ["an RP ID of another host", { rpId: "zz9zz9.mystuga.com" }],
    ["no user verification", { flags: { uv: false } }],
    ["no user presence", { flags: { up: false } }],
    ["an algorithm off the list", { alg: -35 }],
    ["backed up but not eligible", { flags: { be: false, bs: true } }],
    ["a sign-in's client data", { type: "webauthn.get" }],
  ];
  it.each(refusals)("refuses %s", async (_label, o) => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const { response, challenge } = await register(auth, o);
    await expect(verifyCreation({ site: SITE, response, challenge })).rejects.toBeInstanceOf(PasskeyInvalid);
  });

  it("refuses another challenge, and a malformed response", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const { response } = await register(auth);
    await expect(verifyCreation({ site: SITE, response, challenge: "b3RoZXI" })).rejects.toBeInstanceOf(PasskeyInvalid);
    await expect(verifyCreation({ site: SITE, response: { id: 5 }, challenge: "x" })).rejects.toBeInstanceOf(PasskeyInvalid);
    await expect(
      verifyCreation({ site: SITE, response: { ...response, id: "a".repeat(1401), rawId: "a".repeat(1401) }, challenge: "x" }),
    ).rejects.toBeInstanceOf(PasskeyInvalid);
  });
});

describe("verifyAssertion", () => {
  it.each<SoftAlgorithm>([-8, -7, -257])("signs in with a passkey of algorithm %d", async (alg) => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const key = await stored(auth, { alg });
    const { response, challenge } = await signIn(auth);
    const done = await verifyAssertion({ site: SITE, response, challenge, stored: key });
    expect(done).toEqual({ signCount: 1, synced: true });
  });

  it("takes a synced passkey's counter of zero every time", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin, counts: false });
    const key = await stored(auth);
    for (let i = 0; i < 2; i++) {
      const { response, challenge } = await signIn(auth);
      expect(await verifyAssertion({ site: SITE, response, challenge, stored: key })).toEqual({ signCount: 0, synced: true });
    }
  });

  it("reports a passkey that stopped being synced", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const key = await stored(auth);
    const { response, challenge } = await signIn(auth, { flags: { bs: false } });
    expect((await verifyAssertion({ site: SITE, response, challenge, stored: key })).synced).toBe(false);
  });

  const refusals: Array<[string, Parameters<SoftAuthenticator["get"]>[1], Partial<StoredPasskey>?]> = [
    ["the node's own network", { origin: "http://office.local:8787" }],
    ["the origin with a port", { origin: "https://k7f3q2.mystuga.com:8443" }],
    ["another node's host", { origin: "https://zz9zz9.mystuga.com" }],
    ["an RP ID hash of the parent domain", { rpId: "mystuga.com" }],
    ["an RP ID hash of another host", { rpId: "zz9zz9.mystuga.com" }],
    ["no user verification", { flags: { uv: false } }],
    ["no user presence", { flags: { up: false } }],
    ["a counter that went back", { counter: 3 }, { signCount: 5 }],
    ["a counter that stood still", { counter: 5 }, { signCount: 5 }],
    ["a user handle of another account", { userHandle: userHandleOf("u_cy") }],
    ["no user handle", { userHandle: null }],
    ["a passkey of another account", {}, { alias: "u_cy" }],
    ["a BE flag unlike the one registered", { flags: { be: false, bs: false } }],
    ["BS without BE", {}, { backupEligible: false }],
    ["a creation's client data", { type: "webauthn.create" }],
  ];
  it.each(refusals)("refuses %s", async (_label, o, over) => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const key = await stored(auth);
    const { response, challenge } = await signIn(auth, o);
    await expect(verifyAssertion({ site: SITE, response, challenge, stored: { ...key, ...over } })).rejects.toBeInstanceOf(PasskeyInvalid);
  });

  it("refuses BS without BE however the passkey was stored", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin, flags: { be: false, bs: false } });
    const key = await stored(auth);
    const { response, challenge } = await signIn(auth, { flags: { bs: true } });
    await expect(verifyAssertion({ site: SITE, response, challenge, stored: key })).rejects.toBeInstanceOf(PasskeyInvalid);
  });

  it("refuses a signature by another key, and another challenge", async () => {
    const auth = new SoftAuthenticator({ origin: SITE.origin });
    const key = await stored(auth);
    const other = new SoftAuthenticator({ origin: SITE.origin });
    const otherKey = await stored(other);
    const { response, challenge } = await signIn(other);
    await expect(
      verifyAssertion({ site: SITE, response: { ...response, id: key.credentialId, rawId: key.credentialId }, challenge, stored: key }),
    ).rejects.toBeInstanceOf(PasskeyInvalid);
    await expect(verifyAssertion({ site: SITE, response, challenge: "b3RoZXI", stored: otherKey })).rejects.toBeInstanceOf(PasskeyInvalid);
    // A response for one credential checked against another.
    await expect(verifyAssertion({ site: SITE, response, challenge, stored: key })).rejects.toBeInstanceOf(PasskeyInvalid);
  });
});
