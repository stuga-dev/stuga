/**
 * The writer's archives are walked back by an independent extractor and by the reader. Hostile
 * archives are built field by field, so each one breaks exactly the rule its test names.
 */
import { createHash, randomBytes } from "node:crypto";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip } from "./testing/read-zip.js";
import { DEFAULT_ZIP_LIMITS, ZipError, ZipWriter, openZip, zipFiles, type ZipArchive, type ZipLimits } from "./zip.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const MiB = 1024 * 1024;

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** One entry of a hand-built archive; every field defaults to what an honest writer puts there. */
interface Raw {
  name: string | Uint8Array;
  data?: Uint8Array;
  /** 0 stores and 8 deflates `data`; any other number stores it under that method. */
  method?: number;
  /** What sits in the archive, when it is not `data` packed by `method`. */
  payload?: Uint8Array;
  flags?: number;
  crc?: number;
  size?: number;
  compressedSize?: number;
  /** Zeroes the local header's CRC and sizes and writes them after the data (flag bit 3). */
  descriptor?: "signed" | "bare";
  descriptorCrc?: number;
  localName?: string;
  madeBy?: number;
  external?: number;
  /** Where the central directory says the local header is. */
  offset?: number;
}

function craft(raws: readonly Raw[]): Uint8Array<ArrayBuffer> {
  const files: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  for (const raw of raws) {
    const data = raw.data ?? new Uint8Array(0);
    const method = raw.method ?? 0;
    const payload = raw.payload ?? (method === 8 ? deflateRawSync(data) : data);
    const name = typeof raw.name === "string" ? utf8(raw.name) : raw.name;
    const localName = raw.localName === undefined ? name : utf8(raw.localName);
    const fields = [raw.crc ?? crc32(data), raw.compressedSize ?? payload.length, raw.size ?? data.length];
    const flags = (raw.flags ?? 0) | (raw.descriptor ? 1 << 3 : 0);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    if (!raw.descriptor) fields.forEach((v, i) => local.setUint32(14 + 4 * i, v, true));
    local.setUint16(26, localName.length, true);
    const parts = [new Uint8Array(local.buffer), localName, payload];
    if (raw.descriptor) {
      const signed = raw.descriptor === "signed";
      const descriptor = new DataView(new ArrayBuffer(signed ? 16 : 12));
      if (signed) descriptor.setUint32(0, 0x08074b50, true);
      [raw.descriptorCrc ?? fields[0]!, fields[1]!, fields[2]!].forEach((v, i) => descriptor.setUint32((signed ? 4 : 0) + 4 * i, v, true));
      parts.push(new Uint8Array(descriptor.buffer));
    }

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, raw.madeBy ?? 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, flags, true);
    record.setUint16(10, method, true);
    fields.forEach((v, i) => record.setUint32(16 + 4 * i, v, true));
    record.setUint16(28, name.length, true);
    record.setUint32(38, raw.external ?? 0, true);
    record.setUint32(42, raw.offset ?? at, true);
    central.push(new Uint8Array(record.buffer), name);

    files.push(...parts);
    at += parts.reduce((n, p) => n + p.length, 0);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, raws.length, true);
  end.setUint16(10, raws.length, true);
  end.setUint32(12, central.reduce((n, c) => n + c.length, 0), true);
  end.setUint32(16, at, true);
  return concat([...files, ...central, new Uint8Array(end.buffer)]);
}

/** The end record of an archive with no comment. */
const endRecord = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22, 22);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ZipError);
    return (err as ZipError).message;
  }
  throw new Error("expected a ZipError");
}

async function readRefusal(zip: ZipArchive, name: string, maxBytes?: number): Promise<string> {
  const err: unknown = await zip.read(name, maxBytes).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ZipError);
  return (err as ZipError).message;
}

const opened = (raws: readonly Raw[], limits?: Partial<ZipLimits>) => refusal(() => openZip(craft(raws), limits));

