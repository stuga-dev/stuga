/**
 * ZIP without a dependency: stored and deflated entries, UTF-8 names, no Zip64, no encryption.
 * The writer is deterministic (one fixed timestamp, no extra fields). The reader takes untrusted
 * archives: every name, size and offset is checked when it opens one, and a file is unpacked only
 * when it is read, never past the size its headers state.
 */
import { promisify } from "node:util";
import { crc32, deflateRaw, deflateRawSync, inflateRaw } from "node:zlib";

export type ZipMethod = "stored" | "deflate";

export interface ZipFile {
  /** Path inside the archive, `/`-separated. */
  name: string;
  data: Uint8Array;
}

/** Receives the archive in order; the writer waits for a returned promise before its next write. */
export type ZipSink = (chunk: Uint8Array) => void | Promise<void>;

export class ZipError extends Error {
  constructor(
    readonly reason: string,
    /** The entry at fault, as named in the archive. */
    readonly entry: string | null = null,
  ) {
    super(entry === null ? reason : `${quote(entry)} ${reason}`);
    this.name = "ZipError";
  }
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DESCRIPTOR_SIG = 0x08074b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;

/** 2.0: the floor for deflate and for the fields written below. */
const VERSION = 20;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DESCRIPTOR = 1 << 3;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_UTF8 = 1 << 11;
const FLAG_MASKED_HEADERS = 1 << 13;
const FLAGS_ENCRYPTED = FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS;

/** Hosts whose external attributes hold a Unix file mode in their high half. */
const HOST_UNIX = 3;
const HOST_MACOS = 19;
const MODE_TYPE = 0o170000;
const MODE_SYMLINK = 0o120000;
/** A plain file, rw-r--r--. */
const MODE_FILE = 0o100644;

/** 1980-01-01 00:00:00, the earliest DOS timestamp. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** Past these the count, size and offset fields need Zip64, which is refused rather than truncated. */
const MAX_16 = 0xffff;
const MAX_32 = 0xffffffff;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function quote(name: string): string {
  return JSON.stringify(name.length > 200 ? `${name.slice(0, 200)}…` : name);
}

/**
 * Why `name` is not a relative `/`-separated path that every extractor puts in the same place,
 * or null. A trailing `/` marks a folder.
 */
function nameProblem(name: string): string | null {
  if (name === "" || name === "/") return "is not a name";
  if (name.includes("\0")) return "holds a NUL character";
  if (name.includes("\\")) return "holds a backslash, which extractors read differently";
  if (/\p{Cs}/u.test(name)) return "is not valid Unicode";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "is an absolute path";
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "is not a plain relative path";
  return null;
}

// ---- Writing --------------------------------------------------------------------------------

interface Placed {
  name: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Caps a writer holds its archive to, within the format's own; each is unlimited when unset. */
export interface ZipWriteLimits {
  /** Files. */
  maxEntries?: number;
  /** Every file, unpacked, together. */
  maxTotalBytes?: number;
  /** The archive, its central directory included. */
  maxBytes?: number;
}

/** An entry the archive has room for, not yet placed. */
interface Admitted {
  name: string;
  /** The name in NFC form, as the reader keys it: NFC-equal names are duplicates here too. */
  key: string;
  bytes: Uint8Array;
}

/** The archive's layout so far: where the next entry goes, and the central directory it will need. */
class ZipLayout {
  private readonly names = new Set<string>();
  private readonly placed: Placed[] = [];
  private offset = 0;
  private centralBytes = 0;
  private unpacked = 0;
  private finished = false;

  constructor(private readonly limits: ZipWriteLimits = {}) {}

  /** Refuses an entry the archive cannot take, before anything packs its `size` bytes. */
  admit(name: string, size: number): Admitted {
    if (this.finished) throw new ZipError("the archive is already finished");
    const problem = nameProblem(name) ?? (name.endsWith("/") ? "names a folder; only files are written" : null);
    if (problem) throw new ZipError(problem, name);
    const key = name.normalize("NFC");
    if (this.names.has(key)) throw new ZipError("is in the archive twice", name);
    if (this.placed.length === MAX_16) throw new ZipError(`would be entry ${MAX_16 + 1}; more need Zip64, which is not written`, name);
    const { maxEntries = Infinity, maxTotalBytes = Infinity } = this.limits;
    if (this.placed.length >= maxEntries) throw new ZipError(`would be file ${this.placed.length + 1}; the archive takes at most ${maxEntries}`, name);
    if (this.unpacked + size > maxTotalBytes) throw new ZipError(`would take the files past ${maxTotalBytes} bytes unpacked`, name);
    const bytes = encoder.encode(name);
    if (bytes.length > MAX_16) throw new ZipError(`is longer than ${MAX_16} bytes`, name);
    // A file deflate does not shrink is stored, so `size` bounds the payload.
    if (this.endWith(bytes.length, size) > MAX_32) throw new ZipError("would take the archive past 4 GiB, which needs Zip64", name);
    return { name, key, bytes };
  }

