/**
 * Import a workspace archive into a new workspace. The whole archive is read
 * and checked before anything is written; then every item lands as the
 * importing person through an ImportClient: containers before what they hold,
 * bodies once every link has somewhere to point, and each document's settings
 * last, so a lock or `auto` review never stands in the way of the import's own
 * writes or a sample's proposals. Past the manifest, only the zip is held
 * throughout: each body, rows file and image is read from it again when it is
 * written. Each document's and database's actor is released once a pass or its
 * settings are done with it, and each body is saved as it is written, so a large
 * archive holds one store open at a time.
 */
import { createHash } from "node:crypto";
import type { ImportedComment } from "@stuga/db";
import { docToMarkdown, getStugaSchema, markdownToDoc } from "@stuga/crdt-ops";
import type { SafeImageMime } from "@stuga/protocol/api/media";
import { DATABASE_MAX_ROWS_PER_WRITE } from "@stuga/protocol/databases/limits";
import type { RowFilterNode, RowValue, TableSchema } from "@stuga/protocol/databases/types";
import { type AccountCtx, workspaceContextFor } from "../auth/context.js";
import { openZip, ZipError, type ZipArchive, type ZipEntryInfo } from "../lib/zip.js";
import { MediaValidationError, mediaUrl, validateImageBytes } from "../media/media.js";
import { type ColumnInput, type DocState, type ImportClient, type ViewInput, workspaceImportClient } from "./client.js";
import {
  ARCHIVE_MAX_BODY_BYTES,
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_MANIFEST_BYTES,
  ARCHIVE_MAX_MEDIA_BYTES,
  ARCHIVE_MAX_ROWS,
  ARCHIVE_MAX_TABLE_FILE_BYTES,
  ARCHIVE_MAX_UNPACKED_BYTES,
  ArchiveError,
  MANIFEST_NAME,
  ROW_FIELDS,
  archiveIndex,
  isArchiveHref,
  parseManifest,
  parseMediaPath,
  parseTableRows,
  resolveArchiveHref,
  type ArchiveColumn,
  type ArchiveComment,
  type ArchiveDatabase,
  type ArchiveDocSettings,
  type ArchiveFilterNode,
  type ArchiveIndex,
  type ArchiveManifest,
  type ArchiveRow,
  type ArchiveTable,
  type ArchiveTarget,
  type ArchiveView,
  type SampleStep,
} from "./format.js";

/** Rows per insert: one revertible op each, well inside what one request should carry. */
export const IMPORT_ROWS_PER_WRITE = 5_000;
/** Row pages per link: the actor's batch cap, one mutation each. */
export const IMPORT_PAGES_PER_WRITE = DATABASE_MAX_ROWS_PER_WRITE;

/**
 * An archive read whole and checked, ready to import. What it holds is read again from the zip
 * when the import writes it, so the zip's bytes must stay as they were until the import is done.
 */
export interface ArchiveContents {
  manifest: ArchiveManifest;
  index: ArchiveIndex;
  /** By body path: whether the body holds an archive link or image, or a mention, which the import rewrites. */
  rewrites: Map<string, boolean>;
  /** The type of each image the bodies show, by path. */
  media: Map<string, SafeImageMime>;
  /** A body's Markdown, cleaned as an imported file is. */
  body(path: string): Promise<string>;
  /** A table's rows, by its rows file. */
  rows(file: string): Promise<ArchiveRow[]>;
  /** An image's bytes, by path. */
  image(path: string): Promise<Uint8Array>;
}