describe("zipFiles", () => {
  const manifest = utf8('{"a":1}\n');
  const server = utf8("console.log('hi')\n");
  const entries = [
    { name: "manifest.json", data: manifest },
    { name: "server/index.js", data: server },
  ];

  it("writes every entry stored, intact, and in the order given", () => {
    const { count, entries: read } = readZip(zipFiles(entries, "stored"));
    expect(count).toBe(2);
    expect(read.map((e) => e.name)).toEqual(["manifest.json", "server/index.js"]);
    for (const [i, entry] of read.entries()) {
      const source = entries[i]!;
      expect(entry.method).toBe(0);
      expect(entry.flags).toBe(0);
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
    expect(zipFiles(entries, "stored").length).toBe(256);
  });

  it("keeps the stored layout the extension installer takes, byte for byte", () => {
    const sha = createHash("sha256").update(zipFiles(entries, "stored")).digest("hex");
    expect(sha).toBe("ae182a0afbb48e8a28326694e29b5c1f73d4c539a4a0f12aa2fb38ae01b04496");
  });

  it("is byte-reproducible", () => {
    for (const method of ["stored", "deflate"] as const) expect([...zipFiles(entries, method)]).toEqual([...zipFiles(entries, method)]);
  });

  it("writes an empty archive with no entries", () => {
    expect(readZip(zipFiles([], "deflate")).count).toBe(0);
    expect(openZip(zipFiles([], "deflate")).files.size).toBe(0);
  });

  it("flags a non-ASCII name as UTF-8, from a Unix host with mode 0644, and counts its length in bytes", () => {
    const name = "Laws/个人信息保护法.md";
    const { entries: read } = readZip(zipFiles([{ name, data: manifest }, ...entries], "stored"));
    expect(read.map((e) => [e.name, e.flags, e.madeBy >> 8, e.external >>> 16])).toEqual([
      [name, 1 << 11, 3, 0o100644],
      ["manifest.json", 0, 0, 0],
      ["server/index.js", 0, 0, 0],
    ]);
    expect(read[1]!.localOffset).toBe(30 + utf8(name).length + manifest.length);
  });

  it("deflates an entry that shrinks, and stores one that does not", () => {
    const text = utf8("Personal information shall be processed lawfully.\n".repeat(200));
    const noise = randomBytes(4096);
    const [deflated, stored] = readZip(
      zipFiles(
        [
          { name: "a.md", data: text },
          { name: "b.png", data: noise },
        ],
        "deflate",
      ),
    ).entries;
    expect(deflated!.method).toBe(8);
    expect(deflated!.compressedSize).toBeLessThan(text.length);
    expect([...inflateRawSync(deflated!.data)]).toEqual([...text]);
    expect(stored!.method).toBe(0);
    expect([...stored!.data]).toEqual([...noise]);
  });

  it.each([
    ["server\\index.js", "holds a backslash, which extractors read differently"],
    ["/server/index.js", "is an absolute path"],
    ["C:/server/index.js", "is an absolute path"],
    ["server//index.js", "is not a plain relative path"],
    ["server/../index.js", "is not a plain relative path"],
    ["./index.js", "is not a plain relative path"],
    ["server/", "names a folder; only files are written"],
    ["index\0.js", "holds a NUL character"],
    ["index\ud800.js", "is not valid Unicode"],
    ["", "is not a name"],
  ])("refuses %o as an entry name", (name, reason) => {
    expect(refusal(() => zipFiles([{ name, data: manifest }], "stored"))).toBe(`${JSON.stringify(name)} ${reason}`);
  });

  it("refuses a name given twice, also in another Unicode form", () => {
    expect(refusal(() => zipFiles([entries[0]!, entries[0]!], "stored"))).toBe('"manifest.json" is in the archive twice');
    const twice = [
      { name: "Caf\u00e9.md", data: manifest },
      { name: "Cafe\u0301.md", data: manifest },
    ];
    expect(refusal(() => zipFiles(twice, "stored"))).toBe('"Cafe\u0301.md" is in the archive twice');
  });

  it("refuses a 65,536th entry, which needs Zip64", () => {
    const many = Array.from({ length: 65_536 }, (_, i) => ({ name: String(i), data: new Uint8Array(0) }));
    expect(refusal(() => zipFiles(many, "stored"))).toBe('"65535" would be entry 65536; more need Zip64, which is not written');
    expect(readZip(zipFiles(many.slice(0, 65_535), "stored")).count).toBe(65_535);
  });

  it("refuses an entry that would take the archive past 4 GiB, before reading its bytes", async () => {
    // Only claims the length: the refusal comes before anything reads it.
    const huge = Object.defineProperty(new Uint8Array(0), "length", { value: 2 ** 32 - 100 });
    const reason = '"big.bin" would take the archive past 4 GiB, which needs Zip64';
    expect(refusal(() => zipFiles([{ name: "big.bin", data: huge }], "deflate"))).toBe(reason);
    await expect(new ZipWriter(() => {}).add("big.bin", huge, "deflate")).rejects.toThrow(reason);
  });
});

describe("ZipWriter", () => {
  const files = [
    { name: "stuga.json", data: utf8('{"format":"stuga-workspace"}\n') },
    // Deflated past one 16 KiB output chunk, so off-thread deflate is held to the in-line bytes.
    { name: "Laws/个人信息保护法.md", data: utf8(Array.from({ length: 4000 }, (_, i) => `第${i}条 ${((i * 2654435761) >>> 0).toString(36)}\n`).join("")) },
  ];

  it("writes into the sink one entry at a time, waiting on each write, the same bytes as zipFiles", async () => {
    const chunks: Uint8Array[] = [];
    const zip = new ZipWriter(async (chunk) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      chunks.push(chunk);
    });
    await zip.add(files[0]!.name, files[0]!.data, "deflate");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(30 + 10);
    await zip.add(files[1]!.name, files[1]!.data, "deflate");
    await zip.finish();
    expect([...concat(chunks)]).toEqual([...zipFiles(files, "deflate")]);
  });

  it("refuses an entry while the last one is still being packed or written, and any after finishing", async () => {
    const zip = new ZipWriter(() => new Promise((resolve) => setTimeout(resolve, 1)));
    const first = zip.add("a.md", utf8("a"), "deflate");
    await expect(zip.add("b.md", utf8("b"), "stored")).rejects.toThrow("the previous entry is still being written");
    await first;
    await zip.finish();
    await expect(zip.add("c.md", utf8("c"), "stored")).rejects.toThrow("the archive is already finished");
  });

  it("refuses an entry past its limits before any of it reaches the sink, counting the archive as packed", async () => {
    const ten = utf8("0123456789");
    const chunks: Uint8Array[] = [];
    // One 10-byte stored entry makes a 116-byte archive: 30 + 4 + 10 local, 46 + 4 central, 22 end.
    // Another named as long adds 84 bytes and its payload, so 20 bytes of payload fit.
    const zip = new ZipWriter((chunk) => void chunks.push(chunk), { maxBytes: 220 });
    await zip.add("a.md", ten, "stored");
    await expect(zip.add("b.md", utf8("0123456789".repeat(3)), "stored")).rejects.toThrow('"b.md" would take the archive past 220 bytes');
    expect(chunks).toHaveLength(2);
    // Deflated, a thousand bytes take less room than those thirty.
    await zip.add("c.md", utf8("a".repeat(1000)), "deflate");
    await zip.finish();
    expect(openZip(concat(chunks)).files.size).toBe(2);

    const files = new ZipWriter(() => {}, { maxEntries: 1 });
    await files.add("a.md", ten, "stored");
    await expect(files.add("b.md", ten, "stored")).rejects.toThrow('"b.md" would be file 2; the archive takes at most 1');

    const unpacked = new ZipWriter(() => {}, { maxTotalBytes: 1005 });
    await unpacked.add("a.md", utf8("a".repeat(1000)), "deflate");
    await expect(unpacked.add("b.md", ten, "stored")).rejects.toThrow('"b.md" would take the files past 1005 bytes unpacked');
  });
});