  /** Where the archive would end with one more entry of a `nameBytes` name and a `payload`-byte payload. */
  private endWith(nameBytes: number, payload: number): number {
    return this.offset + LOCAL_HEADER_BYTES + nameBytes + payload + this.centralBytes + CENTRAL_HEADER_BYTES + nameBytes + EOCD_BYTES;
  }

  /** Places an admitted entry, stored unless `deflated` is smaller: its local header and payload. */
  place(entry: Admitted, data: Uint8Array, deflated: Uint8Array | null): Uint8Array[] {
    const payload = deflated && deflated.length < data.length ? deflated : data;
    const { maxBytes = Infinity } = this.limits;
    if (this.endWith(entry.bytes.length, payload.length) > maxBytes) throw new ZipError(`would take the archive past ${maxBytes} bytes`, entry.name);
    const placed: Placed = {
      name: entry.bytes,
      flags: entry.bytes.some((b) => b >= 0x80) ? FLAG_UTF8 : 0,
      method: payload === data ? METHOD_STORED : METHOD_DEFLATE,
      crc: crc32(data),
      compressedSize: payload.length,
      size: data.length,
      offset: this.offset,
    };
    this.names.add(entry.key);
    this.placed.push(placed);
    this.unpacked += data.length;
    this.offset += LOCAL_HEADER_BYTES + entry.bytes.length + payload.length;
    this.centralBytes += CENTRAL_HEADER_BYTES + entry.bytes.length;
    return [localHeader(placed), payload];
  }

  /** The central directory and the end record. */
  end(): Uint8Array<ArrayBuffer> {
    if (this.finished) throw new ZipError("the archive is already finished");
    this.finished = true;
    const out = new Uint8Array(this.centralBytes + EOCD_BYTES);
    const view = new DataView(out.buffer);
    let at = 0;
    for (const entry of this.placed) {
      // Info-ZIP's unzip reads a DOS host's names in a DOS code page even when they are flagged
      // UTF-8, so such a name is written as from a Unix host; ASCII names read the same either way.
      const unix = (entry.flags & FLAG_UTF8) !== 0;
      view.setUint32(at, CENTRAL_SIG, true);
      view.setUint16(at + 4, unix ? (HOST_UNIX << 8) | VERSION : VERSION, true); // version made by
      view.setUint16(at + 6, VERSION, true); // version needed
      view.setUint16(at + 8, entry.flags, true);
      view.setUint16(at + 10, entry.method, true);
      view.setUint16(at + 12, DOS_TIME, true);
      view.setUint16(at + 14, DOS_DATE, true);
      view.setUint32(at + 16, entry.crc, true);
      view.setUint32(at + 20, entry.compressedSize, true);
      view.setUint32(at + 24, entry.size, true);
      view.setUint16(at + 28, entry.name.length, true);
      view.setUint16(at + 30, 0, true); // no extra field
      view.setUint16(at + 32, 0, true); // no comment
      view.setUint16(at + 34, 0, true); // one disk
      view.setUint16(at + 36, 0, true); // internal attributes
      view.setUint32(at + 38, unix ? (MODE_FILE << 16) >>> 0 : 0, true); // external attributes
      view.setUint32(at + 42, entry.offset, true);
      at += CENTRAL_HEADER_BYTES;
      out.set(entry.name, at);
      at += entry.name.length;
    }

    view.setUint32(at, EOCD_SIG, true);
    view.setUint16(at + 4, 0, true); // this disk
    view.setUint16(at + 6, 0, true); // disk holding the directory
    view.setUint16(at + 8, this.placed.length, true);
    view.setUint16(at + 10, this.placed.length, true);
    view.setUint32(at + 12, this.centralBytes, true);
    view.setUint32(at + 16, this.offset, true);
    view.setUint16(at + 20, 0, true); // no archive comment
    return out;
  }
}

function localHeader(entry: Placed): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(LOCAL_HEADER_BYTES + entry.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, LOCAL_SIG, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, entry.flags, true); // no encryption, no data descriptor
  view.setUint16(8, entry.method, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.compressedSize, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.name.length, true);
  view.setUint16(28, 0, true); // no extra field
  out.set(entry.name, LOCAL_HEADER_BYTES);
  return out;
}

const deflate = promisify(deflateRaw);

/**
 * Writes an archive into `sink` one file at a time, holding only the file in hand and the
 * central directory. `deflate` stores a file it cannot shrink. Await each call before the next.
 * An entry past `limits` is refused before any of it reaches the sink.
 */
export class ZipWriter {
  private readonly layout: ZipLayout;
  private writing = false;