function refuse(at: string, reason: string): never {
  throw new ArchiveError(at, reason);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

async function readText(zip: ZipArchive, path: string, max: number): Promise<string> {
  if (!zip.files.has(path)) refuse(path, `is missing; ${MANIFEST_NAME} names it`);
  const data = await zip.read(path, max);
  try {
    // The decoder drops a byte order mark.
    return UTF8.decode(data);
  } catch {
    return refuse(path, "is not UTF-8 text");
  }
}

/** As normalizeImportedMarkdown cleans a file: \n line ends, and no C0 control Postgres TEXT refuses. */
function cleanBody(file: string): string {
  // eslint-disable-next-line no-control-regex
  const text = file.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

type Doc = ReturnType<typeof markdownToDoc>;

/** Every link and image destination in a document, and whether it holds a mention. */
function destinations(doc: Doc): { links: string[]; images: string[]; mentions: boolean } {
  const out = { links: [] as string[], images: [] as string[], mentions: false };
  doc.descendants((node) => {
    if (node.type.name === "image") out.images.push(String(node.attrs.src ?? ""));
    if (node.type.name === "mention") out.mentions = true;
    for (const mark of node.marks) if (mark.type.name === "link") out.links.push(String(mark.attrs.href ?? ""));
  });
  return out;
}

/** Where an archive link in the body at `from` leads; refused when it leads nowhere in the archive. */
function linkTarget(from: string, href: string, index: ArchiveIndex, rowKeys: Map<string, Set<string>>): ArchiveTarget {
  const resolved = resolveArchiveHref(from, href);
  if (!resolved.ok) return refuse(from, `link "${href}" ${resolved.reason}`);
  const { path, table, view, row } = resolved.target;
  const fragment = table !== undefined || view !== undefined || row !== undefined;
  if (index.bodies.has(path) || index.folders.has(path)) {
    if (fragment) refuse(from, `link "${href}": only a database link takes table, view or row`);
    return resolved.target;
  }
  const db = index.databases.get(path);
  if (!db) return refuse(from, `link "${href}" leads to "${path}", which is not in the archive`);
  const t = table === undefined ? db.tables[0] : db.tables.find((x) => x.name === table);
  if (fragment && !t) refuse(from, `link "${href}": database "${path}" has no ${table === undefined ? "table" : `table "${table}"`}`);
  if (view !== undefined && !t!.views.some((v) => v.name === view)) refuse(from, `link "${href}": table "${t!.name}" has no view "${view}"`);
  if (row !== undefined && !rowKeys.get(t!.file)?.has(row)) refuse(from, `link "${href}": table "${t!.name}" has no row "${row}"`);
  return resolved.target;
}

/** The media file an archive image in the body at `from` shows. */
function imagePath(from: string, src: string, zip: ZipArchive): string {
  const resolved = resolveArchiveHref(from, src);
  if (!resolved.ok) return refuse(from, `image "${src}" ${resolved.reason}`);
  const { path, ...fragment } = resolved.target;
  if (Object.keys(fragment).length > 0 || !parseMediaPath(path)) refuse(from, `image "${src}" leads to "${path}", which is no media/<sha256>.<ext> file`);
  if (!zip.files.has(path)) refuse(from, `shows ${path}, which is missing`);
  return path;
}

function leavesOf(node: ArchiveFilterNode | null): Array<{ column: string; value?: unknown }> {
  if (!node) return [];
  if ("and" in node) return node.and.flatMap(leavesOf);
  if ("or" in node) return node.or.flatMap(leavesOf);
  return [node];
}

/** What a Mac's Compress puts beside the files it packs. */
const MAC_FORKS = "__MACOSX/";

/**
 * Every entry a zip without Zip64 can hold. Folder entries, and the copy of each file's and
 * folder's attributes a Mac's Compress adds under `__MACOSX/`, count here; the files an import
 * reads are held to the archive's caps once archiveRoot has left those aside.
 */
const ZIP_MAX_ENTRIES = 0xffff;

/**
 * The archive's top: the zip's own, or the one folder holding every file when the zip wraps an
 * unzipped archive, as a Mac's Compress does with the folder a download was unzipped into.
 * Beside that folder, `__MACOSX/` and names starting with a dot are left aside.
 */
function archiveRoot(zip: ZipArchive): ZipArchive {
  if (zip.files.has(MANIFEST_NAME)) return zip;
  const names = [...zip.files.keys()].filter((name) => !name.startsWith(MAC_FORKS) && !name.startsWith("."));
  const top = names[0]?.split("/")[0];
  const prefix = `${top}/`;
  if (top === undefined || !zip.files.has(`${prefix}${MANIFEST_NAME}`) || !names.every((name) => name.startsWith(prefix))) return zip;
  const files = new Map<string, ZipEntryInfo>();
  for (const [name, info] of zip.files) if (name.startsWith(prefix)) files.set(name.slice(prefix.length), { ...info, name: name.slice(prefix.length) });
  return { files, read: (name, maxBytes) => zip.read(`${prefix}${name}`, maxBytes) };
}

/**
 * Read and check a zipped archive whole: the zip's caps, the manifest, every
 * file it names, every row, every link and image, and each image's bytes
 * against its name. Only the files the manifest names are read. Throws an
 * ArchiveError naming the file (and for the manifest, the field) at fault.
 */
export async function readArchive(bytes: Uint8Array, limits: { maxImageBytes: number }): Promise<ArchiveContents> {
  try {
    return await readZippedArchive(bytes, Math.min(limits.maxImageBytes, ARCHIVE_MAX_MEDIA_BYTES));
  } catch (err) {
    if (err instanceof ZipError) throw new ArchiveError(err.entry ?? "", err.reason);
    throw err;
  }
}

async function readZippedArchive(bytes: Uint8Array, maxImageBytes: number): Promise<ArchiveContents> {
  if (bytes.byteLength > ARCHIVE_MAX_BYTES) refuse("", `the archive is larger than ${ARCHIVE_MAX_BYTES} bytes`);
  const zip = archiveRoot(
    openZip(bytes, {
      maxEntries: ZIP_MAX_ENTRIES,
      maxEntryBytes: Math.max(ARCHIVE_MAX_MANIFEST_BYTES, ARCHIVE_MAX_BODY_BYTES, ARCHIVE_MAX_TABLE_FILE_BYTES, ARCHIVE_MAX_MEDIA_BYTES),
      // Held to ARCHIVE_MAX_UNPACKED_BYTES below, counting only the files the archive holds.
      maxTotalBytes: Infinity,
      // No cap on how tightly a file packs: an export deflates a repetitive body or rows file far past
      // any ratio, and the caps bound what an archive unpacks to.
      maxRatio: Infinity,
    }),
  );
  // Counted as an export counts them, and as the format's caps do: files, not folders or a Mac's forks.
  if (zip.files.size > ARCHIVE_MAX_ENTRIES) refuse("", `the archive holds ${zip.files.size} files, more than ${ARCHIVE_MAX_ENTRIES}`);
  let unpacked = 0;
  for (const info of zip.files.values()) unpacked += info.size;
  if (unpacked > ARCHIVE_MAX_UNPACKED_BYTES) refuse("", `the files unpack to more than ${ARCHIVE_MAX_UNPACKED_BYTES} bytes`);
  if (!zip.files.has(MANIFEST_NAME)) refuse(MANIFEST_NAME, "is missing, so this is not a Stuga workspace archive");
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(zip, MANIFEST_NAME, ARCHIVE_MAX_MANIFEST_BYTES));
  } catch (err) {
    if (err instanceof SyntaxError) refuse(MANIFEST_NAME, "is not JSON");
    throw err;
  }
  let manifest: ArchiveManifest;
  try {
    manifest = parseManifest(raw);
  } catch (err) {
    if (err instanceof ArchiveError) throw new ArchiveError(err.at ? `${MANIFEST_NAME}: ${err.at}` : MANIFEST_NAME, err.reason);
    throw err;
  }
  const index = archiveIndex(manifest);
  const rowsOf = async (file: string): Promise<ArchiveRow[]> =>
    parseTableRows(await readText(zip, file, ARCHIVE_MAX_TABLE_FILE_BYTES), index.tables.get(file)!.table);
  const bodyOf = async (path: string): Promise<string> => cleanBody(await readText(zip, path, ARCHIVE_MAX_BODY_BYTES));

  // Only the keys stay: the rows are parsed again, a table at a time, as they are written.
  const rowKeys = new Map<string, Set<string>>();
  let rowCount = 0;
  for (const [file, { table }] of index.tables) {
    const keys = new Set((await rowsOf(file)).map((r) => r.key));
    rowCount += keys.size;
    if (rowCount > ARCHIVE_MAX_ROWS) refuse(file, `takes the archive past ${ARCHIVE_MAX_ROWS} rows`);
    for (const page of table.pages) if (!keys.has(page.row)) refuse(page.file, `is the page of row "${page.row}", which ${file} does not hold`);
    for (const view of table.views) {
      for (const leaf of leavesOf(view.filter)) {
        if (leaf.column === "_id" && typeof leaf.value === "string" && !keys.has(leaf.value)) {
          refuse(file, `view "${view.name}" filters on row "${leaf.value}", which the file does not hold`);
        }
      }
    }
    rowKeys.set(file, keys);
  }

  const schema = getStugaSchema();
  const rewrites = new Map<string, boolean>();
  const shown = new Set<string>();
  for (const path of index.bodies.keys()) {
    const found = destinations(markdownToDoc(await bodyOf(path), schema));
    let rewrite = found.mentions;
    for (const href of found.links) {
      if (!isArchiveHref(href)) continue;
      linkTarget(path, href, index, rowKeys);
      rewrite = true;
    }
    for (const src of found.images) {
      if (!isArchiveHref(src)) continue;
      shown.add(imagePath(path, src, zip));
      rewrite = true;
    }
    rewrites.set(path, rewrite);
  }

  const media = new Map<string, SafeImageMime>();
  for (const path of shown) {
    const named = parseMediaPath(path)!;
    const size = zip.files.get(path)!.size;
    if (size > maxImageBytes) refuse(path, `is ${size} bytes; this node takes images up to ${maxImageBytes}`);
    let image: { bytes: Uint8Array; mime: SafeImageMime };
    try {
      image = validateImageBytes(await zip.read(path, maxImageBytes), maxImageBytes);
    } catch (err) {
      if (err instanceof MediaValidationError) return refuse(path, err.message);
      throw err;
    }
    if (image.mime !== named.mime) refuse(path, `is ${image.mime}, not the type its name says`);
    if (createHash("sha256").update(image.bytes).digest("hex") !== named.sha256) refuse(path, "is named for other bytes than it holds");
    media.set(path, image.mime);
  }
  return { manifest, index, rewrites, media, body: bodyOf, rows: rowsOf, image: (path) => zip.read(path, maxImageBytes) };
}

