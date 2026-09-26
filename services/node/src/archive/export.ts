/**
 * Workspace export: what the exporting person can open, as a format v1 archive
 * (docs/workspace-archive.md). Planned first, so a workspace with more items, row pages, rows or
 * files than an archive holds, folders nested deeper, or a document with more comments or a
 * longer body, is refused before anything is sent; then written one entry at a time, with the
 * person's access read again before each: rows files, bodies read live from their actors with
 * links pointed into the archive, images copied into media/, and the manifest last, checked by
 * the same parser an import runs. A cap only the writing can find, such as the archive's size,
 * stops the export where it is passed, since no node would import the archive. Each actor is
 * released once the export is done with it, so a large workspace does not hold every store open.
 */
import { createHash } from "node:crypto";
import { principalsFrom, userPrincipal } from "@stuga/auth";
import { docToMarkdown, getStugaSchema, markdownToDoc } from "@stuga/crdt-ops";
import {
  getDoc,
  getFolderAncestors,
  getUsers,
  getWorkspace,
  listComments,
  listDocsWithCommentsOver,
  listExportDocs,
  listFolders,
  resolveHumanAuth,
  type DocRow,
  type FolderRow,
} from "@stuga/db";
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import { validateCellValue, validateSelectChoices } from "@stuga/protocol/databases/cells";
import { filterOpNeedsValue } from "@stuga/protocol/databases/filters";
import {
  DATABASE_MAX_COLUMN_DESCRIPTION_CHARS,
  DATABASE_MAX_DISPLAY_LENGTH,
  DATABASE_MAX_SELECT_CHOICES,
  DATABASE_ROWS_PAGE_MAX,
} from "@stuga/protocol/databases/limits";
import type { RowFilterNode, RowValue, TableSchema, ViewSpec } from "@stuga/protocol/databases/types";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import { UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";
import { SAMPLE_AGENT_ALIAS, SAMPLE_AGENT_NAME } from "@stuga/protocol/domain/workspaces";
import { readDocMarkdownWithProjection } from "../agents/edits.js";
import type { Ctx } from "../auth/context.js";
import { canReadDoc } from "../authz/authz.js";
import { callDatabaseActor, projectedSchema } from "../databases/gate.js";
import { releaseActor } from "../documents/access.js";
import { ZipWriter, type ZipSink } from "../lib/zip.js";
import { decodeBase64Image, mediaKey, sniffImageMime } from "../media/media.js";
import { VERSION } from "../version.js";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MAX_BODY_BYTES,
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_COMMENTS,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_FOLDER_DEPTH,
  ARCHIVE_MAX_ITEMS,
  ARCHIVE_MAX_MANIFEST_BYTES,
  ARCHIVE_MAX_MEDIA_BYTES,
  ARCHIVE_MAX_PAGES,
  ARCHIVE_MAX_ROWS,
  ARCHIVE_MAX_TABLE_FILE_BYTES,
  ARCHIVE_MAX_UNPACKED_BYTES,
  ARCHIVE_MAX_WORKSPACE_NAME_CHARS,
  ARCHIVE_RESERVED_NAMES,
  ARCHIVE_VERSION,
  COMMENT_MAX_AUTHOR_CHARS,
  COMMENT_MAX_BODY_CHARS,
  COMMENT_MAX_QUOTE_CHARS,
  MANIFEST_NAME,
  ROW_FIELDS,
  VIEW_CONFIG_MAX_BYTES,
  ArchiveError,
  archiveHref,
  archiveName,
  archiveNameRoom,
  archiveTitle,
  bodyFile,
  derivedTitle,
  formatTableRows,
  isRowKey,
  mediaPath,
  parseManifest,
  type ArchiveColumn,
  type ArchiveComment,
  type ArchiveDocSettings,
  type ArchiveFilterNode,
  type ArchiveItem,
  type ArchiveManifest,
  type ArchivePage,
  type ArchiveRow,
  type ArchiveSort,
  type ArchiveTable,
  type ArchiveTarget,
  type ArchiveView,
} from "./format.js";

type Doc = ReturnType<typeof markdownToDoc>;
type Mark = Doc["marks"][number];

/** An export this node will not write, answered with `status` before anything is sent. */
export class ExportRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ExportRefused";
  }
}

interface PlannedFolder {
  row: FolderRow;
  /** The nearest folder the exporter can read above it, or null at the top level. */
  parent: string | null;
  path: string;
}

interface PlannedTable {
  schema: TableSchema;
  archive: ArchiveTable;
  /** column_id → the archive's column; a select column's choices can grow by a value its cells hold. */
  columns: Map<string, ArchiveColumn>;
  /** Row id → the row's key, once the rows are written. */
  rowKeys: Map<string, string>;
  /** Row id → its page's doc_id, as the actor links them. */
  pageLinks: Map<string, string>;
  /** view_id → the view's name in the archive. */
  viewNames: Map<string, string>;
}

interface PlannedDatabase {
  doc: DocRow;
  parent: string | null;
  path: string;
  tables: PlannedTable[];
}

/** Everything an export will hold, named and placed, before any byte is sent. */
export interface ExportPlan {
  workspace: { name: string; agent_instructions: string };
  folders: PlannedFolder[];
  databases: PlannedDatabase[];
  /** Prose documents by doc_id, row pages included: every body the archive will hold. */
  docs: Map<string, DocRow>;
  /** Where each document sits: its nearest readable folder, or null at the top level. */
  placement: Map<string, string | null>;
  /** Folder paths by folder_id. */
  folderPaths: Map<string, string>;
  /** The names used in each folder, "" at the top, as archiveName keys them. */
  taken: Map<string, Set<string>>;
}