  constructor(
    private readonly sink: ZipSink,
    limits: ZipWriteLimits = {},
  ) {
    this.layout = new ZipLayout(limits);
  }

  async add(name: string, data: Uint8Array, method: ZipMethod): Promise<void> {
    await this.write(async () => {
      const entry = this.layout.admit(name, data.length);
      // Off the event loop: a large rows file takes a while to deflate.
      return this.layout.place(entry, data, method === "deflate" ? await deflate(data) : null);
    });
  }

  /** Writes the central directory; nothing can be added after. */
  async finish(): Promise<void> {
    await this.write(async () => [this.layout.end()]);
  }

  private async write(chunks: () => Promise<Uint8Array[]>): Promise<void> {
    // Two writes in flight would interleave their chunks in the sink.
    if (this.writing) throw new ZipError("the previous entry is still being written");
    this.writing = true;
    try {
      for (const chunk of await chunks()) await this.sink(chunk);
    } finally {
      this.writing = false;
    }
  }
}

/** A whole archive in memory, every file packed with `method`, in the order given. */
export function zipFiles(files: readonly ZipFile[], method: ZipMethod): Uint8Array<ArrayBuffer> {
  const layout = new ZipLayout();
  const chunks = files.flatMap((file) => {
    const entry = layout.admit(file.name, file.data.length);
    return layout.place(entry, file.data, method === "deflate" ? deflateRawSync(file.data) : null);
  });
  chunks.push(layout.end());
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---- Reading --------------------------------------------------------------------------------

export interface ZipLimits {
  /** Entries, folders included. */
  maxEntries: number;
  /** One file, unpacked. */
  maxEntryBytes: number;
  /** Every file, unpacked, together. */
  maxTotalBytes: number;
  /** Unpacked bytes per packed byte, for a file of more than 1 MiB unpacked. */
  maxRatio: number;
}

/** 10,000 entries, 64 MiB a file, 256 MiB in all, and 100 to 1. */
export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = {
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 100,
};

/** A small file of one repeated byte packs far past any ratio, and cannot hurt. */
const RATIO_FREE_BYTES = 1024 * 1024;

export interface ZipEntryInfo {
  name: string;
  /** Unpacked, as the archive states it; reading holds the file to it. */
  size: number;
  /** In the archive. */
  compressedSize: number;
  method: ZipMethod;
}

export interface ZipArchive {
  /** Every file by name, in the central directory's order. Folder entries are checked, then left out. */
  files: ReadonlyMap<string, ZipEntryInfo>;
  /**
   * One file's bytes, unpacked and checked against its size and CRC. Refuses a file whose stated
   * size is over `maxBytes` (the archive's `maxEntryBytes` unless given), and stops unpacking at
   * the stated size.
   */
  read(name: string, maxBytes?: number): Promise<Uint8Array>;
}

interface Located extends ZipEntryInfo {
  rawName: Uint8Array;
  flags: number;
  crc: number;
  offset: number;
  /** Set once the local header is read. */
  dataStart: number;
  /** Past the data and its descriptor. */
  end: number;
}

const inflate = promisify(inflateRaw);

/**
 * Opens an untrusted archive held in memory. Names are read as UTF-8 whether or not an entry
 * flags them so, and are keyed in NFC form; two names equal in that form are duplicates.
 * Refuses encryption, Zip64, several disks, methods other than stored and deflate, symbolic links,
 * absolute, `..`, NUL and backslash names, duplicates, entries that overlap or lie outside the
 * file data, local headers and data descriptors that disagree with the central directory, and
 * anything past `limits`, whose unset fields take DEFAULT_ZIP_LIMITS.
 */
export function openZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipArchive {
  const caps = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEnd(bytes, view);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralAt = view.getUint32(eocd + 16, true);
  const zip64 = eocd >= ZIP64_LOCATOR_BYTES && view.getUint32(eocd - ZIP64_LOCATOR_BYTES, true) === ZIP64_LOCATOR_SIG;
  if (centralSize === MAX_32 || centralAt === MAX_32 || (zip64 && centralAt + centralSize !== eocd)) {
    throw new ZipError("the archive needs Zip64, which is not read");
  }
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0 || view.getUint16(eocd + 8, true) !== count) {
    throw new ZipError("the archive spans several disks");
  }
  if (count > caps.maxEntries) throw new ZipError(`the archive holds ${count} entries, more than ${caps.maxEntries}`);
  if (centralAt + centralSize !== eocd) throw new ZipError("the central directory is not where the archive's end record says");

  const located = readCentralDirectory(bytes, view, centralAt, eocd, count, caps);
  for (const entry of located) readLocalHeader(bytes, view, entry, centralAt);
  const byOffset = [...located].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byOffset.length; i++) {
    const [before, entry] = [byOffset[i - 1]!, byOffset[i]!];
    if (entry.offset < before.end) throw new ZipError(`overlaps ${quote(before.name)}`, entry.name);
  }