// ---- Writing ---------------------------------------------------------------------------------

export interface ImportedTable {
  tableId: string;
  /** Column ids by column name. */
  columns: Map<string, string>;
  /** View ids by view name. */
  views: Map<string, string>;
  /** Row ids by row key. */
  rows: Map<string, string>;
}

/** Where each archive item landed. */
export interface ImportedIds {
  folders: Map<string, string>;
  /** Documents and row pages, by body path. */
  docs: Map<string, string>;
  databases: Map<string, { docId: string; tables: Map<string, ImportedTable> }>;
}

export interface ImportOptions {
  /** The archive came from where the node itself fetched and checked it: a published sample. Only then do its sample steps run. */
  trusted?: boolean;
  /** Replays a trusted archive's sample steps, after the comments and before any document's settings. */
  sampleSteps?: (steps: SampleStep[], ids: ImportedIds) => Promise<void>;
  /** Once aborted, the import stops before its next step. */
  signal?: AbortSignal;
}

export interface ImportResult {
  ids: ImportedIds;
  startDocId: string | null;
  counts: { folders: number; docs: number; databases: number; pages: number; rows: number; images: number; comments: number };
}

/** An import that stopped at `step`, which names the item it was writing. */
export class ImportStepError extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ImportStepError";
  }
}