describe("openZip", () => {
  const files = [
    { name: "stuga.json", data: utf8('{"format":"stuga-workspace","version":1}\n') },
    { name: "Start here.md", data: utf8("# Start here\n\nRead the laws first.\n".repeat(40)) },
    { name: "Laws/个人信息保护法.md", data: utf8("# 个人信息保护法\n\n第一条 为了保护个人信息权益。\n".repeat(40)) },
    { name: "Obligations/Obligations.jsonl", data: utf8('{"_id":"r1","Law":"GDPR"}\n'.repeat(100)) },
    { name: "media/0a1b.png", data: randomBytes(2048) },
    { name: "empty.md", data: new Uint8Array(0) },
  ];

  it.each(["stored", "deflate"] as const)("reads back every file %s, non-ASCII names included", async (method) => {
    const zip = openZip(zipFiles(files, method));
    expect([...zip.files.keys()]).toEqual(files.map((f) => f.name));
    for (const file of files) {
      expect(zip.files.get(file.name)!.size).toBe(file.data.length);
      expect([...(await zip.read(file.name))]).toEqual([...file.data]);
    }
    expect(zip.files.get("Start here.md")!.method).toBe(method);
    expect(zip.files.get("media/0a1b.png")!.method).toBe("stored");
  });

  it("reads a file as a copy, not a view into the archive", async () => {
    const bytes = zipFiles(files, "stored");
    const read = await openZip(bytes).read("stuga.json");
    read.fill(0);
    expect([...(await openZip(bytes).read("stuga.json"))]).toEqual([...files[0]!.data]);
  });

  it("checks folder entries, then leaves them out", async () => {
    const zip = openZip(craft([{ name: "Laws/" }, { name: "Laws/a.md", data: utf8("# A\n") }]));
    expect([...zip.files.keys()]).toEqual(["Laws/a.md"]);
    expect(opened([{ name: "Laws/", data: utf8("x") }])).toBe('"Laws/" is a folder, yet has contents');
  });

  it.each(["signed", "bare"] as const)("reads an entry whose sizes follow its data in a %s descriptor", async (descriptor) => {
    const data = utf8("# Notes\n".repeat(30));
    const zip = openZip(craft([{ name: "a.md", data, method: 8, descriptor }, { name: "b.md", data, descriptor }]));
    expect([...(await zip.read("a.md"))]).toEqual([...data]);
    expect([...(await zip.read("b.md"))]).toEqual([...data]);
  });

  it("reads a UTF-8 name left unflagged, and keys names in NFC form", () => {
    const zip = openZip(craft([{ name: "Laws/Cafe\u0301.md", data: utf8("x") }]));
    expect([...zip.files.keys()]).toEqual(["Laws/Caf\u00e9.md"]);
  });

  it("refuses a file it does not hold, and one over the ceiling it is read with", async () => {
    const zip = openZip(zipFiles(files, "deflate"));
    expect(await readRefusal(zip, "missing.md")).toBe('"missing.md" is not in the archive');
    expect(await readRefusal(zip, "Start here.md", 100)).toBe('"Start here.md" is larger than 100 bytes');
  });

  describe("refuses", () => {
    it.each([
      ["../evil.md", "is not a plain relative path"],
      ["Laws/../../evil.md", "is not a plain relative path"],
      ["Laws//a.md", "is not a plain relative path"],
      ["./a.md", "is not a plain relative path"],
      ["/etc/passwd", "is an absolute path"],
      ["C:/evil.md", "is an absolute path"],
      ["..\\evil.md", "holds a backslash, which extractors read differently"],
      ["a\0.md", "holds a NUL character"],
      ["", "is not a name"],
    ])("the name %o", (name, reason) => {
      expect(opened([{ name, data: utf8("x") }])).toBe(`${JSON.stringify(name)} ${reason}`);
    });

    it("a name that is not UTF-8", () => {
      expect(opened([{ name: new Uint8Array([0x61, 0x80, 0x2e, 0x6d, 0x64]) }])).toBe("entry 1's name is not UTF-8");
    });

    it("a name listed twice, also in another Unicode form", () => {
      expect(opened([{ name: "a.md" }, { name: "a.md" }])).toBe('"a.md" is in the archive twice');
      expect(opened([{ name: "Caf\u00e9.md" }, { name: "Cafe\u0301.md" }])).toBe('"Caf\u00e9.md" is in the archive twice');
    });

    it("an encrypted entry", () => {
      expect(opened([{ name: "a.md", data: utf8("x"), flags: 1 }])).toBe('"a.md" is encrypted');
      expect(opened([{ name: "a.md", data: utf8("x"), flags: 1 << 6 }])).toBe('"a.md" is encrypted');
    });

    it.each([12, 14, 99])("compression method %i", (method) => {
      expect(opened([{ name: "a.md", data: utf8("x"), method }])).toBe(`"a.md" uses compression method ${method}; only stored and deflate are read`);
    });

    it("a symbolic link", () => {
      const link = { name: "a.md", data: utf8("/etc/passwd"), madeBy: (3 << 8) | 20, external: 0o120777 << 16 };
      expect(opened([link])).toBe('"a.md" is a symbolic link');
      expect(openZip(craft([{ ...link, external: 0o100644 << 16 }])).files.has("a.md")).toBe(true);
    });

    it("an archive cut short", () => {
      const bytes = zipFiles(files, "deflate");
      for (const cut of [bytes.subarray(0, bytes.length - 1), bytes.subarray(0, 100), bytes.subarray(0, 10), new Uint8Array(0)]) {
        expect(refusal(() => openZip(cut))).toBe("this is not a zip archive, or it is cut short");
      }
      const holed = concat([bytes.subarray(0, 60), bytes.subarray(70)]);
      expect(refusal(() => openZip(holed))).toBe("the central directory is not where the archive's end record says");
    });

    it("an end record that counts more entries than the central directory holds", () => {
      const bytes = craft([{ name: "a.md" }]);
      endRecord(bytes).setUint16(8, 2, true);
      endRecord(bytes).setUint16(10, 2, true);
      expect(refusal(() => openZip(bytes))).toBe("the central directory is damaged");
    });

    it("Zip64 and archives on several disks", () => {
      const zip64 = craft([{ name: "a.md" }]);
      endRecord(zip64).setUint32(16, 0xffffffff, true);
      expect(refusal(() => openZip(zip64))).toBe("the archive needs Zip64, which is not read");
      expect(opened([{ name: "a.md", size: 0xffffffff, compressedSize: 0xffffffff }])).toBe('"a.md" needs Zip64, which is not read');
      const disks = craft([{ name: "a.md" }]);
      endRecord(disks).setUint16(4, 1, true);
      expect(refusal(() => openZip(disks))).toBe("the archive spans several disks");
    });

    it("a stored file that fails its CRC check, when it is read", async () => {
      const bytes = craft([{ name: "a.md", data: utf8("# Title\n") }]);
      bytes[36] = bytes[36]! ^ 0xff;
      expect(await readRefusal(openZip(bytes), "a.md")).toBe('"a.md" fails its CRC check');
    });

    it("a deflated file that fails its CRC check, or is not deflate data", async () => {
      const data = utf8("# Title\n".repeat(10));
      expect(await readRefusal(openZip(craft([{ name: "a.md", data, method: 8, crc: crc32(data) ^ 1 }])), "a.md")).toBe('"a.md" fails its CRC check');
      const garbage = openZip(craft([{ name: "a.md", data, method: 8, payload: new Uint8Array([0xff, 0xff, 0xff]) }]));
      expect(await readRefusal(garbage, "a.md")).toBe('"a.md" is not valid deflate data');
    });

    it("entries that overlap", () => {
      const b = { name: "b.md", data: utf8("bbb") };
      // a's stated size runs over b's local header and data, so b's bytes are read twice.
      const cover = 3 + 30 + 4 + 3;
      expect(opened([{ name: "a.md", data: utf8("aaa"), size: cover, compressedSize: cover }, b])).toBe('"b.md" overlaps "a.md"');
    });

    it("an entry outside the archive's file data", () => {
      expect(opened([{ name: "a.md", data: utf8("x"), offset: 1000 }])).toBe('"a.md" has no local header where the central directory says');
      expect(opened([{ name: "a.md", data: utf8("x"), size: 500, compressedSize: 500 }])).toBe('"a.md" lies outside the archive\'s file data');
    });

    it("a local header that disagrees with the central directory", () => {
      expect(opened([{ name: "a.md", data: utf8("x"), localName: "b.md" }])).toBe('"a.md" has a local header that disagrees with the central directory');
      const bytes = craft([{ name: "a.md", data: utf8("x") }]);
      new DataView(bytes.buffer).setUint32(14, 0, true);
      expect(refusal(() => openZip(bytes))).toBe('"a.md" has a local header that disagrees with the central directory');
    });

    it("a data descriptor that disagrees with the central directory", () => {
      const data = utf8("# Notes\n");
      expect(opened([{ name: "a.md", data, descriptor: "signed", descriptorCrc: 7 }])).toBe(
        '"a.md" has a data descriptor that disagrees with the central directory',
      );
    });

    it("more entries than the limit", () => {
      const raws = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.md` }));
      expect(opened(raws, { maxEntries: 10 })).toBe("the archive holds 11 entries, more than 10");
    });

    it("a file whose stated size is over the limit, and files over the total", () => {
      const data = new Uint8Array(1000);
      expect(opened([{ name: "a.md", data }], { maxEntryBytes: 999 })).toBe('"a.md" unpacks to 1000 bytes, more than 999');
      const three = ["a", "b", "c"].map((n) => ({ name: `${n}.md`, data }));
      expect(opened(three, { maxTotalBytes: 2999 })).toBe("the files unpack to more than 2999 bytes");
    });

    it("a zip bomb: a file packed past the ratio", () => {
      const zeros = new Uint8Array(10 * MiB);
      expect(opened([{ name: "bomb.md", data: zeros, method: 8 }])).toBe(`"bomb.md" is packed more than ${DEFAULT_ZIP_LIMITS.maxRatio} to 1`);
      // A small file of one repeated byte is no bomb.
      expect(openZip(craft([{ name: "blank.md", data: new Uint8Array(MiB), method: 8 }])).files.size).toBe(1);
    });

    it("a zip bomb that understates its size, stopping at the stated size", async () => {
      const zeros = new Uint8Array(20 * MiB);
      const zip = openZip(craft([{ name: "bomb.md", data: zeros, method: 8, size: 1000 }]));
      expect(await readRefusal(zip, "bomb.md")).toBe('"bomb.md" unpacks to more than its stated 1000 bytes');
    });

    it("a file that unpacks to less than it states", async () => {
      const zip = openZip(craft([{ name: "a.md", data: new Uint8Array(1000), method: 8, size: 5000 }]));
      expect(await readRefusal(zip, "a.md")).toBe('"a.md" unpacks to 1000 bytes, not its stated 5000');
    });
  });
});