  const files = new Map<string, Located>();
  for (const entry of located) if (!entry.name.endsWith("/")) files.set(entry.name, entry);
  return {
    files,
    async read(name, maxBytes = caps.maxEntryBytes) {
      const entry = files.get(name);
      if (!entry) throw new ZipError("is not in the archive", name);
      if (entry.size > maxBytes) throw new ZipError(`is larger than ${maxBytes} bytes`, name);
      const packed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      let data: Uint8Array;
      if (entry.method === "stored") {
        data = new Uint8Array(packed);
      } else {
        try {
          // The ceiling holds whatever the deflate stream goes on to produce.
          data = await inflate(packed, { maxOutputLength: Math.max(entry.size, 1) });
        } catch (err) {
          const over = (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
          throw new ZipError(over ? `unpacks to more than its stated ${entry.size} bytes` : "is not valid deflate data", name);
        }
        if (data.length !== entry.size) throw new ZipError(`unpacks to ${data.length} bytes, not its stated ${entry.size}`, name);
      }
      if (crc32(data) !== entry.crc) throw new ZipError("fails its CRC check", name);
      return data;
    },
  };
}

/** The end of central directory record: the last signature whose comment runs exactly to the end. */
function findEnd(bytes: Uint8Array, view: DataView): number {
  const floor = Math.max(0, bytes.length - EOCD_BYTES - MAX_16);
  for (let at = bytes.length - EOCD_BYTES; at >= floor; at--) {
    if (view.getUint32(at, true) === EOCD_SIG && at + EOCD_BYTES + view.getUint16(at + 20, true) === bytes.length) return at;
  }
  throw new ZipError("this is not a zip archive, or it is cut short");
}

/** The entries the central directory lists, from `centralAt` up to the end record at `limit`. */
function readCentralDirectory(bytes: Uint8Array, view: DataView, centralAt: number, limit: number, count: number, caps: ZipLimits): Located[] {
  const located: Located[] = [];
  const names = new Set<string>();
  let total = 0;
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_BYTES > limit || view.getUint32(at, true) !== CENTRAL_SIG) throw new ZipError("the central directory is damaged");
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const methodCode = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const next = at + CENTRAL_HEADER_BYTES + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > limit) throw new ZipError("the central directory is damaged");
    const disk = view.getUint16(at + 34, true);
    const external = view.getUint32(at + 38, true);
    const offset = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength);
    at = next;

    let name: string;
    try {
      name = decoder.decode(rawName).normalize("NFC");
    } catch {
      throw new ZipError(`entry ${i + 1}'s name is not UTF-8`);
    }
    const problem = nameProblem(name);
    if (problem) throw new ZipError(problem, name);
    if (names.has(name)) throw new ZipError("is in the archive twice", name);
    names.add(name);
    if (flags & FLAGS_ENCRYPTED) throw new ZipError("is encrypted", name);
    if (disk !== 0) throw new ZipError("the archive spans several disks");
    if (compressedSize === MAX_32 || size === MAX_32 || offset === MAX_32) throw new ZipError("needs Zip64, which is not read", name);
    if (methodCode !== METHOD_STORED && methodCode !== METHOD_DEFLATE) {
      throw new ZipError(`uses compression method ${methodCode}; only stored and deflate are read`, name);
    }
    if (methodCode === METHOD_STORED && compressedSize !== size) throw new ZipError("is stored, yet states two sizes", name);
    const host = madeBy >>> 8;
    if ((host === HOST_UNIX || host === HOST_MACOS) && ((external >>> 16) & MODE_TYPE) === MODE_SYMLINK) {
      throw new ZipError("is a symbolic link", name);
    }
    if (name.endsWith("/") && (size !== 0 || compressedSize !== 0)) throw new ZipError("is a folder, yet has contents", name);
    if (size > caps.maxEntryBytes) throw new ZipError(`unpacks to ${size} bytes, more than ${caps.maxEntryBytes}`, name);
    total += size;
    if (total > caps.maxTotalBytes) throw new ZipError(`the files unpack to more than ${caps.maxTotalBytes} bytes`);
    if (size > RATIO_FREE_BYTES && size > caps.maxRatio * compressedSize) {
      throw new ZipError(`is packed more than ${caps.maxRatio} to 1`, name);
    }
    located.push({
      name,
      size,
      compressedSize,
      method: methodCode === METHOD_STORED ? "stored" : "deflate",
      rawName,
      flags,
      crc,
      offset,
      dataStart: 0,
      end: 0,
    });
  }
  if (at !== limit) throw new ZipError("the central directory holds more than its end record counts");
  return located;
}