const columnInput = (c: ArchiveColumn): ColumnInput => ({
  name: c.name,
  type: c.type,
  ...(c.choices ? { choices: c.choices } : {}),
  ...(c.description ? { description: c.description } : {}),
});

/** The new table's column ids by the archive's names, which it was created with in order. */
function columnIds(created: TableSchema, columns: ArchiveColumn[]): Map<string, string> {
  const inOrder = [...created.columns].sort((a, b) => a.position - b.position);
  if (inOrder.length !== columns.length || inOrder.some((c, i) => c.display !== columns[i]!.name)) {
    throw new Error(`table "${created.display}" was created with other columns than the archive names`);
  }
  return new Map(columns.map((c, i) => [c.name, inOrder[i]!.column_id]));
}

/** A view as the new table names it: columns by id, and `_id` values as the new rows' ids. */
function viewInput(view: ArchiveView, table: ImportedTable): ViewInput {
  const column = (name: string): string => (ROW_FIELDS.has(name) ? name : table.columns.get(name)!);
  const filter = (node: ArchiveFilterNode): RowFilterNode => {
    if ("and" in node) return { and: node.and.map(filter) };
    if ("or" in node) return { or: node.or.map(filter) };
    if (node.value === undefined) return { column_id: column(node.column), op: node.op };
    const value = node.column === "_id" ? table.rows.get(String(node.value))! : typeof node.value === "boolean" ? Number(node.value) : node.value;
    return { column_id: column(node.column), op: node.op, value };
  };
  return {
    name: view.name,
    kind: view.kind,
    position: view.position,
    filter: view.filter === null ? null : filter(view.filter),
    sorts: view.sorts.map((s) => ({ column_id: column(s.column), dir: s.dir })),
    group_by: view.group_by === null ? null : column(view.group_by),
    hidden_columns: view.hidden_columns.map(column),
    config: view.config,
  };
}

