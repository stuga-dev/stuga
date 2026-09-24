/**
 * Frame codec: `[1-byte opcode][payload]`, where the payload is Yjs bytes,
 * UTF-8 JSON, a u64 epoch, or the AWARENESS layout
 * `[u16 LE id_len][id_json][raw yjs awareness]`.
 */
import { Opcode, type OpcodeValue } from "./opcodes.js";
import type { AwarenessHeader } from "./doc-socket.js";

const td = new TextDecoder();
const te = new TextEncoder();

/** A decoded frame; `payload` excludes the opcode byte. */
export interface Frame {
  opcode: OpcodeValue;
  payload: Uint8Array;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 1) return null;
  const opcode = bytes[0] as OpcodeValue;
  return { opcode, payload: bytes.subarray(1) };
}

export function encodeBinary(opcode: OpcodeValue, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = opcode;
  out.set(payload, 1);
  return out;
}

export function encodeJson(opcode: OpcodeValue, value: unknown): Uint8Array {
  return encodeBinary(opcode, te.encode(JSON.stringify(value)));
}

export function encodeEmpty(opcode: OpcodeValue): Uint8Array {
  return new Uint8Array([opcode]);
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(td.decode(payload)) as T;
}

// ---- Document epoch layout -------------------------------------------------

export const DOCUMENT_EPOCH_BYTES = 8;

export function encodeEpoch(epoch: number): Uint8Array {
  const out = new Uint8Array(DOCUMENT_EPOCH_BYTES);
  new DataView(out.buffer).setBigUint64(0, BigInt(epoch), true);
  return out;
}

/**
 * Decode an epoch payload, or null. Fails closed on a wrong length or an unsafe
 * integer: callers compare epochs for equality to accept writes, so a truncated
 * value must never match.
 */
export function decodeEpoch(payload: Uint8Array): number | null {
  if (payload.byteLength !== DOCUMENT_EPOCH_BYTES) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const epoch = Number(view.getBigUint64(0, true));
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

// ---- Awareness layout ------------------------------------------------------

/** The Yjs section is required: departures are awareness updates with a null state. */
export function encodeAwareness(header: AwarenessHeader, yjsAwareness: Uint8Array): Uint8Array {
  const idJson = te.encode(JSON.stringify(header));
  const out = new Uint8Array(1 + 2 + idJson.byteLength + yjsAwareness.byteLength);
  out[0] = Opcode.AWARENESS;
  out[1] = idJson.byteLength & 0xff;
  out[2] = (idJson.byteLength >> 8) & 0xff;
  out.set(idJson, 3);
  out.set(yjsAwareness, 3 + idJson.byteLength);
  return out;
}

export interface DecodedAwareness {
  header: AwarenessHeader;
  yjsAwareness: Uint8Array;
}

/** Decode an AWARENESS payload, or null when malformed (including an empty Yjs section). */
export function decodeAwareness(payload: Uint8Array): DecodedAwareness | null {
  if (payload.byteLength < 2) return null;
  const idLen = payload[0]! | (payload[1]! << 8);
  if (payload.byteLength < 2 + idLen) return null;
  const idJson = payload.subarray(2, 2 + idLen);
  let header: AwarenessHeader;
  try {
    header = JSON.parse(td.decode(idJson)) as AwarenessHeader;
  } catch {
    return null;
  }
  const rest = payload.subarray(2 + idLen);
  if (rest.byteLength === 0) return null;
  return { header, yjsAwareness: rest };
}
