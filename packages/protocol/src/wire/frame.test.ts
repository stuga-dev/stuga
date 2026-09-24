import { describe, it, expect } from "vitest";
import { Opcode } from "./opcodes.js";
import {
  decodeFrame,
  encodeBinary,
  encodeJson,
  encodeEmpty,
  decodeJson,
  encodeAwareness,
  decodeAwareness,
  encodeEpoch,
  decodeEpoch,
  DOCUMENT_EPOCH_BYTES,
} from "./frame.js";

describe("frame codec", () => {
  it("round-trips a binary frame and strips the opcode byte", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = decodeFrame(encodeBinary(Opcode.UPDATE, payload));
    expect(frame).not.toBeNull();
    expect(frame!.opcode).toBe(Opcode.UPDATE);
    expect([...frame!.payload]).toEqual([1, 2, 3, 250]);
  });

  it("round-trips a JSON frame", () => {
    const value = { a: 1, b: "x", c: [true, null] };
    const frame = decodeFrame(encodeJson(Opcode.AI_REQUEST, value))!;
    expect(frame.opcode).toBe(Opcode.AI_REQUEST);
    expect(decodeJson(frame.payload)).toEqual(value);
  });

  it("encodes an empty frame", () => {
    expect([...encodeEmpty(Opcode.SYNC_DONE)]).toEqual([Opcode.SYNC_DONE]);
  });

  it("returns null for an empty buffer", () => {
    expect(decodeFrame(new Uint8Array([]))).toBeNull();
  });

  it("round-trips awareness header + yjs payload", () => {
    const yjs = new Uint8Array([9, 8, 7]);
    const frame = decodeFrame(encodeAwareness({ alias: "alice", agent: "Kiro" }, yjs))!;
    expect(frame.opcode).toBe(Opcode.AWARENESS);
    const decoded = decodeAwareness(frame.payload)!;
    expect(decoded.header.alias).toBe("alice");
    expect(decoded.header.agent).toBe("Kiro");
    expect([...decoded.yjsAwareness!]).toEqual([9, 8, 7]);
  });

  it("rejects an awareness frame carrying no yjs payload", () => {
    // The payload is where the meaning lives, so a header-only frame asserts
    // nothing. Failing here is what stops the document actor broadcasting a
    // no-op to every collaborator on the document.
    const header = new TextEncoder().encode(JSON.stringify({ alias: "bob" }));
    const payload = new Uint8Array(2 + header.byteLength);
    payload[0] = header.byteLength & 0xff;
    payload[1] = (header.byteLength >> 8) & 0xff;
    payload.set(header, 2);
    expect(decodeAwareness(payload)).toBeNull();
  });

  it("rejects an awareness frame whose declared header length overruns the buffer", () => {
    const payload = new Uint8Array([0xff, 0xff, 1, 2, 3]);
    expect(decodeAwareness(payload)).toBeNull();
  });

  it("rejects an awareness frame with unparseable header json", () => {
    const junk = new TextEncoder().encode("{not json");
    const payload = new Uint8Array(2 + junk.byteLength + 3);
    payload[0] = junk.byteLength & 0xff;
    payload[1] = (junk.byteLength >> 8) & 0xff;
    payload.set(junk, 2);
    payload.set([9, 8, 7], 2 + junk.byteLength);
    expect(decodeAwareness(payload)).toBeNull();
  });
});

describe("document epoch codec", () => {
  it("round-trips through a frame", () => {
    const frame = decodeFrame(encodeBinary(Opcode.DOCUMENT_EPOCH, encodeEpoch(7)))!;
    expect(frame.opcode).toBe(Opcode.DOCUMENT_EPOCH);
    expect(decodeEpoch(frame.payload)).toBe(7);
  });

  it("round-trips zero (a doc that was never rolled back)", () => {
    expect(decodeEpoch(encodeEpoch(0))).toBe(0);
  });

  it("round-trips a value near the safe-integer ceiling", () => {
    expect(decodeEpoch(encodeEpoch(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is fixed-width little-endian", () => {
    const bytes = encodeEpoch(1);
    expect(bytes.byteLength).toBe(DOCUMENT_EPOCH_BYTES);
    expect([...bytes]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  // Callers compare epochs for EQUALITY to decide whether to accept writes, so a
  // malformed payload must NOT decode to a number that could match — it has to
  // fail closed.
  it("rejects a wrong-length payload rather than truncating", () => {
    expect(decodeEpoch(new Uint8Array([1, 0, 0, 0]))).toBeNull();
    expect(decodeEpoch(new Uint8Array(9))).toBeNull();
    expect(decodeEpoch(new Uint8Array([]))).toBeNull();
  });

  it("rejects a value beyond the safe-integer range", () => {
    // 2^63 — round-trips through BigInt but is not representable as an exact JS
    // number, so it must not be treated as a usable epoch.
    const bytes = new Uint8Array(DOCUMENT_EPOCH_BYTES);
    new DataView(bytes.buffer).setBigUint64(0, 1n << 63n, true);
    expect(decodeEpoch(bytes)).toBeNull();
  });

  it("decodes correctly from a non-zero byteOffset (a subarray'd frame payload)", () => {
    // decodeFrame hands back `bytes.subarray(1)`, which shares its ArrayBuffer
    // with the full frame. A DataView built without honoring byteOffset would
    // read the opcode byte as part of the epoch.
    const framed = encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(258));
    const payload = decodeFrame(framed)!.payload;
    expect(payload.byteOffset).toBeGreaterThan(0);
    expect(decodeEpoch(payload)).toBe(258);
  });
});