const importedComment = (c: ArchiveComment): ImportedComment => ({
  num: c.num,
  parentNum: c.parent,
  authorName: c.author_name,
  body: c.body,
  anchorQuote: c.quote,
  resolved: c.resolved,
  createdAt: c.created_at,
});

/** The settings an item carries that a new document does not already have. */
function stateOf(item: ArchiveDocSettings): DocState {
  return {
    ...(item.agent_instructions ? { agent_instructions: item.agent_instructions } : {}),
    ...(item.search_hidden ? { search_hidden: true } : {}),
    ...(item.agent_mode === "auto" ? { agent_mode: "auto" as const } : {}),
    ...(item.locked ? { locked: true } : {}),
  };
}

/** `markdown` with every archive link and image pointed at the node, and each mention as plain `@name` text. */
function pointAtNode(markdown: string, link: (href: string) => string, image: (src: string) => string): string {
  const schema = getStugaSchema();
  const walk = (node: Doc): Doc => {
    const marks = node.marks.map((m) => (m.type.name === "link" ? m.type.create({ ...m.attrs, href: link(String(m.attrs.href ?? "")) }) : m));
    if (node.isText) return node.mark(marks);
    // A mention names an account on the node it came from, which here could be anyone.
    if (node.type.name === "mention") return schema.text(`@${String(node.attrs.label ?? "")}`, marks);
    const children: Doc[] = [];
    node.forEach((child) => void children.push(walk(child)));
    const attrs = node.type.name === "image" ? { ...node.attrs, src: image(String(node.attrs.src ?? "")) } : node.attrs;
    return node.type.create(attrs, children, marks);
  };
  return docToMarkdown(walk(markdownToDoc(markdown, schema)));
}

/** Where an archive link lands on the node, in the forms the web app writes its own links. */
function nodeHref(target: ArchiveTarget, index: ArchiveIndex, ids: ImportedIds): string {
  const enc = encodeURIComponent;
  const body = index.bodies.get(target.path);
  if (body?.kind === "doc") return `/doc/${enc(ids.docs.get(target.path)!)}`;
  if (body?.kind === "page") {
    const db = ids.databases.get(body.database.path)!;
    const table = db.tables.get(body.table.name)!;
    const ref = `${db.docId}.${table.tableId}.${table.rows.get(body.item.row)!}`;
    return `/doc/${enc(ids.docs.get(target.path)!)}?row=${enc(ref)}`;
  }
  if (index.folders.has(target.path)) {
    const chain: string[] = [];
    for (let path: string | null = target.path; path !== null; path = index.folders.get(path)!.parent) chain.unshift(enc(ids.folders.get(path)!));
    return `/?folder=${chain.join("/")}`;
  }
  const db = ids.databases.get(target.path)!;
  if (target.table === undefined && target.view === undefined && target.row === undefined) return `/doc/${enc(db.docId)}`;
  const tables = index.databases.get(target.path)!.tables;
  const table = db.tables.get(target.table ?? tables[0]!.name)!;
  const params = [`table=${enc(table.tableId)}`];
  if (target.view !== undefined) params.push(`view=${enc(table.views.get(target.view)!)}`);
  if (target.row !== undefined) params.push(`row=${enc(table.rows.get(target.row)!)}`);
  return `/doc/${enc(db.docId)}?${params.join("&")}`;
}

/**
 * Write `contents` into the workspace `client` writes to. Throws an
 * ImportStepError at the first write that fails, or at the first step once
 * `opts.signal` is aborted; what landed before stays, for the caller to purge.
 */
