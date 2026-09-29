import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateJwkThumbprint } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINDING_KEY_FILE,
  PENDING_BINDING_KEY_FILE,
  acmeAccountKeyFile,
  ecThumbprint,
  loadOrCreateAcmeAccountKey,
  okpThumbprint,
  pendingBindingKey,
  promotePendingKey,
  readBindingKey,
  readPendingBindingKey,
  spkiSha256,
  UnreadableKey,
} from "./keys.js";
import enrollRequest from "./testing/contract/enroll.request.json" with { type: "json" };
import checkinRequest from "./testing/contract/checkin.request.json" with { type: "json" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "stuga-keys-"));
  dirs.push(d);
  return d;
};

describe("RFC 7638 thumbprints", () => {
  it("matches RFC 8037 A.3 for an Ed25519 key", () => {
    expect(okpThumbprint("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("names the contract's key by the kid the contract's requests carry", () => {
    expect(okpThumbprint(enrollRequest.protected.jwk.x)).toBe(checkinRequest.protected.kid);
  });

  it("agrees with an independent implementation for EC keys", async () => {
    for (let i = 0; i < 5; i++) {
      const jwk = createPublicKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey).export({ format: "jwk" }) as {
        crv: string;
        x: string;
        y: string;
        kty: string;
      };
      expect(ecThumbprint(jwk)).toBe(await calculateJwkThumbprint({ kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y }, "sha256"));
    }
  });
});

describe("the binding key", () => {
  it("is on disk, 0600, before anything can send it, and a retry presents the same one", async () => {
    const dataDir = tempDir();
    const key = await pendingBindingKey(dataDir);
    const path = join(dataDir, "secrets", PENDING_BINDING_KEY_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "secrets")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ kty: "OKP", crv: "Ed25519", x: key.x });
    expect((await pendingBindingKey(dataDir)).thumbprint).toBe(key.thumbprint);
    expect(await readBindingKey(dataDir)).toBeNull();
  });

  it("is promoted once bound, and the key it replaces is kept under another name", async () => {
    const dataDir = tempDir();
    const first = await pendingBindingKey(dataDir);
    await promotePendingKey(dataDir, new Date(1_790_900_000_000));
    expect((await readBindingKey(dataDir))!.thumbprint).toBe(first.thumbprint);

    const second = await pendingBindingKey(dataDir);
    expect(second.thumbprint).not.toBe(first.thumbprint);
    await promotePendingKey(dataDir, new Date(1_790_900_060_000));
    expect((await readBindingKey(dataDir))!.thumbprint).toBe(second.thumbprint);
    const files = readdirSync(join(dataDir, "secrets")).sort();
    expect(files).toEqual([BINDING_KEY_FILE, "remote-binding.retired-1790900060.jwk"]);
    const retired = JSON.parse(readFileSync(join(dataDir, "secrets", "remote-binding.retired-1790900060.jwk"), "utf8")) as { x: string };
    expect(retired.x).toBe(first.x);
  });

  it("changes nothing when there is no pending key, as when another caller promoted it first", async () => {
    const dataDir = tempDir();
    const key = await pendingBindingKey(dataDir);
    const at = new Date(1_790_900_000_000);
    await promotePendingKey(dataDir, at);
    await promotePendingKey(dataDir, at);
    expect(readdirSync(join(dataDir, "secrets"))).toEqual([BINDING_KEY_FILE]);
    expect((await readBindingKey(dataDir))!.thumbprint).toBe(key.thumbprint);
  });

  it("says which file is damaged when one cannot be read as a key", async () => {
    const dataDir = tempDir();
    await pendingBindingKey(dataDir);
    await promotePendingKey(dataDir, new Date());
    const path = join(dataDir, "secrets", BINDING_KEY_FILE);
    writeFileSync(path, readFileSync(path, "utf8").slice(0, 20));
    const err = await readBindingKey(dataDir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableKey);
    expect(err).toMatchObject({ path, message: expect.stringContaining(`${path} can't be read:`) });
    writeFileSync(join(dataDir, "secrets", PENDING_BINDING_KEY_FILE), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "AAAA" }));
    await expect(readPendingBindingKey(dataDir)).rejects.toBeInstanceOf(UnreadableKey);
  });

  it("never overwrites a kept key retired in the same second", async () => {
    const dataDir = tempDir();
    const at = new Date(1_790_900_000_000);
    for (let i = 0; i < 3; i++) {
      await pendingBindingKey(dataDir);
      await promotePendingKey(dataDir, at);
    }
    expect(readdirSync(join(dataDir, "secrets")).filter((f) => f.startsWith("remote-binding.retired-")).sort()).toEqual([
      "remote-binding.retired-1790900000.jwk",
      "remote-binding.retired-1790900001.jwk",
    ]);
  });
});

describe("keys for certificates and the CA", () => {
  it("keeps one ACME account key per directory, named by its URL's hash", async () => {
    const dataDir = tempDir();
    const a = await loadOrCreateAcmeAccountKey(dataDir, "https://ca.stuga.test/directory");
    const again = await loadOrCreateAcmeAccountKey(dataDir, "https://ca.stuga.test/directory");
    const b = await loadOrCreateAcmeAccountKey(dataDir, "https://other-ca.stuga.test/directory");
    expect(spkiSha256(again)).toBe(spkiSha256(a));
    expect(spkiSha256(b)).not.toBe(spkiSha256(a));
    expect(acmeAccountKeyFile("https://ca.stuga.test/directory")).toMatch(/^remote-acme-[0-9a-f]{16}\.jwk$/);
    expect(statSync(join(dataDir, "secrets", acmeAccountKeyFile("https://ca.stuga.test/directory"))).mode & 0o777).toBe(0o600);
  });
});