/** Documents read per page of the keyset walk. */
const DOC_PAGE = 500;
/** Names in a database's deepest path, its own folder's included: `<db>/pages/<row>.md`. */
const DATABASE_LEVELS = 3;
const PAGES_DIR = "pages";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---- Text as the manifest takes it ------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** At most `max` UTF-16 units, never half a surrogate pair. */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Multi-line text: control characters but tabs and line breaks dropped, half pairs replaced, at most `max`. */
function multiline(text: string, max: number): string {
  return clip(text.replace(CONTROL_BUT_LINES, "").replace(LONE_SURROGATE, "\ufffd"), max);
}

/** A one-line name with no space at either end: a title's rules, trimmed, else `fallback`. */
function oneLineName(text: string, max: number, fallback: string): string {
  return clip(archiveTitle(text).trim(), max).trim() || fallback;
}

const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, "gu");

/** A comment author's name as an archive takes it: one line, no direction marks, and "Unknown" when nothing of it shows. */
function authorLine(text: string): string {
  const name = oneLineName(text, COMMENT_MAX_AUTHOR_CHARS, "").replace(UNSAFE_TEXT_ALL, "").trim();
  return hasVisibleText(name) ? name : "Unknown";
}

/**
 * A table, column or view name unique ignoring case among `taken`, which it joins: two alike
 * names read `Name` and `Name (2)`, as archiveName tells files apart.
 */