export async function importArchive(client: ImportClient, contents: ArchiveContents, opts: ImportOptions = {}): Promise<ImportResult> {
  const { manifest, index } = contents;
  const ids: ImportedIds = { folders: new Map(), docs: new Map(), databases: new Map() };
  const counts: ImportResult["counts"] = { folders: 0, docs: 0, databases: 0, pages: 0, rows: 0, images: 0, comments: 0 };
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      opts.signal?.throwIfAborted();
      return await run();
    } catch (err) {
      throw err instanceof ImportStepError ? err : new ImportStepError(name, err);
    }
  };
  const parentOf = (item: { parent: string | null }): string | null => (item.parent === null ? null : ids.folders.get(item.parent)!);
  const databases = manifest.items.filter((item): item is ArchiveDatabase => item.kind === "database");

  if (manifest.workspace.agent_instructions) {
    await step("workspace instructions", () => client.setWorkspaceInstructions(manifest.workspace.agent_instructions));
  }

  for (const item of manifest.items) {
    if (item.kind !== "folder") continue;
    const input = { title: item.title, parentId: parentOf(item), agentInstructions: item.agent_instructions };
    ids.folders.set(item.path, await step(item.path, () => client.createFolder(input)));
    counts.folders++;
  }

  for (const db of databases) {
    await step(db.path, async () => {
      const [first] = db.tables;
      const created = await client.createDatabase({
        title: db.title,
        parentId: parentOf(db),
        // A database starts with a table; one the archive has none of goes again.
        table: first?.name ?? db.title,
        columns: first?.columns.map(columnInput) ?? [],
      });
      const tables = new Map<string, ImportedTable>();
      ids.databases.set(db.path, { docId: created.docId, tables });
      counts.databases++;
      if (!first) await client.deleteTable(created.docId, created.table.table_id);
      for (const [i, table] of db.tables.entries()) {
        const schema = i === 0 ? created.table : await client.createTable(created.docId, { display: table.name, columns: table.columns.map(columnInput) });
        const imported: ImportedTable = { tableId: schema.table_id, columns: columnIds(schema, table.columns), views: new Map(), rows: new Map() };
        tables.set(table.name, imported);
        await importRows(client, created.docId, table, await contents.rows(table.file), imported);
        counts.rows += imported.rows.size;
        for (const view of table.views) imported.views.set(view.name, await client.createView(created.docId, imported.tableId, viewInput(view, imported)));
      }
      await client.release(created.docId, "database");
    });
  }

  for (const db of databases) {
    const { docId, tables } = ids.databases.get(db.path)!;
    for (const table of db.tables) {
      const imported = tables.get(table.name)!;
      for (let at = 0; at < table.pages.length; at += IMPORT_PAGES_PER_WRITE) {
        const batch = table.pages.slice(at, at + IMPORT_PAGES_PER_WRITE);
        const pages = batch.map((page) => ({ rowId: imported.rows.get(page.row)!, title: page.title }));
        const pageIds = await step(`${table.file}: row pages`, () => client.openRowPages(docId, imported.tableId, pages));
        batch.forEach((page, i) => ids.docs.set(page.file, pageIds[i]!));
        counts.pages += batch.length;
      }
    }
    await client.release(docId, "database");
  }

  for (const item of manifest.items) {
    if (item.kind !== "doc") continue;
    ids.docs.set(item.path, await step(item.path, () => client.createDoc({ title: item.title, parentId: parentOf(item) })));
    counts.docs++;
  }

  // The start document is written last, so it is the one most recently changed.
  const uploaded = new Map<string, string>();
  const order = [...index.bodies.keys()].filter((path) => path !== manifest.start);
  if (manifest.start) order.push(manifest.start);
  for (const path of order) {
    const docId = ids.docs.get(path)!;
    await step(path, async () => {
      let markdown = await contents.body(path);
      if (markdown.trim() === "") return;
      if (contents.rewrites.get(path)) {
        // Each image is uploaded once, into the first document that shows it; the others show the same stored bytes.
        for (const src of destinations(markdownToDoc(markdown, getStugaSchema())).images) {
          if (!isArchiveHref(src)) continue;
          const media = resolveArchiveHref(path, src);
          if (!media.ok || uploaded.has(media.target.path)) continue;
          const bytes = await contents.image(media.target.path);
          uploaded.set(media.target.path, await client.uploadImage(docId, bytes, contents.media.get(media.target.path)!));
          counts.images++;
        }
        const target = (href: string): ArchiveTarget | null => {
          if (!isArchiveHref(href)) return null;
          const resolved = resolveArchiveHref(path, href);
          return resolved.ok ? resolved.target : null;
        };
        markdown = pointAtNode(
          markdown,
          (href) => {
            const to = target(href);
            return to ? nodeHref(to, index, ids) : href;
          },
          (src) => {
            const to = target(src);
            return to ? mediaUrl(docId, uploaded.get(to.path)!) : src;
          },
        );
      }
      await client.seedBody(docId, markdown);
    });
    await client.release(docId, "prose");
  }

  for (const [path, body] of index.bodies) {
    if (body.item.title_source === "user") await step(path, () => client.setTitle(ids.docs.get(path)!, body.item.title));
  }

  const commented: Array<[string, string, ArchiveComment[] | undefined]> = [
    ...[...index.bodies].map(([path, body]): [string, string, ArchiveComment[] | undefined] => [path, ids.docs.get(path)!, body.item.comments]),
    ...databases.map((db): [string, string, ArchiveComment[] | undefined] => [db.path, ids.databases.get(db.path)!.docId, db.comments]),
  ];
  for (const [path, docId, comments] of commented) {
    if (!comments?.length) continue;
    await step(`${path}: comments`, () => client.importComments(docId, comments.map(importedComment)));
    counts.comments += comments.length;
  }

  const steps = manifest.sample?.steps ?? [];
  if (opts.trusted && opts.sampleSteps && steps.length > 0) await step("sample steps", () => opts.sampleSteps!(steps, ids));

  // Pages and documents before databases, so no database is locked while anything of it is still being written.
  type Settled = [string, string, "prose" | "database", ArchiveDocSettings];
  const settled: Settled[] = [
    ...[...index.bodies].map(([path, body]): Settled => [path, ids.docs.get(path)!, "prose", body.item]),
    ...databases.map((db): Settled => [db.path, ids.databases.get(db.path)!.docId, "database", db]),
  ];
  for (const [path, docId, docType, item] of settled) {
    const state = stateOf(item);
    if (Object.keys(state).length === 0) continue;
    await step(`${path}: settings`, () => client.setDocState(docId, state));
    // A lock reaches the actor, which opens it anew.
    await client.release(docId, docType);
  }

  // Again for every item: a sample's proposal since the last release opened it anew.
  for (const docId of ids.docs.values()) await client.release(docId, "prose");
  for (const { docId } of ids.databases.values()) await client.release(docId, "database");

  return { ids, startDocId: manifest.start ? ids.docs.get(manifest.start)! : null, counts };
}

