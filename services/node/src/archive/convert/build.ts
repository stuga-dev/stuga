/**
 * An archive from what a converter read out of another app's export: its folders, documents and
 * databases named and placed as an export places them, each body's links and images pointed at
 * what they lead to, and the images copied into media/. The archive is held in memory, as a zip
 * would be read, so an import checks and writes it as it does an archive from a file.
 */
import { createHash } from "node:crypto";
import { docToMarkdown, getStugaSchema, markdownToDoc } from "@stuga/crdt-ops";
import { MAX_IMPORT_MARKDOWN_BYTES, markdownByteLength } from "@stuga/protocol/text/markdown-import";
import { ZipError, type ZipArchive, type ZipEntryInfo } from "../../lib/zip.js";
import { MediaValidationError, decodeBase64Image, validateImageBytes } from "../../media/media.js";
import { VERSION } from "../../version.js";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MAX_WORKSPACE_NAME_CHARS,
  ARCHIVE_RESERVED_NAMES,
  ARCHIVE_VERSION,
  MANIFEST_NAME,
  archiveCellValue,
  archiveHref,
  archiveName,
  archiveNameRoom,
  archiveTitle,
  bodyFile,
  cellFilePaths,
  derivedTitle,
  filePath,
  formatTableRows,
  mediaPath,
  rewritten,
  type ArchiveColumn,
  type ArchiveDocSettings,
  type ArchiveItem,
  type ArchiveManifest,
  type ArchiveRow,
  type ArchiveTable,
  type ArchiveTarget,
} from "../format.js";
import type { Source } from "./source.js";

/** A body a converter read, by the key its links name it by: the source file it came from. */
export interface Body {
  key: string;
  /** Markdown, starting with its title as a heading. */
  markdown: string;
}

export interface FolderEntry {
  kind: "folder";
  title: string;
  /** A key links may name the folder by. */
  key?: string;
  children: Entry[];
}

export interface DocEntry extends Body {
  kind: "doc";
  title: string;
}

export interface DatabaseEntry {
  kind: "database";
  key: string;
  title: string;
  columns: ArchiveColumn[];
  /** Cells as stored: a checkbox is 0 or 1, a files cell its files' source paths, one per line. */
  rows: ArchiveRow[];
  pages: Array<Body & { row: string; title: string }>;
}

export type Entry = FolderEntry | DocEntry | DatabaseEntry;

/**
 * Where a link or image in the body keyed `from` leads: an entry by its key (a database's row by
 * its key), a source file an image shows or a link leads to, a URL outside kept as written, or null
 * for nowhere, which leaves a link as its text and an image out.
 */
export type Resolved = { item: string; row?: string } | { image: string } | { file: string } | { href: string } | null;

export interface Conversion {
  /** The new workspace's name. */
  name: string;
  entries: Entry[];
  /** The key of the document to open first. */
  start?: string;
  resolve(from: string, href: string): Resolved;
  /** The source files the entries hold, by path. Images count once a body shows them. */
  consumed: ReadonlySet<string>;
}

export interface Built {
  zip: ZipArchive;
  /** Every source file the archive does not carry, by path, in order. */
  leftOut: string[];
}

/** Names in a database's deepest path, its own folder's included: `<db>/pages/<row>.md`. */
const DATABASE_LEVELS = 3;
const PAGES_DIR = "pages";
const INLINE_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

function levels(entry: Entry): number {
  if (entry.kind === "doc") return 1;
  if (entry.kind === "database") return DATABASE_LEVELS;
  return 1 + Math.max(0, ...entry.children.map(levels));
}

const settings = (title: string, source: ArchiveDocSettings["title_source"]): ArchiveDocSettings => ({
  title,
  title_source: source,
  agent_mode: "review",
  locked: false,
  search_hidden: false,
  agent_instructions: "",
});

/** A workspace name as the manifest takes one: one line of 1 to 100 characters, no space at either end. */
function workspaceName(name: string): string {
  const line = archiveTitle(name).trim().slice(0, ARCHIVE_MAX_WORKSPACE_NAME_CHARS).trim();
  return line || "Imported";
}

