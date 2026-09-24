/**
 * The ZIP writer behind the .mcpb extension. Every entry is STORED (the
 * installer has failed on locally deflated archives), with no Zip64, no data
 * descriptors and one fixed timestamp, so two downloads differ only in their key.
 */
import { crc32 } from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, forward-slashed. */
  name: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;

/** 2.0: the floor for the fields written below. */
const VERSION = 20;
const METHOD_STORED = 0;

/** 1980-01-01 00:00:00, the earliest DOS timestamp. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** Past this the size and offset fields need Zip64, which is refused rather than truncated. */
const MAX_32 = 0xffffffff;

/**
 * Printable ASCII without backslashes, and no traversal segments: extractors
 * disagree on backslashes and on the encoding of anything else.
 */
function assertPlainName(name: string): void {
  if (!/^[\x20-\x5b\x5d-\x7e]+$/.test(name)) {
    throw new Error(`zip entry name is not plain ASCII: ${JSON.stringify(name)}`);
  }
  const segments = name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`zip entry name is not a plain relative path: ${JSON.stringify(name)}`);
  }
}

function writeAscii(out: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
}

/** Pack entries into a ZIP archive, each one stored uncompressed. */
export function zipStored(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  for (const entry of entries) assertPlainName(entry.name);

  const localBytes = entries.reduce((n, e) => n + LOCAL_HEADER_BYTES + e.name.length + e.data.length, 0);
  const centralBytes = entries.reduce((n, e) => n + CENTRAL_HEADER_BYTES + e.name.length, 0);
  const total = localBytes + centralBytes + EOCD_BYTES;
  if (total > MAX_32) throw new Error("zip archive is too large to write without Zip64");

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  const placed: { name: string; crc: number; size: number; offset: number }[] = [];
  let at = 0;
  for (const entry of entries) {
    const size = entry.data.length;
    const crc = crc32(entry.data);
    placed.push({ name: entry.name, crc, size, offset: at });

    view.setUint32(at, LOCAL_SIG, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, 0, true); // no flags: no encryption, no data descriptor
    view.setUint16(at + 8, METHOD_STORED, true);
    view.setUint16(at + 10, DOS_TIME, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, size, true);
    view.setUint32(at + 22, size, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    at += LOCAL_HEADER_BYTES;
    writeAscii(out, at, entry.name);
    at += entry.name.length;
    out.set(entry.data, at);
    at += size;
  }

  const centralAt = at;
  for (const entry of placed) {
    view.setUint32(at, CENTRAL_SIG, true);
    view.setUint16(at + 4, VERSION, true); // version made by
    view.setUint16(at + 6, VERSION, true); // version needed
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, METHOD_STORED, true);
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.size, true);
    view.setUint32(at + 24, entry.size, true);
    view.setUint16(at + 28, entry.name.length, true);
    view.setUint16(at + 30, 0, true); // no extra field
    view.setUint16(at + 32, 0, true); // no comment
    view.setUint16(at + 34, 0, true); // one disk
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, entry.offset, true);
    at += CENTRAL_HEADER_BYTES;
    writeAscii(out, at, entry.name);
    at += entry.name.length;
  }

  view.setUint32(at, EOCD_SIG, true);
  view.setUint16(at + 4, 0, true); // this disk
  view.setUint16(at + 6, 0, true); // disk holding the directory
  view.setUint16(at + 8, placed.length, true);
  view.setUint16(at + 10, placed.length, true);
  view.setUint32(at + 12, centralBytes, true);
  view.setUint32(at + 16, centralAt, true);
  view.setUint16(at + 20, 0, true); // no archive comment

  return out;
}