function uniqueDisplay(raw: string, taken: Set<string>): string {
  const base = oneLineName(raw, DATABASE_MAX_DISPLAY_LENGTH, "Untitled");
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${clip(base, DATABASE_MAX_DISPLAY_LENGTH - suffix.length).trimEnd()}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

const instructionsOf = (text: string): string => multiline(text, MAX_AGENT_INSTRUCTIONS_CHARS);

const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * By title, ignoring case; items with alike titles oldest first, then by id, so a workspace's items
 * get the same names on every export.
 */
function byTitle<T extends { title: string; created: string; id: string }>(a: T, b: T): number {
  const [x, y] = [a.title.toLowerCase(), b.title.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  // Typed as text, but the node's client reads a time as a Date.
  const age = new Date(a.created).getTime() - new Date(b.created).getTime();
  if (age !== 0) return age;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The list `map` keeps under `key`, made on first use. */
function listIn<K, V>(map: Map<K, V[]>, key: K): V[] {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  return list;
}

function takenIn(plan: Pick<ExportPlan, "taken">, dir: string): Set<string> {
  let names = plan.taken.get(dir);
  if (!names) plan.taken.set(dir, (names = new Set(dir ? [] : ARCHIVE_RESERVED_NAMES)));
  return names;
}

// ---- Planning -----------------------------------------------------------------------------------

/**
 * Read what the caller can open and name every folder, database and table, so nothing past this
 * point can refuse the export. Documents are named once the rows show which are row pages.
 */
export async function planWorkspaceExport(ctx: Ctx): Promise<ExportPlan> {
  const workspace = await getWorkspace(ctx.sql, ctx.workspaceId);
  if (!workspace) throw new ExportRefused(404, "workspace not found");

  const readable = new Map((await listFolders(ctx.sql, ctx.principals, ctx.workspaceId)).map((f) => [f.folder_id, f]));
  const nearest = nearestReadableFolder(ctx, readable);

  const docs = new Map<string, DocRow>();
  const databaseRows: DocRow[] = [];
  for (let after: string | null = null; ; ) {
    const page = await listExportDocs(ctx.sql, ctx.principals, ctx.workspaceId, after, DOC_PAGE);
    for (const doc of page) {
      if (doc.doc_type === "database") databaseRows.push(doc);
      else docs.set(doc.doc_id, doc);
    }
    if (page.length < DOC_PAGE) break;
    after = page[page.length - 1]!.doc_id;
  }

  const plan: ExportPlan = {
    workspace: {
      name: oneLineName(workspace.name, ARCHIVE_MAX_WORKSPACE_NAME_CHARS, "Workspace"),
      agent_instructions: instructionsOf(workspace.agent_instructions),
    },
    folders: [],
    databases: [],
    docs,
    placement: new Map(),
    folderPaths: new Map(),
    taken: new Map(),
  };

  const folderParent = new Map<string, string | null>();
  for (const folder of readable.values()) folderParent.set(folder.folder_id, await nearest(folder.parent_id));
  for (const doc of [...docs.values(), ...databaseRows]) plan.placement.set(doc.doc_id, await nearest(doc.parent_id));

  const exported = new Set(databaseRows.map((d) => d.doc_id));
  const pageCandidates = [...docs.values()].filter((d) => d.page_of !== null && exported.has(d.page_of)).length;
  const items = readable.size + databaseRows.length + docs.size - pageCandidates;
  if (items > ARCHIVE_MAX_ITEMS) {
    const what = "folders, documents and databases you can open";
    throw new ExportRefused(413, `this workspace holds ${items} ${what}; an archive holds at most ${ARCHIVE_MAX_ITEMS}`);
  }
  if (pageCandidates > ARCHIVE_MAX_PAGES) {
    throw new ExportRefused(413, `this workspace holds ${pageCandidates} row pages you can open; an archive holds at most ${ARCHIVE_MAX_PAGES}`);
  }
  const exporting = new Map([...docs.values(), ...databaseRows].map((d) => [d.doc_id, d]));
  const crowded = (await listDocsWithCommentsOver(ctx.sql, ctx.workspaceId, ARCHIVE_MAX_COMMENTS)).find((c) => exporting.has(c.doc_id));
  if (crowded) {
    const title = exporting.get(crowded.doc_id)!.title;
    throw new ExportRefused(413, `"${title}" has ${crowded.comments} comments; an archive carries at most ${ARCHIVE_MAX_COMMENTS} on one document`);
  }

  // How many names deep each folder goes, itself included, so its name leaves room for the paths below it.
  const levels = new Map<string, number>();
  const deepen = (folder: string | null, below: number): void => {
    for (let at = folder, depth = below + 1; at !== null; at = folderParent.get(at) ?? null, depth++) {
      if ((levels.get(at) ?? 1) >= depth) return;
      levels.set(at, depth);
    }
  };
  for (const id of readable.keys()) deepen(folderParent.get(id) ?? null, 1);
  for (const doc of docs.values()) deepen(plan.placement.get(doc.doc_id) ?? null, 1);
  for (const db of databaseRows) deepen(plan.placement.get(db.doc_id) ?? null, DATABASE_LEVELS);

  // Folders top-down, so each parent's path is known before its children are named.
  const children = new Map<string | null, FolderRow[]>();
  for (const folder of readable.values()) listIn(children, folderParent.get(folder.folder_id) ?? null).push(folder);
  const nameFolders = (parent: string | null, dir: string): void => {
    const kids = (children.get(parent) ?? []).map((row) => ({ row, title: row.title, created: row.created_at, id: row.folder_id })).sort(byTitle);
    for (const { row } of kids) {
      const room = archiveNameRoom(dir, levels.get(row.folder_id) ?? 1);
      const path = joinPath(dir, archiveName(archiveTitle(row.title), takenIn(plan, dir), "", room));
      plan.folders.push({ row, parent, path });
      plan.folderPaths.set(row.folder_id, path);
      nameFolders(row.folder_id, path);
    }
  };
  nameFolders(null, "");
  const deep = plan.folders.find((f) => f.path.split("/").length > ARCHIVE_MAX_FOLDER_DEPTH);
  if (deep) {
    const depth = deep.path.split("/").length;
    throw new ExportRefused(413, `the folder "${deep.row.title}" is ${depth} folders deep; an archive holds folders at most ${ARCHIVE_MAX_FOLDER_DEPTH} deep`);
  }

  const sortedDatabases = databaseRows.map((doc) => ({ doc, title: doc.title, created: doc.created_at, id: doc.doc_id })).sort(byTitle);
  for (const { doc } of sortedDatabases) {
    const schema = await projectedSchema(ctx, doc.doc_id);
    await releaseActor(ctx.env, doc.doc_id, "database");
    if (!schema) throw new ExportRefused(502, `could not read the database "${doc.title}"`);
    const parent = plan.placement.get(doc.doc_id) ?? null;
    const dir = parent === null ? "" : plan.folderPaths.get(parent)!;
    const path = joinPath(dir, archiveName(archiveTitle(doc.title), takenIn(plan, dir), "", archiveNameRoom(dir, DATABASE_LEVELS)));
    const tableNames = new Set<string>();
    const tables = schema.tables.filter((t) => !t.pending).map((t) => planTable(plan, t, path, tableNames));
    plan.databases.push({ doc, parent, path, tables });
  }

  const tables = plan.databases.flatMap((db) => db.tables);
  const rows = tables.reduce((n, t) => n + t.schema.row_count, 0);
  if (rows > ARCHIVE_MAX_ROWS) throw new ExportRefused(413, `this workspace holds ${rows} rows you can open; an archive holds at most ${ARCHIVE_MAX_ROWS}`);
  // A body per document and row page, a rows file per table, and the manifest; images come on top.
  const files = docs.size + tables.length + 1;
  if (files > ARCHIVE_MAX_ENTRIES) throw new ExportRefused(413, `this workspace would take ${files} files; an archive holds at most ${ARCHIVE_MAX_ENTRIES}`);

  // Every body read once ahead, so one longer than an import takes is named before anything is sent.
  let unpacked = 0;
  for (const doc of docs.values()) {
    const size = await bodySize(ctx, doc);
    if (size > ARCHIVE_MAX_BODY_BYTES) {
      throw new ExportRefused(413, `"${doc.title}" would be ${size} bytes of Markdown; an archive takes at most ${ARCHIVE_MAX_BODY_BYTES} for one document`);
    }
    unpacked += size;
  }
  if (unpacked > ARCHIVE_MAX_UNPACKED_BYTES) {
    throw new ExportRefused(413, `this workspace's documents come to ${unpacked} bytes; an archive unpacks to at most ${ARCHIVE_MAX_UNPACKED_BYTES}`);
  }
  return plan;
}

/** Where every image of a body is measured as pointing: a media/ file's name, whichever it is. */
const MEDIA_STAND_IN = mediaPath("0".repeat(64), "image/png");

/**
 * The size of a document's body file as the export writes it, but for where its links lead,
 * which is known only once the rows are written: each link is measured as it points on this node.
 */
async function bodySize(ctx: Ctx, doc: DocRow): Promise<number> {
  const markdown = await liveMarkdown(ctx, doc);
  if (markdown === "") return 0;
  const asOnNode = (href: string): string | null => (href === "" || href.startsWith("mention:") ? null : href);
  const measured = rewritten(markdownToDoc(markdown, getStugaSchema()), asOnNode, () => MEDIA_STAND_IN);
  return utf8(bodyFile(docToMarkdown(measured))).byteLength;
}

/** Where a document or folder under `parentId` goes: that folder, or the nearest one above it the exporter can read. */
function nearestReadableFolder(ctx: Ctx, readable: Map<string, FolderRow>): (parentId: string | null) => Promise<string | null> {
  const memo = new Map<string, string | null>();
  return async (parentId) => {
    if (parentId === null || readable.has(parentId)) return parentId;
    const known = memo.get(parentId);
    if (known !== undefined) return known;
    // Root first, the unreadable folder itself last.
    const chain = await getFolderAncestors(ctx.sql, parentId, ctx.workspaceId);
    const found = chain.reverse().find((f) => readable.has(f.folder_id))?.folder_id ?? null;
    memo.set(parentId, found);
    return found;
  };
}

function planTable(plan: ExportPlan, schema: TableSchema, dbPath: string, tableNames: Set<string>): PlannedTable {
  const name = uniqueDisplay(schema.display || schema.name, tableNames);
  const file = joinPath(dbPath, archiveName(name, takenIn(plan, dbPath), ".jsonl", archiveNameRoom(dbPath, 1)));
  // A column may not be named like a row's own fields.
  const columnNames = new Set([...ROW_FIELDS].map((f) => f.toLowerCase()));
  const columns = new Map<string, ArchiveColumn>();
  for (const spec of schema.columns) {
    if (spec.pending) continue;
    const column: ArchiveColumn = { name: uniqueDisplay(spec.display || spec.name, columnNames), type: spec.type };
    if (spec.type === "single_select") {
      const choices = validateSelectChoices(spec.options?.choices);
      // A select column without a usable choice list keeps its cells as text.
      if (choices.ok) column.choices = [...choices.choices];
      else column.type = "text";
    }
    const description = multiline(spec.description ?? "", DATABASE_MAX_COLUMN_DESCRIPTION_CHARS).trim();
    if (description) column.description = description;
    columns.set(spec.column_id, column);
  }
  return {
    schema,
    archive: { name, file, columns: [...columns.values()], views: [], pages: [] },
    columns,
    rowKeys: new Map(),
    pageLinks: new Map(),
    viewNames: new Map(),
  };
}

// ---- Writing ------------------------------------------------------------------------------------

type LinkTarget = { kind: "body"; path: string } | { kind: "database"; db: PlannedDatabase };

interface WriteState {
  /** The exporter's context, their reach read again before each item is written (currentReach). */
  ctx: Ctx;
  plan: ExportPlan;
  zip: ZipWriter;
  /** Rows written so far, across every table. */
  rows: number;
  /** doc_id → where a link to it leads in the archive. */
  targets: Map<string, LinkTarget>;
  /** A stored image's hash → its media path, or null when it cannot be exported. */
  media: Map<string, Promise<string | null>>;
  /** Media paths already written. */
  written: Set<string>;
  /** A comment author → the name the archive gives them. */
  authors: Map<string, string>;
  /** Where a link to this node points once it leaves the archive. */
  origin: string;
  /** Every origin a link to this node may have been copied from. */
  origins: Set<string>;
}

interface Body {
  doc: DocRow;
  /** Its `.md` path. */
  path: string;
}

/**
 * Write the planned export into `sink` as a whole archive, one entry at a time, the manifest last.
 * Throws where the archive would pass a cap an import holds it to, and when the manifest would not
 * pass format v1, which is a bug here.
 */
export async function writeWorkspaceExport(ctx: Ctx, plan: ExportPlan, sink: ZipSink): Promise<void> {
  const zip = new ZipWriter(sink, { maxEntries: ARCHIVE_MAX_ENTRIES, maxTotalBytes: ARCHIVE_MAX_UNPACKED_BYTES, maxBytes: ARCHIVE_MAX_BYTES });
  const state: WriteState = {
    ctx,
    plan,
    zip,
    rows: 0,
    targets: new Map(),
    media: new Map(),
    written: new Set(),
    authors: new Map(),
    origin: new URL(ctx.env.publicOrigin).origin,
    origins: new Set([ctx.env.publicOrigin, ...ctx.env.extraOrigins].map((o) => new URL(o).origin)),
  };

  // Rows first: which documents are row pages shows only in the rows. A page sits in its
  // database's pages/, named for its row; a page no row links to is an ordinary document.
  const bodies: Body[] = [];
  const pagesOf = new Map<PlannedTable, Array<{ page: Body; key: string }>>();
  for (const db of plan.databases) {
    state.targets.set(db.doc.doc_id, { kind: "database", db });
    const dir = `${db.path}/${PAGES_DIR}`;
    for (const table of db.tables) {
      await writeRows(state, db, table);
      table.archive.views = archiveViews(table);
      const pages: Array<{ page: Body; key: string }> = [];
      for (const [rowId, docId] of table.pageLinks) {
        const doc = plan.docs.get(docId);
        if (!doc || doc.page_of !== db.doc.doc_id || state.targets.has(docId)) continue;
        const key = table.rowKeys.get(rowId)!;
        const page = { doc, path: joinPath(dir, archiveName(key, takenIn(plan, dir), ".md", archiveNameRoom(dir, 1))) };
        pages.push({ page, key });
        bodies.push(page);
        state.targets.set(docId, { kind: "body", path: page.path });
      }
      pagesOf.set(table, pages);
    }
    await releaseActor(ctx.env, db.doc.doc_id, "database");
  }

  const docsIn = new Map<string | null, Body[]>();
  const loose = [...plan.docs.values()]
    .filter((d) => !state.targets.has(d.doc_id))
    .map((doc) => ({ doc, title: doc.title, created: doc.created_at, id: doc.doc_id }));
  for (const { doc } of loose.sort(byTitle)) {
    const parent = plan.placement.get(doc.doc_id) ?? null;
    const dir = parent === null ? "" : plan.folderPaths.get(parent)!;
    const body = { doc, path: joinPath(dir, archiveName(archiveTitle(doc.title), takenIn(plan, dir), ".md", archiveNameRoom(dir, 1))) };
    listIn(docsIn, parent).push(body);
    bodies.push(body);
    state.targets.set(doc.doc_id, { kind: "body", path: body.path });
  }

  const settings = new Map<string, ArchiveDocSettings>();
  for (const body of bodies) settings.set(body.path, await writeBody(state, body));
  for (const [table, pages] of pagesOf) {
    table.archive.pages = pages.map(({ page, key }): ArchivePage => ({ row: key, file: page.path, ...settings.get(page.path)! }));
  }

  const items: ArchiveItem[] = [];
  const databasesIn = new Map<string | null, PlannedDatabase[]>();
  for (const db of plan.databases) listIn(databasesIn, db.parent).push(db);
  const foldersIn = new Map<string | null, PlannedFolder[]>();
  for (const folder of plan.folders) listIn(foldersIn, folder.parent).push(folder);
  // Each folder before what it holds.
  const list = async (parent: string | null): Promise<void> => {
    const at = parent === null ? null : plan.folderPaths.get(parent)!;
    for (const folder of foldersIn.get(parent) ?? []) {
      const { title, agent_instructions } = folder.row;
      items.push({ kind: "folder", path: folder.path, parent: at, title: archiveTitle(title), agent_instructions: instructionsOf(agent_instructions) });
      await list(folder.row.folder_id);
    }
    for (const body of docsIn.get(parent) ?? []) items.push({ kind: "doc", path: body.path, parent: at, ...settings.get(body.path)! });
    for (const db of databasesIn.get(parent) ?? []) {
      await currentReach(state);
      const own = await docSettings(state, db.doc, archiveTitle(db.doc.title));
      items.push({ kind: "database", path: db.path, parent: at, ...own, tables: db.tables.map((t) => t.archive) });
    }
  };
  await list(null);

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    generator: `stuga ${VERSION}`,
    exported_at: new Date().toISOString(),
    workspace: plan.workspace,
    items,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  // What an import will read: an export that would not pass is a bug here, never an archive.
  parseManifest(JSON.parse(text));
  await addText(state, MANIFEST_NAME, text, ARCHIVE_MAX_MANIFEST_BYTES);
  await zip.finish();
}

/** A text file an import reads only up to `max` bytes: past that the export stops, since no node would import it. */
async function addText(state: WriteState, path: string, text: string, max: number): Promise<void> {
  const bytes = utf8(text);
  if (bytes.byteLength > max) throw new ArchiveError(path, `would be ${bytes.byteLength} bytes; an archive takes at most ${max}`);
  await state.zip.add(path, bytes, "deflate");
}

// ---- Rows and views -----------------------------------------------------------------------------

/** One table's rows, read a page at a time and written as its rows file; none once the database is no longer readable. */
async function writeRows(state: WriteState, db: PlannedDatabase, table: PlannedTable): Promise<void> {
  // Checked again: the client may have taken its time over what came before.
  await currentReach(state);
  if (!(await stillReadable(state.ctx, db.doc.doc_id))) {
    await state.zip.add(table.archive.file, new Uint8Array(), "deflate");
    return;
  }
  const rows: ArchiveRow[] = [];
  const keys = new Set<string>();
  // Each page from where the last ended, so a row deleted or added between two leaves no other unread.
  for (let after: string | null = ""; after !== null; ) {
    const res = await callDatabaseActor(state.ctx, db.doc.doc_id, "rows/list", {
      table_id: table.schema.table_id,
      limit: DATABASE_ROWS_PAGE_MAX,
      after,
    });
    const page = res.ok ? ((await res.json().catch(() => null)) as { rows?: Array<Record<string, unknown>>; next?: string | null } | null) : null;
    if (!page?.rows || page.next === undefined) throw new Error(`could not list the rows of "${db.doc.title}" (HTTP ${res.status})`);
    after = page.next;
    for (const raw of page.rows) {
      const id = String(raw._id);
      if (table.rowKeys.has(id)) continue;
      let key = isRowKey(id) ? id : `row-${table.rowKeys.size + 1}`;
      while (keys.has(key)) key = `${key}-${table.rowKeys.size + 1}`;
      keys.add(key);
      table.rowKeys.set(id, key);
      if (typeof raw._doc_id === "string") table.pageLinks.set(id, raw._doc_id);
      const values: Record<string, RowValue> = Object.create(null);
      for (const [columnId, column] of table.columns) values[column.name] = cellOf(column, raw[columnId]);
      rows.push({ key, values });
    }
  }
  state.rows += rows.length;
  if (state.rows > ARCHIVE_MAX_ROWS) throw new ArchiveError(table.archive.file, `takes the archive past ${ARCHIVE_MAX_ROWS} rows`);
  await addText(state, table.archive.file, formatTableRows(table.archive, rows), ARCHIVE_MAX_TABLE_FILE_BYTES);
}

/**
 * A stored cell as the archive takes it, or null. A select value its column no longer offers
 * joins the column's choices while there is room, so the cell survives the import.
 */
function cellOf(column: ArchiveColumn, raw: unknown): RowValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (column.type === "single_select" && typeof raw === "string" && !column.choices!.includes(raw)) {
    const fits = column.choices!.length < DATABASE_MAX_SELECT_CHOICES && raw.trim() !== "" && raw.length <= DATABASE_MAX_DISPLAY_LENGTH;
    if (!fits) return null;
    column.choices!.push(raw);
  }
  const cell = validateCellValue(column.type, column.choices ? { choices: column.choices } : null, raw);
  return cell.ok ? cell.value : null;
}

/** A column a view names: a row's own field as it is, a user column by its archive name, or null when it is gone. */
function viewColumn(table: PlannedTable, ref: string): string | null {
  return ROW_FIELDS.has(ref) ? ref : (table.columns.get(ref)?.name ?? null);
}

/** A table's saved views, once its rows are written: a filter on a row names it by key. */
function archiveViews(table: PlannedTable): ArchiveView[] {
  const names = new Set<string>();
  return table.schema.views.filter((v) => !v.pending).map((view, i) => archiveView(view, i, table, names));
}

/** A saved view with column ids turned to names and row ids to keys; what no longer resolves is left out. */
function archiveView(view: ViewSpec, index: number, table: PlannedTable, names: Set<string>): ArchiveView {
  const name = uniqueDisplay(view.name, names);
  table.viewNames.set(view.view_id, name);

  const sorted = new Set<string>();
  const sorts: ArchiveSort[] = [];
  for (const sort of view.sorts ?? []) {
    const column = viewColumn(table, sort.column_id);
    if (column === null || sorted.has(column)) continue;
    sorted.add(column);
    sorts.push({ column, dir: sort.dir === "desc" ? "desc" : "asc" });
  }
  const hidden = new Set<string>();
  for (const id of view.hidden_columns ?? []) {
    const column = table.columns.get(id)?.name;
    if (column) hidden.add(column);
  }
  let config = view.config && typeof view.config === "object" && !Array.isArray(view.config) ? view.config : {};
  if (utf8(JSON.stringify(config)).length > VIEW_CONFIG_MAX_BYTES) config = {};
  return {
    name,
    kind: "table",
    position: Number.isSafeInteger(view.position) && view.position >= 0 ? view.position : index,
    filter: view.filter ? archiveFilter(view.filter, table) : null,
    sorts,
    group_by: view.group_by ? viewColumn(table, view.group_by) : null,
    hidden_columns: [...hidden],
    config,
  };
}

function archiveFilter(node: RowFilterNode, table: PlannedTable): ArchiveFilterNode | null {
  if ("and" in node || "or" in node) {
    const key = "and" in node ? "and" : "or";
    const kids = ("and" in node ? node.and : node.or).flatMap((child) => archiveFilter(child, table) ?? []);
    if (kids.length === 0) return null;
    return key === "and" ? { and: kids } : { or: kids };
  }
  const column = viewColumn(table, node.column_id);
  if (column === null) return null;
  if (!filterOpNeedsValue(node.op)) return { column, op: node.op };
  const value: unknown = node.value;
  // An archive's `_doc_id` takes only empty and not_empty: a page's id is this node's alone.
  if (column === "_doc_id") return null;
  if (typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) return null;
  if (column === "_id") {
    const key = table.rowKeys.get(String(value));
    return key === undefined ? null : { column, op: node.op, value: key };
  }
  // A view saved before its column became a number or a checkbox can still compare it with a word.
  const type = table.columns.get(node.column_id)?.type;
  const textual = node.op === "contains" || node.op === "not_contains";
  if (!textual && (type === "number" || type === "checkbox") && typeof value === "string" && !Number.isFinite(Number(value))) return null;
  return { column, op: node.op, value };
}

// ---- Bodies -------------------------------------------------------------------------------------

/** One document or row page: its body rewritten for the archive, and its settings and comments. */
async function writeBody(state: WriteState, body: Body): Promise<ArchiveDocSettings> {
  await currentReach(state);
  const markdown = await liveMarkdown(state.ctx, body.doc);
  const schema = getStugaSchema();
  const doc = markdown === "" ? null : await rewriteBody(state, body.path, markdownToDoc(markdown, schema));
  const out = doc ? docToMarkdown(doc) : "";
  await addText(state, body.path, bodyFile(out), ARCHIVE_MAX_BODY_BYTES);
  // A title the body gives is read as an import will read it: from the file.
  const derived = body.doc.title_source === "heading" && out !== "" ? derivedTitle(markdownToDoc(out, schema)) : "";
  return docSettings(state, body.doc, archiveTitle(derived || body.doc.title));
}

/**
 * A document's Markdown as its actor holds it, its actor released after. Gone or unreadable since
 * it was listed, it is empty, which keeps every link to it whole; one still there that its actor
 * did not answer for would be lost, so the export fails instead.
 */
async function liveMarkdown(ctx: Ctx, doc: DocRow): Promise<string> {
  const read = await readDocMarkdownWithProjection(ctx, doc.doc_id);
  await releaseActor(ctx.env, doc.doc_id, "prose");
  if (read === null && (await stillReadable(ctx, doc.doc_id))) throw new Error(`could not read "${doc.title}"`);
  return read && read !== "database" ? read.markdown : "";
}

/**
 * Read the exporter's membership, role and groups again, as a new request would: an export lasts
 * as long as its client reads, and what they can open narrows, or the export ends, as they lose it.
 */
async function currentReach(state: WriteState): Promise<void> {
  const { ctx } = state;
  const auth = await resolveHumanAuth(ctx.sql, ctx.alias, userPrincipal(ctx.alias), ctx.workspaceId);
  const role = auth.user && auth.membership?.workspace_id === ctx.workspaceId ? auth.membership.role : null;
  if (role !== "owner" && role !== "admin") throw new Error("the exporter is no longer an owner or admin of this workspace");
  state.ctx = { ...ctx, role, principals: principalsFrom(ctx.alias, ctx.workspaceId, role, auth.groupIds) };
}

async function stillReadable(ctx: Ctx, docId: string): Promise<boolean> {
  const doc = await getDoc(ctx.sql, docId);
  return doc !== null && !doc.trashed && canReadDoc(ctx, doc);
}

async function docSettings(state: WriteState, doc: DocRow, title: string): Promise<ArchiveDocSettings> {
  const settings: ArchiveDocSettings = {
    title,
    title_source: doc.title_source === "user" ? "user" : "heading",
    agent_mode: doc.agent_mode === "auto" ? "auto" : "review",
    locked: doc.locked,
    search_hidden: doc.search_hidden,
    agent_instructions: instructionsOf(doc.agent_instructions),
  };
  // Read now, and only while the exporter can still open the document.
  const comments = (await stillReadable(state.ctx, doc.doc_id)) ? await archiveComments(state, doc) : [];
  if (comments.length > 0) settings.comments = comments;
  return settings;
}

/**
 * The body as the archive holds it: links into the workspace relative to `from`, links to what is
 * not exported absolute on this node, images copied into media/, and mentions as plain `@name`.
 */
async function rewriteBody(state: WriteState, from: string, doc: Doc): Promise<Doc> {
  const images = new Map<string, string | null>();
  const sources: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "image") sources.push(String(node.attrs.src ?? ""));
  });
  for (const src of sources) if (!images.has(src)) images.set(src, await imageHref(state, from, src));
  return rewritten(doc, (href) => linkHref(state, from, href), (src) => images.get(src) ?? null);
}