export async function buildArchive(conversion: Conversion, source: Source, limits: { maxImageBytes: number }): Promise<Built> {
  const carried = new Set(conversion.consumed);
  const items: ArchiveItem[] = [];
  const files = new Map<string, HeldFile>();
  const hold = (path: string, bytes: Uint8Array): void => void files.set(path, { size: bytes.byteLength, read: async () => bytes });
  const targets = new Map<string, ArchiveTarget>();
  const taken = new Map<string, Set<string>>();
  const takenIn = (dir: string): Set<string> => {
    let names = taken.get(dir);
    if (!names) taken.set(dir, (names = new Set(dir ? [] : ARCHIVE_RESERVED_NAMES)));
    return names;
  };
  const nameIn = (dir: string, title: string, extension: string, depth: number): string =>
    joinPath(dir, archiveName(archiveTitle(title), takenIn(dir), extension, archiveNameRoom(dir, depth)));

  // Everything is named and placed first, so every body's links have somewhere to point.
  const bodies: Array<Body & { title: string; path: string; settle: (title: string, source: ArchiveDocSettings["title_source"]) => void }> = [];
  const tables: Array<{ table: ArchiveTable; rows: ArchiveRow[] }> = [];
  const place = (entries: Entry[], parent: string | null): void => {
    const dir = parent ?? "";
    for (const entry of entries) {
      if (entry.kind === "folder") {
        const path = nameIn(dir, entry.title, "", levels(entry));
        items.push({ kind: "folder", path, parent, title: archiveTitle(entry.title), agent_instructions: "" });
        if (entry.key) targets.set(entry.key, { path });
        place(entry.children, path);
      } else if (entry.kind === "doc") {
        const path = nameIn(dir, entry.title, ".md", 1);
        const item = { kind: "doc" as const, path, parent, ...settings(archiveTitle(entry.title), "heading") };
        items.push(item);
        targets.set(entry.key, { path });
        bodies.push({ ...entry, path, settle: (title, from) => Object.assign(item, { title, title_source: from }) });
      } else {
        const path = nameIn(dir, entry.title, "", DATABASE_LEVELS);
        const table: ArchiveTable = { name: tableName(entry.title), file: nameIn(path, entry.title, ".jsonl", 1), columns: entry.columns, views: [], pages: [] };
        items.push({ kind: "database", path, parent, ...settings(archiveTitle(entry.title), "user"), tables: [table] });
        targets.set(entry.key, { path });
        tables.push({ table, rows: entry.rows });
        for (const page of entry.pages) {
          const file = nameIn(joinPath(path, PAGES_DIR), page.title, ".md", 1);
          const item = { row: page.row, file, ...settings(archiveTitle(page.title), "heading") };
          table.pages.push(item);
          targets.set(page.key, { path: file });
          bodies.push({ ...page, path: file, settle: (title, from) => Object.assign(item, { title, title_source: from }) });
        }
      }
    }
  };
  place(conversion.entries, null);

  const media = new Map<string, string | null>();
  /**
   * Where `read`'s image lands in media/, or null for bytes no image of this node's may hold. Its
   * bytes are read again when the archive is, rather than held.
   */
  const stored = async (read: () => Promise<Uint8Array> | Uint8Array): Promise<string | null> => {
    try {
      const { bytes, mime } = validateImageBytes(await read(), limits.maxImageBytes);
      const path = mediaPath(createHash("sha256").update(bytes).digest("hex"), mime);
      files.set(path, { size: bytes.byteLength, read: async () => await read() });
      return path;
    } catch (err) {
      if (err instanceof MediaValidationError) return null;
      throw err;
    }
  };
  const imageAt = async (file: string): Promise<string | null> => {
    if (media.has(file)) return media.get(file)!;
    const found = source.files.get(file);
    const path = found && found.size <= limits.maxImageBytes ? await stored(() => found.read()) : null;
    if (path) carried.add(file);
    media.set(file, path);
    return path;
  };

  const linked = new Map<string, string | null>();
  /**
   * Where a file a body links to lands in the archive, `media/<sha256>/<name>`, read again when the
   * archive is; null for one past the node's upload limit, which is left out.
   */
  const fileAt = async (file: string): Promise<string | null> => {
    if (linked.has(file)) return linked.get(file)!;
    const found = source.files.get(file);
    let path: string | null = null;
    if (found && found.size > 0 && found.size <= limits.maxImageBytes) {
      const bytes = await found.read();
      path = filePath(createHash("sha256").update(bytes).digest("hex"), file.slice(file.lastIndexOf("/") + 1));
      files.set(path, { size: bytes.byteLength, read: () => found.read() });
      carried.add(file);
    }
    linked.set(file, path);
    return path;
  };

  // A files cell's source files land as the archive's own; one it cannot carry, or that would not fit the cell, is left out.
  for (const { table, rows } of tables) {
    const filesColumns = table.columns.filter((column) => column.type === "files");
    for (const row of rows) {
      for (const column of filesColumns) {
        const kept: string[] = [];
        for (const file of cellFilePaths(row.values[column.name])) {
          const fits = archiveCellValue(column, [...kept, filePath("0".repeat(64), file.slice(file.lastIndexOf("/") + 1))]).ok;
          const path = fits ? await fileAt(file) : null;
          if (path && !kept.includes(path)) kept.push(path);
        }
        if (kept.length > 0) row.values[column.name] = kept.join("\n");
        else delete row.values[column.name];
      }
    }
    hold(table.file, utf8(formatTableRows(table, rows)));
  }

  const schema = getStugaSchema();
  for (const body of bodies) {
    const doc = markdownToDoc(body.markdown, schema);
    const images = new Map<string, string | null>();
    const sources: string[] = [];
    const hrefs = new Set<string>();
    doc.descendants((node) => {
      if (node.type.name === "image") sources.push(String(node.attrs.src ?? ""));
      for (const mark of node.marks) if (mark.type.name === "link") hrefs.add(String(mark.attrs.href ?? ""));
    });
    for (const src of sources) {
      if (images.has(src)) continue;
      // An image written into the page itself, as `data:image/png;base64,…`.
      if (INLINE_IMAGE.test(src)) {
        const path = await stored(() => decodeBase64Image(src));
        images.set(src, path ? archiveHref(body.path, { path }) : null);
        continue;
      }
      const to = conversion.resolve(body.key, src);
      const image = to && "image" in to ? await imageAt(to.image) : null;
      images.set(src, image ? archiveHref(body.path, { path: image }) : to && "href" in to ? to.href : null);
    }
    // A link to a file, an image among them, carries the file along.
    const linkedFiles = new Map<string, string | null>();
    for (const href of hrefs) {
      const to = conversion.resolve(body.key, href);
      const file = to && ("file" in to ? to.file : "image" in to ? to.image : null);
      if (file !== null && !linkedFiles.has(href)) {
        const path = await fileAt(file);
        linkedFiles.set(href, path ? archiveHref(body.path, { path }) : null);
      }
    }
    const link = (href: string): string | null => {
      if (linkedFiles.has(href)) return linkedFiles.get(href)!;
      const to = conversion.resolve(body.key, href);
      if (!to || "image" in to || "file" in to) return null;
      if ("href" in to) return to.href;
      const target = targets.get(to.item);
      if (!target) return null;
      return archiveHref(body.path, to.row === undefined ? target : { ...target, row: to.row });
    };
    let markdown = docToMarkdown(rewritten(doc, link, (src) => images.get(src) ?? null));
    if (markdownByteLength(markdown) > MAX_IMPORT_MARKDOWN_BYTES) {
      carried.delete(body.key);
      markdown = "";
    }
    const title = markdown ? derivedTitle(markdownToDoc(markdown, schema)) : "";
    if (title) body.settle(title, "heading");
    else body.settle(archiveTitle(body.title), "user");
    hold(body.path, utf8(bodyFile(markdown)));
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    generator: `stuga ${VERSION}`,
    exported_at: new Date().toISOString(),
    workspace: { name: workspaceName(conversion.name), agent_instructions: "" },
    items,
  };
  const start = conversion.start === undefined ? undefined : targets.get(conversion.start);
  if (start && items.some((item) => item.kind === "doc" && item.path === start.path)) manifest.start = start.path;
  hold(MANIFEST_NAME, utf8(JSON.stringify(manifest)));
  const leftOut = [...source.files.keys()].filter((path) => !carried.has(path)).sort();
  return { zip: memoryZip(files), leftOut };
}

/** A table name as the database actor takes one: 1 to 200 characters, one line, no space at either end. */
function tableName(title: string): string {
  return archiveTitle(title).trim() || "Table";
}

/** A file of the archive: text held, an image read from the export when it is wanted. */
interface HeldFile {
  size: number;
  read(): Promise<Uint8Array>;
}

/** `files` read as an opened zip is. */
function memoryZip(files: Map<string, HeldFile>): ZipArchive {
  const infos = new Map<string, ZipEntryInfo>();
  for (const [name, { size }] of files) infos.set(name, { name, size, compressedSize: size, method: "stored" });
  return {
    files: infos,
    async read(name, maxBytes = Infinity) {
      const file = files.get(name);
      if (!file) throw new ZipError("is not in the archive", name);
      if (file.size > maxBytes) throw new ZipError(`is larger than ${maxBytes} bytes`, name);
      return file.read();
    },
  };
}
