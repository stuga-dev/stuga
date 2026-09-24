/** The archive is parsed back independently, the way an extractor walks it, plus a golden length for the layout. */
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zipStored } from "./zip.js";

export interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  data: Uint8Array;
}

/** Minimal extractor: EOCD → central directory → local headers → payloads. */
export function readZip(bytes: Uint8Array): { count: number; entries: ParsedEntry[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      data: bytes.subarray(dataAt, dataAt + compressedSize),
    });
    at += 46 + nameLength;
  }
  return { count, entries };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("zipStored", () => {
  const manifest = utf8('{"a":1}\n');
  const server = utf8("console.log('hi')\n");
  const entries = [
    { name: "manifest.json", data: manifest },
    { name: "server/index.js", data: server },
  ];

  it("writes every entry stored, intact, and in the order given", () => {
    const { count, entries: read } = readZip(zipStored(entries));
    expect(count).toBe(2);
    expect(read.map((e) => e.name)).toEqual(["manifest.json", "server/index.js"]);
    for (const [i, entry] of read.entries()) {
      const source = entries[i]!;
      expect(entry.method).toBe(0);
      expect(entry.crc).toBe(crc32(source.data));
      expect(entry.compressedSize).toBe(source.data.length);
      expect(entry.uncompressedSize).toBe(source.data.length);
      expect([...entry.data]).toEqual([...source.data]);
    }
    expect(read[0]!.localOffset).toBe(0);
    expect(read[1]!.localOffset).toBeGreaterThan(0);
  });

  it("lays out exactly the fields it claims to", () => {
    // (30 + 13 + 8) + (30 + 15 + 18) + (46 + 13) + (46 + 15) + 22
    expect(zipStored(entries).length).toBe(256);
  });

  it("is byte-reproducible", () => {
    expect([...zipStored(entries)]).toEqual([...zipStored(entries)]);
  });

  it("writes an empty archive with no entries", () => {
    const { count } = readZip(zipStored([]));
    expect(count).toBe(0);
  });

  it.each([
    "server\\index.js",
    "sérveur.js",
    "/server/index.js",
    "server//index.js",
    "server/../index.js",
    "",
  ])("refuses %o as an entry name", (name) => {
    expect(() => zipStored([{ name, data: manifest }])).toThrow();
  });
});