/** A table's rows, IMPORT_ROWS_PER_WRITE at a time, keyed by the new column ids; each row's new id lands in `imported.rows`. */
async function importRows(client: ImportClient, databaseId: string, table: ArchiveTable, rows: ArchiveRow[], imported: ImportedTable): Promise<void> {
  for (let at = 0; at < rows.length; at += IMPORT_ROWS_PER_WRITE) {
    const chunk = rows.slice(at, at + IMPORT_ROWS_PER_WRITE);
    const cells = chunk.map((row) => {
      const out: Record<string, RowValue> = {};
      for (const [name, value] of Object.entries(row.values)) out[imported.columns.get(name)!] = value;
      return out;
    });
    const rowIds = await client.insertRows(databaseId, { table_id: imported.tableId, display: table.name }, cells);
    if (rowIds.length !== chunk.length) throw new Error(`${table.file}: ${chunk.length} rows sent, ${rowIds.length} ids back`);
    chunk.forEach((row, i) => imported.rows.set(row.key, rowIds[i]!));
  }
}

/**
 * Import `contents` into the workspace just provisioned for `account`, its
 * owner, as that person. Throws an ImportStepError naming the step that failed.
 */
export async function importWorkspaceArchive(
  account: AccountCtx,
  workspaceId: string,
  contents: ArchiveContents,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const ctx = await workspaceContextFor({ account, workspaces: null, readOnly: false }, workspaceId);
  if (!ctx) throw new ImportStepError("workspace", new Error("the importing person is not a member of the new workspace"));
  return importArchive(workspaceImportClient(ctx, { signal: opts.signal }), contents, opts);
}
