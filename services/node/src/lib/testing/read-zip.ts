/**
 * A minimal extractor that walks an archive as others do: end record, central directory, local
 * headers, payloads. Independent of lib/zip.ts, so the tests check the writer's layout against a
 * second reading of it. For tests only.
 */

export interface ParsedEntry {
  name: string;
  /** Host in the high byte, version in the low. */
  madeBy: number;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  external: number;
  localOffset: number;
  /** The payload as stored: compressed for a deflated entry. */
  data: Uint8Array;
}

function expectSignature(view: DataView, at: number, signature: number): void {
  const found = view.getUint32(at, true);
  if (found !== signature) throw new Error(`expected signature ${signature.toString(16)} at ${at}, found ${found.toString(16)}`);
}

export function readZip(bytes: Uint8Array): { count: number; entries: ParsedEntry[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expectSignature(view, eocd, 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    expectSignature(view, at, 0x02014b50);
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const external = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    expectSignature(view, localOffset, 0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      madeBy,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      external,
      localOffset,
      data: bytes.subarray(dataAt, dataAt + compressedSize),
    });
    at += 46 + nameLength;
  }
  return { count, entries };
}