/** Finds where an entry's data starts and ends, holding its local header and descriptor to the central directory. */
function readLocalHeader(bytes: Uint8Array, view: DataView, entry: Located, centralAt: number): void {
  const at = entry.offset;
  if (at + LOCAL_HEADER_BYTES > centralAt || view.getUint32(at, true) !== LOCAL_SIG) {
    throw new ZipError("has no local header where the central directory says", entry.name);
  }
  const flags = view.getUint16(at + 6, true);
  const nameLength = view.getUint16(at + 26, true);
  entry.dataStart = at + LOCAL_HEADER_BYTES + nameLength + view.getUint16(at + 28, true);
  const dataEnd = entry.dataStart + entry.compressedSize;
  if (dataEnd > centralAt) throw new ZipError("lies outside the archive's file data", entry.name);

  const central = [entry.crc, entry.compressedSize, entry.size];
  const agrees = (from: number) => central.every((value, i) => view.getUint32(from + 4 * i, true) === value);
  const descriptor = (flags & FLAG_DESCRIPTOR) !== 0;
  // With a data descriptor, the local header may leave the CRC and sizes at zero.
  const statedAgree = central.every((value, i) => {
    const stated = view.getUint32(at + 14 + 4 * i, true);
    return stated === value || (descriptor && stated === 0);
  });
  const agreed =
    statedAgree &&
    (flags & (FLAGS_ENCRYPTED | FLAG_DESCRIPTOR)) === (entry.flags & (FLAGS_ENCRYPTED | FLAG_DESCRIPTOR)) &&
    view.getUint16(at + 8, true) === (entry.method === "stored" ? METHOD_STORED : METHOD_DEFLATE) &&
    sameBytes(bytes.subarray(at + LOCAL_HEADER_BYTES, at + LOCAL_HEADER_BYTES + nameLength), entry.rawName);
  if (!agreed) throw new ZipError("has a local header that disagrees with the central directory", entry.name);

  entry.end = dataEnd;
  if (!descriptor) return;
  // The descriptor's signature is optional, and a CRC can look like one.
  if (dataEnd + 16 <= centralAt && view.getUint32(dataEnd, true) === DESCRIPTOR_SIG && agrees(dataEnd + 4)) entry.end += 16;
  else if (dataEnd + 12 <= centralAt && agrees(dataEnd)) entry.end += 12;
  else throw new ZipError("has a data descriptor that disagrees with the central directory", entry.name);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