/** `doc` with each link's destination and each image's source as `link` and `image` give them, null leaving it out, and mentions as plain `@name`. */
function rewritten(doc: Doc, link: (href: string) => string | null, image: (src: string) => string | null): Doc {
  const schema = doc.type.schema;
  const marksOf = (marks: readonly Mark[]): Mark[] =>
    marks.flatMap((mark) => {
      if (mark.type.name !== "link") return [mark];
      const href = link(String(mark.attrs.href ?? ""));
      return href === null ? [] : [mark.type.create({ ...mark.attrs, href })];
    });
  const rewrite = (node: Doc): Doc | null => {
    if (node.isText) return node.mark(marksOf(node.marks));
    if (node.type.name === "mention") {
      const label = String(node.attrs.label || node.attrs.alias || "");
      return label ? schema.text(`@${label}`, marksOf(node.marks)) : null;
    }
    if (node.type.name === "image") {
      const src = image(String(node.attrs.src ?? ""));
      return src ? node.type.create({ ...node.attrs, src }, null, marksOf(node.marks)) : null;
    }
    const children: Doc[] = [];
    node.forEach((child) => {
      const out = rewrite(child);
      if (out) children.push(out);
    });
    // A cell whose only image is left out still needs a paragraph.
    return node.type.createAndFill(node.attrs, children, marksOf(node.marks)) ?? node.type.create(node.attrs, children, marksOf(node.marks));
  };
  return rewrite(doc)!;
}

