/**
 * A software authenticator for tests: real keys (node:crypto) and real WebAuthn encodings, so the
 * library itself checks what it makes. It answers creation and request options the way a browser
 * would hand them back, and every part a test may want wrong can be set: the origin, the RP ID, the
 * UP, UV, BE and BS flags, the counter, the user handle, the algorithm.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "../passkeys.js";

export type SoftAlgorithm = -8 | -7 | -257 | -35;

export interface SoftFlags {
  up?: boolean;
  uv?: boolean;
  be?: boolean;
  bs?: boolean;
}

interface SoftCredential {
  id: string;
  privateKey: KeyObject;
  alg: SoftAlgorithm;
  rpId: string;
  userHandle: string;
  counter: number;
  be: boolean;
  bs: boolean;
}

export interface CeremonyOverrides {
  /** The origin the browser reports; the test's own unless set. */
  origin?: string;
  /** The RP ID whose hash goes into the authenticator data; the options' unless set. */
  rpId?: string;
  flags?: SoftFlags;
  /** For a creation: the key's algorithm. */
  alg?: SoftAlgorithm;
  /** For a sign-in: which credential; the first the options allow, else the first made for the RP ID. */
  credentialId?: string;
  /** For a sign-in: the user handle sent back, base64url; the credential's unless set (null: none). */
  userHandle?: string | null;
  /** For a sign-in: the counter reported; one more than the last unless set. */
  counter?: number;
  /** The client data's type. */
  type?: string;
  /** Transports reported for a new credential. */
  transports?: string[];
}

const b64url = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

function keyPair(alg: SoftAlgorithm): { privateKey: KeyObject; publicKey: KeyObject } {
  if (alg === -8) return generateKeyPairSync("ed25519");
  if (alg === -7) return generateKeyPairSync("ec", { namedCurve: "P-256" });
  if (alg === -35) return generateKeyPairSync("ec", { namedCurve: "P-384" });
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function coseKey(alg: SoftAlgorithm, publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" });
  const bytes = (v: string | undefined) => new Uint8Array(Buffer.from(v ?? "", "base64url"));
  const map = new Map<number, number | Uint8Array>();
  if (alg === -8) {
    map.set(1, 1).set(3, -8).set(-1, 6).set(-2, bytes(jwk.x));
  } else if (alg === -7 || alg === -35) {
    map.set(1, 2).set(3, alg).set(-1, alg === -7 ? 1 : 2).set(-2, bytes(jwk.x)).set(-3, bytes(jwk.y));
  } else {
    map.set(1, 3).set(3, -257).set(-1, bytes(jwk.n)).set(-2, bytes(jwk.e));
  }
  return isoCBOR.encode(map);
}

function flagsByte(f: Required<SoftFlags>, attested: boolean): number {
  return (f.up ? 0x01 : 0) | (f.uv ? 0x04 : 0) | (f.be ? 0x08 : 0) | (f.bs ? 0x10 : 0) | (attested ? 0x40 : 0);
}

function counterBytes(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function signWith(alg: SoftAlgorithm, key: KeyObject, data: Buffer): Buffer {
  if (alg === -8) return sign(null, data, key);
  if (alg === -35) return sign("sha384", data, { key, dsaEncoding: "der" });
  if (alg === -7) return sign("sha256", data, { key, dsaEncoding: "der" });
  return sign("sha256", data, key);
}

export class SoftAuthenticator {
  readonly credentials: SoftCredential[] = [];

  constructor(
    private readonly defaults: { origin: string; flags?: SoftFlags; alg?: SoftAlgorithm; counts?: boolean } = { origin: "https://localhost" },
  ) {}

  private flags(over?: SoftFlags): Required<SoftFlags> {
    return { up: true, uv: true, be: true, bs: true, ...this.defaults.flags, ...over };
  }

  private clientData(type: string, challenge: string, origin: string): string {
    return b64url(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8"));
  }

  /** Answer creation options as navigator.credentials.create would. */
  create(options: PublicKeyCredentialCreationOptionsJSON, o: CeremonyOverrides = {}): RegistrationResponseJSON {
    const alg = o.alg ?? this.defaults.alg ?? -7;
    const rpId = o.rpId ?? options.rp.id ?? "localhost";
    const f = this.flags(o.flags);
    const { privateKey, publicKey } = keyPair(alg);
    const id = randomBytes(16);
    const cose = coseKey(alg, publicKey);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([flagsByte(f, true)]),
      counterBytes(0),
      Buffer.alloc(16),
      credIdLen,
      id,
      Buffer.from(cose),
    ]);
    const statement = new Map<string, Uint8Array>();
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, Uint8Array>>([
        ["fmt", "none"],
        ["attStmt", statement],
        ["authData", new Uint8Array(authData)],
      ]),
    );
    this.credentials.push({ id: b64url(id), privateKey, alg, rpId, userHandle: options.user.id, counter: 0, be: f.be, bs: f.bs });
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      response: {
        clientDataJSON: this.clientData(o.type ?? "webauthn.create", options.challenge, o.origin ?? this.defaults.origin),
        attestationObject: b64url(attestationObject),
        transports: (o.transports ?? ["internal", "hybrid"]) as RegistrationResponseJSON["response"]["transports"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answer request options as navigator.credentials.get would. */
  get(options: PublicKeyCredentialRequestOptionsJSON, o: CeremonyOverrides = {}): AuthenticationResponseJSON {
    const rpId = o.rpId ?? options.rpId ?? "localhost";
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const cred =
      this.credentials.find((c) => c.id === o.credentialId) ??
      this.credentials.find((c) => allowed.includes(c.id)) ??
      this.credentials.find((c) => c.rpId === (options.rpId ?? rpId));
    if (!cred) throw new Error("the soft authenticator holds no credential for this request");
    const f = this.flags({ be: cred.be, bs: cred.bs, ...o.flags });
    const counter = o.counter ?? (this.defaults.counts === false ? 0 : cred.counter + 1);
    cred.counter = counter;
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flagsByte(f, false)]), counterBytes(counter)]);
    const clientDataJSON = this.clientData(o.type ?? "webauthn.get", options.challenge, o.origin ?? this.defaults.origin);
    const signature = signWith(cred.alg, cred.privateKey, Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, "base64url"))]));
    const userHandle = o.userHandle === undefined ? cred.userHandle : o.userHandle;
    return {
      id: cred.id,
      rawId: cred.id,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