/**
 * A page of this node, on its public origin, or null for anything else: a relative link, another
 * site, or no URL at all.
 */
function nodeUrl(state: WriteState, href: string): URL | null {
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return new URL(href, state.origin);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return state.origins.has(url.origin) ? new URL(`${url.pathname}${url.search}${url.hash}`, state.origin) : null;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Where a link leads in the archive, or null to keep only its text. */
function linkHref(state: WriteState, from: string, href: string): string | null {
  if (href === "" || href.startsWith("mention:")) return null;
  if (href.startsWith("#")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  const url = nodeUrl(state, href);
  if (url) return nodeLink(state, from, url);
  // Another site, mail and the like stay; a relative link led nowhere in Stuga.
  return SCHEME.test(href) ? href : null;
}

/** A link to a page of this node: into the archive when it leads to something exported, else to the node. */
function nodeLink(state: WriteState, from: string, url: URL): string {
  const absolute = url.href;
  const doc = /^\/doc\/([^/]+)$/.exec(url.pathname);
  if (doc) {
    let docId: string;
    try {
      docId = decodeURIComponent(doc[1]!);
    } catch {
      return absolute;
    }
    const target = state.targets.get(docId);
    if (!target) return absolute;
    if (target.kind === "body") return archiveHref(from, { path: target.path });
    return archiveHref(from, databaseTarget(target.db, url.searchParams));
  }
  if (url.pathname === "/" && url.searchParams.has("folder")) {
    const id = url.searchParams.get("folder")!.split("/").pop()!;
    const path = state.plan.folderPaths.get(id);
    return path ? archiveHref(from, { path }) : absolute;
  }
  return absolute;
}

/** A database link's table, view and row, as far as each resolves; a view or row outside the table is dropped. */
function databaseTarget(db: PlannedDatabase, params: URLSearchParams): ArchiveTarget {
  const target: ArchiveTarget = { path: db.path };
  const tableId = params.get("table");
  const named = tableId ? db.tables.find((t) => t.schema.table_id === tableId) : undefined;
  if (tableId && !named) return target;
  const table = named ?? db.tables[0];
  if (!table) return target;
  if (named) target.table = named.archive.name;
  const view = params.get("view");
  const viewName = view ? table.viewNames.get(view) : undefined;
  if (viewName) target.view = viewName;
  const row = params.get("row");
  const key = row ? table.rowKeys.get(row) : undefined;
  if (key) target.row = key;
  return target;
}

/** Where an image's source leads in the archive; null leaves the image out. */
async function imageHref(state: WriteState, from: string, src: string): Promise<string | null> {
  if (src.startsWith("data:")) {
    const path = await inlineImage(state, src);
    return path ? archiveHref(from, { path }) : null;
  }
  if (src.startsWith("//")) return `https:${src}`;
  const url = nodeUrl(state, src);
  if (!url) return SCHEME.test(src) ? src : null;
  const stored = MEDIA_GET_PATH.exec(url.pathname);
  if (!stored) return url.href;
  const path = await storedImage(state, stored[1]!);
  return path ? archiveHref(from, { path }) : null;
}

/** A workspace image copied into media/ once, by hash; null when it is missing or not an image. */
function storedImage(state: WriteState, hash: string): Promise<string | null> {
  let pending = state.media.get(hash);
  if (!pending) {
    pending = (async () => {
      const key = mediaKey(state.ctx.workspaceId, hash);
      const head = await state.ctx.env.media.head(key);
      if (!head || head.size > ARCHIVE_MAX_MEDIA_BYTES) return null;
      const object = await state.ctx.env.media.get(key);
      return object ? writeImage(state, new Uint8Array(await object.arrayBuffer())) : null;
    })();
    state.media.set(hash, pending);
  }
  return pending;
}

/** An image a body carries inline as a `data:` URI, copied into media/. */
async function inlineImage(state: WriteState, src: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Image(src);
  } catch {
    return null;
  }
  return bytes.byteLength <= ARCHIVE_MAX_MEDIA_BYTES ? writeImage(state, bytes) : null;
}

async function writeImage(state: WriteState, bytes: Uint8Array): Promise<string | null> {
  const mime = sniffImageMime(bytes);
  if (!mime) return null;
  // Named for its bytes, as the format requires, whatever key it was stored under.
  const path = mediaPath(createHash("sha256").update(bytes).digest("hex"), mime);
  if (!state.written.has(path)) {
    state.written.add(path);
    // Already compressed: deflate would spend time to store it anyway.
    await state.zip.add(path, bytes, "stored");
  }
  return path;
}

// ---- Comments -----------------------------------------------------------------------------------

/** A document's comments, as the archive carries them: the author's name, never an account. */
async function archiveComments(state: WriteState, doc: DocRow): Promise<ArchiveComment[]> {
  const rows = await listComments(state.ctx.sql, doc.doc_id);
  // More came since the plan checked: an archive carrying only some would lose the rest unsaid.
  if (rows.length > ARCHIVE_MAX_COMMENTS) throw new Error(`"${doc.title}" has ${rows.length} comments; an archive carries at most ${ARCHIVE_MAX_COMMENTS}`);
  await nameAuthors(state, rows.map((row) => row.author));
  const roots = new Set<number>();
  const out: ArchiveComment[] = [];
  for (const row of rows) {
    const body = multiline(row.body.trim(), COMMENT_MAX_BODY_CHARS).trim();
    // A reply whose thread is not carried has nothing to hang from.
    if (!body || (row.parent_num !== null && !roots.has(row.parent_num))) continue;
    const quote = row.parent_num === null && row.anchor_quote ? multiline(row.anchor_quote, COMMENT_MAX_QUOTE_CHARS) : "";
    if (row.parent_num === null) roots.add(row.num);
    out.push({
      num: row.num,
      parent: row.parent_num,
      author_name: state.authors.get(row.author)!,
      created_at: new Date(row.created_at).toISOString(),
      resolved: row.resolved,
      quote: quote || null,
      body,
    });
  }
  return out;
}

/**
 * Comment authors' names as the app shows them to the workspace: the one an archive gave, Sample
 * agent's, a member's directory name, else the alias, as for a former member.
 */
async function nameAuthors(state: WriteState, authors: string[]): Promise<void> {
  const people: string[] = [];
  for (const author of new Set(authors)) {
    if (state.authors.has(author)) continue;
    if (author.startsWith("imported:")) state.authors.set(author, authorLine(author.slice("imported:".length)));
    else if (author === SAMPLE_AGENT_ALIAS) state.authors.set(author, SAMPLE_AGENT_NAME);
    else people.push(author);
  }
  if (people.length === 0) return;
  const members = new Map((await getUsers(state.ctx.sql, people, state.ctx.workspaceId)).map((user) => [user.alias, user]));
  for (const alias of people) {
    const member = members.get(alias);
    state.authors.set(alias, authorLine(member?.display_name || member?.username || alias));
  }
}
