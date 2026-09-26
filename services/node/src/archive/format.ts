/**
 * The workspace archive, format v1: Markdown bodies, JSONL rows and images, described by one
 * manifest, `stuga.json`, zipped as `<name>.stuga.zip`. docs/workspace-archive.md is the public
 * spec. Everything here is pure (no node APIs), and export, import and `stuga-node archive check`
 * share this one reading of it.
 *
 * The validators accept exactly what an import can land: the database rules are the ones
 * parseColumnSpecs and the database actor apply, and the caps are the product's own.
 */
import type { markdownToDoc } from "@stuga/crdt-ops";
import type { SafeImageMime } from "@stuga/protocol/api/media";
import { validateCellValue, validateSelectChoices } from "@stuga/protocol/databases/cells";
import { filterOpNeedsValue } from "@stuga/protocol/databases/filters";
import {
  DATABASE_FILTER_MAX_DEPTH,
  DATABASE_FILTER_MAX_LEAVES,
  DATABASE_IMPORT_MAX_BYTES,
  DATABASE_MAX_COLUMN_DESCRIPTION_CHARS,
  DATABASE_MAX_COLUMNS,
  DATABASE_MAX_DISPLAY_LENGTH,
  DATABASE_MAX_ROWS,
  DATABASE_MAX_SORTS,
  DATABASE_MAX_TABLES,
  DATABASE_MAX_VIEWS,
} from "@stuga/protocol/databases/limits";
import {
  DATABASE_COLUMN_TYPES,
  DATABASE_VIEW_KINDS,
  ROW_FILTER_OPS,
  type DatabaseColumnType,
  type DatabaseViewKind,
  type RowFilterOp,
  type RowValue,
} from "@stuga/protocol/databases/types";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import { UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";
import { MAX_IMPORT_MARKDOWN_BYTES } from "@stuga/protocol/text/markdown-import";

export const ARCHIVE_FORMAT = "stuga-workspace";
/** The one version this build reads and writes. An import refuses a newer one. */
export const ARCHIVE_VERSION = 1;
export const MANIFEST_NAME = "stuga.json";
export const ARCHIVE_EXTENSION = ".stuga.zip";
/** The top-level folder that holds every image, as `media/<sha256>.<ext>`. */
export const MEDIA_DIR = "media";

// ---- Caps ---------------------------------------------------------------------------------

/** The largest zipped archive: the largest upload a node can be set to take. */
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** Every file unpacked, together. */
export const ARCHIVE_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 20_000;
export const ARCHIVE_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** A body file: Markdown up to Stuga's own cap on an imported or proposed body, and its closing newline. */
export const ARCHIVE_MAX_BODY_BYTES = MAX_IMPORT_MARKDOWN_BYTES + 1;
export const ARCHIVE_MAX_TABLE_FILE_BYTES = DATABASE_IMPORT_MAX_BYTES;
/** One image: the largest upload a node can be set to take. */
export const ARCHIVE_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
/** Folders, documents and databases, together. */
export const ARCHIVE_MAX_ITEMS = 10_000;
/** Row pages across every table. */
export const ARCHIVE_MAX_PAGES = 10_000;
/** Rows across every table: ten tables as full as a table can be. */
export const ARCHIVE_MAX_ROWS = 500_000;
/** Comments on one document. */
export const ARCHIVE_MAX_COMMENTS = 5_000;
export const ARCHIVE_MAX_SAMPLE_STEPS = 200;
/** The document actor's own title clamp. */
export const ARCHIVE_MAX_TITLE_CHARS = 200;
export const ARCHIVE_MAX_WORKSPACE_NAME_CHARS = 100;
/** Folders nest at most this deep: the queries that walk a folder's ancestors stop there. */
export const ARCHIVE_MAX_FOLDER_DEPTH = 32;
/** One path segment, in UTF-8 bytes: under every file system's 255. */
export const ARCHIVE_MAX_SEGMENT_BYTES = 200;
export const ARCHIVE_MAX_PATH_BYTES = 1024;
export const ARCHIVE_MAX_ROW_KEY_CHARS = 64;
export const COMMENT_MAX_BODY_CHARS = 20_000;
export const COMMENT_MAX_QUOTE_CHARS = 2_000;
export const COMMENT_MAX_AUTHOR_CHARS = 200;
/** A view's opaque `config`, as JSON in UTF-8 bytes; the actor's cap. */
export const VIEW_CONFIG_MAX_BYTES = 16 * 1024;
/** A sample's cited edit, capped as the propose route caps an agent's. */
export const SAMPLE_MAX_EDITS = 200;
export const SAMPLE_MAX_CITATIONS = 50;
export const SAMPLE_MAX_OLD_STRING_CHARS = 1_000_000;
export const SAMPLE_MAX_HEADING_PATH_CHARS = 500;
export const SAMPLE_MAX_CITATION_CHARS = 1_000;
/** In a sample comment step's body, replaced by the importing person's `@username`. */
export const SAMPLE_ME = "{{me}}";

// ---- Types ----------------------------------------------------------------------------------

export type ArchiveAgentMode = "review" | "auto";
export type ArchiveTitleSource = "heading" | "user";

const AGENT_MODES = ["review", "auto"] as const;
const TITLE_SOURCES = ["heading", "user"] as const;

/** A comment as the archive carries it: no account, no anchor, only the quoted text. */
export interface ArchiveComment {
  num: number;
  /** The thread's first comment, or null for a first comment. Threads are one level deep. */
  parent: number | null;
  author_name: string;
  /** ISO 8601. */
  created_at: string;
  resolved: boolean;
  /** The text a thread's first comment was made on; null for a reply. */
  quote: string | null;
  body: string;
}

/** What a prose document, a row page and a database each carry. */
export interface ArchiveDocSettings {
  title: string;
  /** `heading`: the body's first line gives the title. `user`: someone named it. */
  title_source: ArchiveTitleSource;
  agent_mode: ArchiveAgentMode;
  locked: boolean;
  search_hidden: boolean;
  /** '' when none. */
  agent_instructions: string;
  comments?: ArchiveComment[];
}

/**
 * Every item names its parent folder by path, null at the top level, and must lie directly in it:
 * `parent` equals the directory of `path`. A parent is listed before its children.
 */
export interface ArchiveFolder {
  kind: "folder";
  path: string;
  parent: string | null;
  title: string;
  agent_instructions: string;
}

export interface ArchiveDoc extends ArchiveDocSettings {
  kind: "doc";
  /** The body: a `.md` file. */
  path: string;
  parent: string | null;
}

export interface ArchiveDatabase extends ArchiveDocSettings {
  kind: "database";
  /** A folder that holds the tables' row files and the row pages. */
  path: string;
  parent: string | null;
  tables: ArchiveTable[];
}

export type ArchiveItem = ArchiveFolder | ArchiveDoc | ArchiveDatabase;

export interface ArchiveColumn {
  name: string;
  type: DatabaseColumnType;
  /** single_select only. */
  choices?: string[];
  description?: string;
}

/** A leaf names its column by name, or one of a row's own fields (`_id`, `_created_at`, `_updated_at`, `_doc_id`). */
export interface ArchiveFilterLeaf {
  column: string;
  op: RowFilterOp;
  value?: string | number | boolean;
}
export type ArchiveFilterNode = ArchiveFilterLeaf | { and: ArchiveFilterNode[] } | { or: ArchiveFilterNode[] };

export interface ArchiveSort {
  column: string;
  dir: "asc" | "desc";
}

export interface ArchiveView {
  name: string;
  kind: DatabaseViewKind;
  position: number;
  filter: ArchiveFilterNode | null;
  sorts: ArchiveSort[];
  group_by: string | null;
  /** Column names. */
  hidden_columns: string[];
  config: Record<string, unknown>;
}

export interface ArchivePage extends ArchiveDocSettings {
  /** The row's `_id` key in the table's rows file. */
  row: string;
  /** The body: a `.md` file inside the database's folder. */
  file: string;
}

export interface ArchiveTable {
  name: string;
  /** The rows: a `.jsonl` file directly in the database's folder. */
  file: string;
  columns: ArchiveColumn[];
  views: ArchiveView[];
  pages: ArchivePage[];
}

export interface ArchiveCitation {
  n: number;
  /** The cited document or row page, by its body path. */
  doc: string;
  heading_path?: string;
  /** The cited passage, as it reads in that body. */
  content: string;
}

/** A cited edit Sample agent proposes; each `old_string` occurs once in the body as it then reads. */
export interface SampleEditStep {
  kind: "edit";
  doc: string;
  edits: { old_string: string; new_string: string }[];
  citations?: ArchiveCitation[];
}

/** A change to one row's cells Sample agent proposes. */
export interface SampleRowStep {
  kind: "row";
  database: string;
  table: string;
  row: string;
  /** By column name. */
  values: Record<string, string | number | boolean | null>;
}

/** A comment from Sample agent; `{{me}}` in the body becomes the importing person's @username. */
export interface SampleCommentStep {
  kind: "comment";
  doc: string;
  body: string;
  quote?: string;
}

export type SampleStep = SampleEditStep | SampleRowStep | SampleCommentStep;

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  /** What wrote it, e.g. `stuga 0.2.0`. */
  generator: string;
  /** ISO 8601. */
  exported_at: string;
  workspace: { name: string; agent_instructions: string };
  /** The document to open first. */
  start?: string;
  /** Parents before children. */
  items: ArchiveItem[];
  /** Replayed only for a published sample. */
  sample?: { steps: SampleStep[] };
}

/**
 * One row as read from a rows file: its key and its cells by column name, as stored (a checkbox is
 * 0/1). `values` has no prototype, so a column named `__proto__` or `constructor` is a cell like any other.
 */
export interface ArchiveRow {
  key: string;
  values: Record<string, RowValue>;
}

/** A manifest, rows file, link or index this format refuses. `at` names where: `items[3].tables[0].columns[2].type`. */
export class ArchiveError extends Error {
  constructor(
    readonly at: string,
    readonly reason: string,
  ) {
    super(at ? `${at}: ${reason}` : reason);
    this.name = "ArchiveError";
  }
}

function fail(at: string, reason: string): never {
  throw new ArchiveError(at, reason);
}

// ---- Paths ----------------------------------------------------------------------------------

const ENCODER = new TextEncoder();
const utf8Bytes = (s: string): number => ENCODER.encode(s).length;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** What Windows refuses in a name, control characters, and the bidi controls that make a name read as another. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u;
/** A device name, which Windows reads through spaces and an extension after it, as Git's is_valid_win32_path does. */
const WINDOWS_DEVICE = /^(con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i;
/** Names stuga's .dockerignore drops at any depth, matched as it matches them, by case; a fixture under one would vanish from a build. */
const DOCKER_IGNORED = /^(data|dist|backups|node_modules)$|\.tsbuildinfo$/;

/** Why `segment` cannot be a name, said of it: "starts with a dot". */
function segmentProblem(segment: string): string | null {
  if (utf8Bytes(segment) > ARCHIVE_MAX_SEGMENT_BYTES) return `is longer than ${ARCHIVE_MAX_SEGMENT_BYTES} bytes`;
  if (segment.startsWith(".")) return "starts with a dot";
  if (UNSAFE_CHARS.test(segment)) return 'holds < > : " \\ | ? *, a control character or a direction mark';
  if (/^\s|[\s.]$/.test(segment)) return "starts or ends with a space, or ends with a dot";
  if (WINDOWS_DEVICE.test(segment)) return "is a device name on Windows";
  if (DOCKER_IGNORED.test(segment)) return "is a name a Docker build of Stuga leaves out";
  return null;
}

/**
 * Why `path` cannot name a file or folder in an archive, or null when it can. A path is relative,
 * `/`-separated and NFC, and each segment is a name Windows, macOS and Linux can all create.
 */
export function archivePathProblem(path: string): string | null {
  if (path === "") return "is empty";
  if (LONE_SURROGATE.test(path)) return "is not valid Unicode";
  if (path.normalize("NFC") !== path) return "is not in Unicode NFC form";
  if (utf8Bytes(path) > ARCHIVE_MAX_PATH_BYTES) return `is longer than ${ARCHIVE_MAX_PATH_BYTES} bytes`;
  const segments = path.split("/");
  if (segments.includes("")) return "has an empty segment (a leading, trailing or doubled /)";
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    // A path of one name is that name; in a longer one, the name at fault is named.
    if (problem) return segments.length === 1 ? problem : `has "${segment}", which ${problem}`;
  }
  return null;
}

/**
 * Names as a Mac's and a Windows file system compare them, ignoring case: through upper case, so
 * σ and ς, which lower case keeps apart, are one letter, and lower case before it, so ẞ is ß is ss.
 */
const pathKey = (path: string): string => path.toLowerCase().toUpperCase().toLowerCase();

const UNSAFE_CHARS_ALL = new RegExp(UNSAFE_CHARS.source, "gu");
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE.source, "g");

/** The names an archive keeps for itself at its top level. */
export const ARCHIVE_RESERVED_NAMES: readonly string[] = [MANIFEST_NAME, MEDIA_DIR];

/**
 * The bytes a name in the folder `parent` ("" at the top) may take when the deepest path below it
 * is `levels` names deep, this name included: an even share of what ARCHIVE_MAX_PATH_BYTES leaves,
 * so every path below fits however long the titles are. A document is 1 level deep, a database
 * as deep as the files in its folder, and a folder 1 more than its deepest item.
 */
export function archiveNameRoom(parent: string, levels: number): number {
  const left = ARCHIVE_MAX_PATH_BYTES - (parent ? utf8Bytes(parent) + 1 : 0);
  return Math.min(ARCHIVE_MAX_SEGMENT_BYTES, Math.floor(left / levels) - 1);
}

/**
 * A file or folder name for `title` of at most `room` bytes that every path rule accepts, unique
 * ignoring case among `taken` (the names already used in the same folder, as this keys them),
 * which it joins. At the top level, `taken` starts with ARCHIVE_RESERVED_NAMES.
 */
export function archiveName(title: string, taken: Set<string>, extension = "", room = ARCHIVE_MAX_SEGMENT_BYTES): string {
  // Room for a " (10000)" that tells two alike names apart.
  const fit = Math.min(room, ARCHIVE_MAX_SEGMENT_BYTES) - utf8Bytes(extension) - 8;
  let base = "";
  for (const ch of title.replace(LONE_SURROGATE_ALL, "").normalize("NFC").replace(UNSAFE_CHARS_ALL, " ").replace(/\s+/g, " ")) {
    if (utf8Bytes(base + ch) > fit) break;
    base += ch;
  }
  base = base.normalize("NFC").replace(/^[\s.]+|[\s.]+$/g, "") || "Untitled";
  if (WINDOWS_DEVICE.test(base + extension)) base = base.replace(/^[^.]*/, (word) => `${word}_`);
  if (DOCKER_IGNORED.test(base + extension)) base = `${base}_`;
  let name = `${base}${extension}`;
  for (let n = 2; taken.has(pathKey(name)); n++) name = `${base} (${n})${extension}`;
  taken.add(pathKey(name));
  return name;
}

/** The folder `path` lies in, "" at the top level. */
export function archiveDirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

// ---- Field readers ----------------------------------------------------------------------------

type Obj = Record<string, unknown>;

/** `items[3]` + `title`; a top-level field is named alone. */
const field = (at: string, key: string): string => (at ? `${at}.${key}` : key);

function object(value: unknown, at: string): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(at, "must be an object");
  return value as Obj;
}

function list(value: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(at, "must be an array");
  if (value.length > max) fail(at, `holds ${value.length} entries (max ${max})`);
  return value;
}

/** What one line of text refuses: a line break (U+2028 and U+2029 too), or any other control character but a tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_ALL = new RegExp(CONTROL.source, "g");

interface TextRule {
  max: number;
  /** '' is allowed. */
  empty?: boolean;
  /** Line breaks are allowed. A tab always is. */
  multiline?: boolean;
  /** No space at either end. */
  trimmed?: boolean;
  /** A name people read: no invisible direction mark, which can make it read as another, and something that shows. */
  name?: boolean;
}

function textValue(value: unknown, at: string, rule: TextRule): string {
  if (typeof value !== "string") fail(at, value === undefined ? "is required" : "must be a string");
  if (value === "" && !rule.empty) fail(at, "must not be empty");
  if (value.length > rule.max) fail(at, `is longer than ${rule.max} characters`);
  if (LONE_SURROGATE.test(value)) fail(at, "is not valid Unicode");
  if (rule.multiline ? CONTROL_BUT_LINES.test(value) : CONTROL.test(value)) {
    fail(at, rule.multiline ? "holds a control character" : "holds a line break or a control character");
  }
  if (rule.trimmed && value.trim() !== value) fail(at, "must not start or end with a space");
  if (rule.name && UNSAFE_TEXT.test(value)) fail(at, "holds a tab, a direction mark or a byte order mark");
  if (rule.name && !hasVisibleText(value)) fail(at, "must show at least one visible character");
  return value;
}

/**
 * A title as an archive holds it, from any title Stuga keeps: at most ARCHIVE_MAX_TITLE_CHARS, on
 * one line (a line break or other control character becomes a space), half a surrogate pair as
 * U+FFFD, as the database stores one, and "Untitled" for none.
 */
export function archiveTitle(title: string): string {
  const line = title.slice(0, ARCHIVE_MAX_TITLE_CHARS).replace(CONTROL_ALL, " ").replace(LONE_SURROGATE_ALL, "\ufffd");
  return line === "" ? "Untitled" : line;
}

const text = (o: Obj, key: string, at: string, rule: TextRule): string => textValue(o[key], field(at, key), rule);

function flag(o: Obj, key: string, at: string): boolean {
  const value = o[key];
  if (typeof value !== "boolean") fail(field(at, key), "must be true or false");
  return value;
}

function wholeValue(value: unknown, at: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail(at, `must be a whole number, ${min} or more`);
  return value;
}

function member<T extends string>(o: Obj, key: string, at: string, values: readonly T[]): T {
  const value = o[key];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) fail(field(at, key), `must be one of ${values.join(", ")}`);
  return value as T;
}

function pathValue(value: unknown, at: string): string {
  if (typeof value !== "string") fail(at, value === undefined ? "is required" : "must be a path");
  const problem = archivePathProblem(value);
  if (problem) fail(at, `"${value}" ${problem}`);
  return value;
}

/** From year 1, and an offset within ±15:59: Postgres reads no year 0 and no wider offset. */
const ISO_TIME = /^((?!0000)\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/;

function isRealDate(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

function timestamp(o: Obj, key: string, at: string): string {
  const value = o[key];
  const m = typeof value === "string" ? ISO_TIME.exec(value) : null;
  if (!m || !isRealDate(m[1]!) || Number.isNaN(Date.parse(value as string))) {
    fail(field(at, key), "must be an ISO 8601 time ending in Z or an offset within ±15:59, e.g. 2026-09-25T10:00:00Z");
  }
  return value as string;
}

const title = (o: Obj, at: string): string => text(o, "title", at, { max: ARCHIVE_MAX_TITLE_CHARS });
const instructions = (o: Obj, at: string): string =>
  text(o, "agent_instructions", at, { max: MAX_AGENT_INSTRUCTIONS_CHARS, empty: true, multiline: true });

// ---- Comments -----------------------------------------------------------------------------------

function parseComments(raw: unknown, at: string): ArchiveComment[] {
  const roots = new Set<number>();
  let last = -1;
  return list(raw, at, ARCHIVE_MAX_COMMENTS).map((entry, i) => {
    const cat = `${at}[${i}]`;
    const o = object(entry, cat);
    const num = wholeValue(o.num, `${cat}.num`, 0);
    if (num <= last) fail(`${cat}.num`, "comments are listed in num order, each num once");
    last = num;
    const parent = o.parent === null ? null : wholeValue(o.parent, `${cat}.parent`, 0);
    if (parent !== null && !roots.has(parent)) fail(`${cat}.parent`, `${parent} is not the first comment of a thread listed before this one`);
    // The comments API takes an empty quote; it quotes nothing, as null does.
    const quote = o.quote === null || o.quote === "" ? null : text(o, "quote", cat, { max: COMMENT_MAX_QUOTE_CHARS, multiline: true });
    if (parent !== null && quote !== null) fail(`${cat}.quote`, "only a thread's first comment quotes the text");
    if (parent === null) roots.add(num);
    return {
      num,
      parent,
      author_name: text(o, "author_name", cat, { max: COMMENT_MAX_AUTHOR_CHARS, trimmed: true, name: true }),
      created_at: timestamp(o, "created_at", cat),
      resolved: flag(o, "resolved", cat),
      quote,
      body: text(o, "body", cat, { max: COMMENT_MAX_BODY_CHARS, multiline: true, trimmed: true }),
    };
  });
}

function docSettings(o: Obj, at: string): ArchiveDocSettings {
  const settings: ArchiveDocSettings = {
    title: title(o, at),
    title_source: member(o, "title_source", at, TITLE_SOURCES),
    agent_mode: member(o, "agent_mode", at, AGENT_MODES),
    locked: flag(o, "locked", at),
    search_hidden: flag(o, "search_hidden", at),
    agent_instructions: instructions(o, at),
  };
  if (o.comments !== undefined) settings.comments = parseComments(o.comments, `${at}.comments`);
  return settings;
}

// ---- Databases ------------------------------------------------------------------------------------

/** A row's own fields: a view may name them, a column may not be named like them. */
export const ROW_FIELDS: ReadonlySet<string> = new Set(["_id", "_created_at", "_updated_at", "_doc_id"]);

const ROW_KEY = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${ARCHIVE_MAX_ROW_KEY_CHARS - 1}}$`);

/** Whether `key` can be a row's `_id` in an archive: letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
export function isRowKey(key: unknown): key is string {
  return typeof key === "string" && ROW_KEY.test(key);
}

const displayName = (o: Obj, key: string, at: string): string =>
  text(o, key, at, { max: DATABASE_MAX_DISPLAY_LENGTH, trimmed: true });

/** parseColumnSpecs' rules, plus the actor's choice rules and a canonical spelling: trimmed names, choices only on single_select. */
function parseColumn(raw: unknown, at: string, seen: Set<string>): ArchiveColumn {
  const o = object(raw, at);
  const name = displayName(o, "name", at);
  if (ROW_FIELDS.has(name)) fail(`${at}.name`, `"${name}" is a row's own field`);
  if (seen.has(name.toLowerCase())) fail(`${at}.name`, `column "${name}" is listed twice`);
  seen.add(name.toLowerCase());
  const type = member(o, "type", at, DATABASE_COLUMN_TYPES);
  const column: ArchiveColumn = { name, type };
  if (type === "single_select") {
    const choices = validateSelectChoices(o.choices);
    if (!choices.ok) fail(`${at}.choices`, choices.reason);
    column.choices = choices.choices;
  } else if (o.choices !== undefined) {
    fail(`${at}.choices`, "only a single_select column has choices");
  }
  if (o.description !== undefined) {
    column.description = text(o, "description", at, { max: DATABASE_MAX_COLUMN_DESCRIPTION_CHARS, multiline: true, trimmed: true });
  }
  return column;
}

/** A cell as the archive spells it: a checkbox is true or false, everything else as validateCellValue takes it. */
export function archiveCellValue(column: ArchiveColumn, value: unknown): { ok: true; value: RowValue } | { ok: false; reason: string } {
  if (value === null) return { ok: true, value: null };
  if (column.type === "checkbox" && typeof value !== "boolean") return { ok: false, reason: "expected true or false" };
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { ok: false, reason: "expected a string, a number, true, false or null" };
  }
  return validateCellValue(column.type, column.choices ? { choices: column.choices } : null, value);
}

const FILTER_OPS: readonly string[] = ROW_FILTER_OPS;

/** The database actor's filter rules, on names instead of column ids. */
function parseFilter(raw: unknown, at: string, columns: Map<string, ArchiveColumn>): ArchiveFilterNode {
  let leaves = 0;
  const node = (value: unknown, nat: string, depth: number): ArchiveFilterNode => {
    const o = object(value, nat);
    if ("and" in o || "or" in o) {
      if ("and" in o && "or" in o) fail(nat, "a group is either and or or");
      if (depth >= DATABASE_FILTER_MAX_DEPTH) fail(nat, `filter groups nest at most ${DATABASE_FILTER_MAX_DEPTH} deep`);
      const key = "and" in o ? "and" : "or";
      const children = list(o[key], `${nat}.${key}`, DATABASE_FILTER_MAX_LEAVES).map((c, i) => node(c, `${nat}.${key}[${i}]`, depth + 1));
      return key === "and" ? { and: children } : { or: children };
    }
    leaves += 1;
    if (leaves > DATABASE_FILTER_MAX_LEAVES) fail(nat, `a filter holds at most ${DATABASE_FILTER_MAX_LEAVES} conditions`);
    return parseLeaf(o, nat, columns);
  };
  const tree = node(raw, at, 0);
  if (leaves === 0) fail(at, "must hold at least one condition");
  return tree;
}

function parseLeaf(o: Obj, at: string, columns: Map<string, ArchiveColumn>): ArchiveFilterLeaf {
  const column = columnRef(o.column, `${at}.column`, columns);
  const op = member(o, "op", at, FILTER_OPS) as RowFilterOp;
  if (!filterOpNeedsValue(op)) {
    if (o.value !== undefined) fail(`${at}.value`, `"${op}" takes no value`);
    return { column, op };
  }
  if (column === "_doc_id") fail(`${at}.op`, `_doc_id only takes empty and not_empty`);
  const value = o.value;
  if (typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) {
    fail(`${at}.value`, `"${op}" needs a string, a number, true or false`);
  }
  if (column === "_id" && !isRowKey(value)) fail(`${at}.value`, "an _id is a row key");
  const spec = columns.get(column);
  const textual = op === "contains" || op === "not_contains";
  if (!textual && spec && (spec.type === "number" || spec.type === "checkbox") && typeof value === "string" && !Number.isFinite(Number(value))) {
    fail(`${at}.value`, `column "${spec.name}" is ${spec.type}; "${value}" is not a number`);
  }
  return { column, op, value };
}

function columnRef(value: unknown, at: string, columns: Map<string, ArchiveColumn>): string {
  if (typeof value !== "string" || (!ROW_FIELDS.has(value) && !columns.has(value))) {
    fail(at, `must name a column of this table or one of ${[...ROW_FIELDS].join(", ")}`);
  }
  return value;
}

function parseView(raw: unknown, at: string, columns: Map<string, ArchiveColumn>, seen: Set<string>): ArchiveView {
  const o = object(raw, at);
  const name = displayName(o, "name", at);
  if (seen.has(name.toLowerCase())) fail(`${at}.name`, `view "${name}" is listed twice`);
  seen.add(name.toLowerCase());
  const sorted = new Set<string>();
  const sorts = list(o.sorts, `${at}.sorts`, DATABASE_MAX_SORTS).map((s, i) => {
    const sat = `${at}.sorts[${i}]`;
    const so = object(s, sat);
    const column = columnRef(so.column, `${sat}.column`, columns);
    if (sorted.has(column)) fail(`${sat}.column`, "a column appears once in the sort order");
    sorted.add(column);
    return { column, dir: member(so, "dir", sat, ["asc", "desc"] as const) };
  });
  const hidden = new Set<string>();
  const hiddenColumns = list(o.hidden_columns, `${at}.hidden_columns`, DATABASE_MAX_COLUMNS).map((c, i) => {
    const hat = `${at}.hidden_columns[${i}]`;
    if (typeof c !== "string" || !columns.has(c)) fail(hat, "must name a column of this table");
    if (hidden.has(c)) fail(hat, `"${c}" is listed twice`);
    hidden.add(c);
    return c;
  });
  const config = object(o.config, `${at}.config`);
  let json: string;
  try {
    json = JSON.stringify(config);
  } catch {
    // JSON.parse reads nesting deeper than JSON.stringify can write back.
    fail(`${at}.config`, "is nested too deeply");
  }
  if (utf8Bytes(json) > VIEW_CONFIG_MAX_BYTES) fail(`${at}.config`, `is larger than ${VIEW_CONFIG_MAX_BYTES} bytes`);
  return {
    name,
    kind: member(o, "kind", at, DATABASE_VIEW_KINDS),
    position: wholeValue(o.position, `${at}.position`, 0),
    filter: o.filter === null ? null : parseFilter(o.filter, `${at}.filter`, columns),
    sorts,
    group_by: o.group_by === null ? null : columnRef(o.group_by, `${at}.group_by`, columns),
    hidden_columns: hiddenColumns,
    config,
  };
}

// ---- The manifest ---------------------------------------------------------------------------------

/** Which paths the manifest has handed out, case-insensitively, and to whom. */
class PathClaims {
  private readonly owners = new Map<string, string>();
  private readonly files = new Map<string, string>();
  /** Every folder a claimed path lies in, as first spelled; a row page's file may name folders no item does. */
  private readonly dirs = new Map<string, string>();

  claim(path: string, at: string, file: boolean): void {
    const key = pathKey(path);
    const owner = this.owners.get(key);
    if (owner) fail(at, `"${path}" is also the path of ${owner}; paths must differ in more than letter case`);
    const top = pathKey(path.split("/")[0]!);
    if (top === pathKey(MANIFEST_NAME) || top === MEDIA_DIR) fail(at, `"${path}" starts with ${top}, a name the archive keeps for itself`);
    for (let dir = archiveDirname(path); dir; dir = archiveDirname(dir)) {
      const spelled = this.dirs.get(pathKey(dir));
      if (spelled === dir) break;
      if (spelled !== undefined) fail(at, `"${path}" lies in "${dir}", but another path lies in "${spelled}"; paths must differ in more than letter case`);
      this.dirs.set(pathKey(dir), dir);
    }
    this.owners.set(key, at);
    if (file) this.files.set(key, path);
  }

  /** No file may sit where another file's folder is. */
  checkNesting(): void {
    for (const path of this.files.values()) {
      for (let dir = archiveDirname(path); dir; dir = archiveDirname(dir)) {
        const owner = this.files.has(pathKey(dir)) ? this.owners.get(pathKey(dir)) : undefined;
        if (owner) fail(owner, `"${dir}" is a file, but "${path}" lies inside it`);
      }
    }
  }
}

function withExtension(path: string, at: string, extension: string): string {
  if (!path.endsWith(extension)) fail(at, `"${path}" must be a ${extension} file`);
  return path;
}

interface ParseState {
  claims: PathClaims;
  pages: number;
}

function parseTable(raw: unknown, at: string, db: string, names: Set<string>, state: ParseState): ArchiveTable {
  const o = object(raw, at);
  const name = displayName(o, "name", at);
  if (names.has(name.toLowerCase())) fail(`${at}.name`, `table "${name}" is listed twice`);
  names.add(name.toLowerCase());
  const file = withExtension(pathValue(o.file, `${at}.file`), `${at}.file`, ".jsonl");
  if (archiveDirname(file) !== db) fail(`${at}.file`, `"${file}" must lie directly in the database's folder "${db}"`);
  state.claims.claim(file, `${at}.file`, true);

  const seenColumns = new Set<string>();
  const columns = list(o.columns, `${at}.columns`, DATABASE_MAX_COLUMNS).map((c, i) => parseColumn(c, `${at}.columns[${i}]`, seenColumns));
  const byName = new Map(columns.map((c) => [c.name, c]));
  const seenViews = new Set<string>();
  const views = list(o.views, `${at}.views`, DATABASE_MAX_VIEWS).map((v, i) => parseView(v, `${at}.views[${i}]`, byName, seenViews));

  const rows = new Set<string>();
  const pages = list(o.pages, `${at}.pages`, ARCHIVE_MAX_PAGES).map((p, i): ArchivePage => {
    const pat = `${at}.pages[${i}]`;
    const po = object(p, pat);
    if (!isRowKey(po.row)) fail(`${pat}.row`, "must be a row key");
    if (rows.has(po.row)) fail(`${pat}.row`, `row "${po.row}" has one page`);
    rows.add(po.row);
    const pageFile = withExtension(pathValue(po.file, `${pat}.file`), `${pat}.file`, ".md");
    if (!pageFile.startsWith(`${db}/`)) fail(`${pat}.file`, `"${pageFile}" must lie inside the database's folder "${db}"`);
    state.claims.claim(pageFile, `${pat}.file`, true);
    state.pages += 1;
    if (state.pages > ARCHIVE_MAX_PAGES) fail(pat, `the archive holds more than ${ARCHIVE_MAX_PAGES} row pages`);
    return { row: po.row, file: pageFile, ...docSettings(po, pat) };
  });
  return { name, file, columns, views, pages };
}

function parseItem(raw: unknown, at: string, folders: Map<string, ArchiveFolder>, state: ParseState): ArchiveItem {
  const o = object(raw, at);
  const kind = member(o, "kind", at, ["folder", "doc", "database"] as const);
  const path = pathValue(o.path, `${at}.path`);
  const parent = o.parent === null ? null : pathValue(o.parent, `${at}.parent`);
  if (parent !== null && !folders.has(parent)) fail(`${at}.parent`, `"${parent}" is not a folder listed before this item`);
  if (archiveDirname(path) !== (parent ?? "")) {
    fail(`${at}.path`, `"${path}" must lie directly in its parent, ${parent === null ? "the top level" : `"${parent}"`}`);
  }
  if (kind === "folder") {
    if (path.split("/").length > ARCHIVE_MAX_FOLDER_DEPTH) fail(`${at}.path`, `folders nest at most ${ARCHIVE_MAX_FOLDER_DEPTH} deep`);
    state.claims.claim(path, `${at}.path`, false);
    const folder: ArchiveFolder = { kind, path, parent, title: title(o, at), agent_instructions: instructions(o, at) };
    folders.set(path, folder);
    return folder;
  }
  if (kind === "doc") {
    withExtension(path, `${at}.path`, ".md");
    state.claims.claim(path, `${at}.path`, true);
    return { kind, path, parent, ...docSettings(o, at) };
  }
  state.claims.claim(path, `${at}.path`, false);
  const names = new Set<string>();
  const tables = list(o.tables, `${at}.tables`, DATABASE_MAX_TABLES).map((t, i) => parseTable(t, `${at}.tables[${i}]`, path, names, state));
  return { kind, path, parent, ...docSettings(o, at), tables };
}

/**
 * Check a parsed `stuga.json` and return it typed, with only the fields this version knows. Throws
 * an ArchiveError naming the first field it refuses; a newer version is refused before anything else.
 */
export function parseManifest(raw: unknown): ArchiveManifest {
  const o = object(raw, "");
  if (o.format !== ARCHIVE_FORMAT) fail("format", `must be "${ARCHIVE_FORMAT}": this is not a Stuga workspace archive`);
  const version = wholeValue(o.version, "version", 1);
  if (version > ARCHIVE_VERSION) {
    fail("version", `the archive is version ${version}, from a newer Stuga; this node reads version ${ARCHIVE_VERSION}`);
  }
  const generator = text(o, "generator", "", { max: 200, trimmed: true });
  const exportedAt = timestamp(o, "exported_at", "");
  const workspace = object(o.workspace, "workspace");
  const name = text(workspace, "name", "workspace", { max: ARCHIVE_MAX_WORKSPACE_NAME_CHARS, trimmed: true });
  const agentInstructions = instructions(workspace, "workspace");

  const state: ParseState = { claims: new PathClaims(), pages: 0 };
  const folders = new Map<string, ArchiveFolder>();
  const items = list(o.items, "items", ARCHIVE_MAX_ITEMS).map((item, i) => parseItem(item, `items[${i}]`, folders, state));
  state.claims.checkNesting();

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version,
    generator,
    exported_at: exportedAt,
    workspace: { name, agent_instructions: agentInstructions },
    items,
  };
  const docs = new Set(items.flatMap((item) => (item.kind === "doc" ? [item.path] : [])));
  if (o.start !== undefined) {
    const start = pathValue(o.start, "start");
    if (!docs.has(start)) fail("start", `"${start}" is not a document in items`);
    manifest.start = start;
  }
  if (o.sample !== undefined) {
    const sample = object(o.sample, "sample");
    manifest.sample = { steps: parseSteps(sample.steps, "sample.steps", archiveIndex(manifest)) };
  }
  return manifest;
}

// ---- Sample steps --------------------------------------------------------------------------------

function bodyRef(value: unknown, at: string, index: ArchiveIndex): string {
  const path = pathValue(value, at);
  if (!index.bodies.has(path)) fail(at, `"${path}" is not a document or row page in items`);
  return path;
}

const PLACEHOLDER = /\{\{[^}]*\}\}/g;

function parseSteps(raw: unknown, at: string, index: ArchiveIndex): SampleStep[] {
  return list(raw, at, ARCHIVE_MAX_SAMPLE_STEPS).map((entry, i): SampleStep => {
    const sat = `${at}[${i}]`;
    const o = object(entry, sat);
    const kind = member(o, "kind", sat, ["edit", "row", "comment"] as const);
    if (kind === "edit") {
      const edits = list(o.edits, `${sat}.edits`, SAMPLE_MAX_EDITS).map((e, j) => {
        const eat = `${sat}.edits[${j}]`;
        const eo = object(e, eat);
        return {
          old_string: textValue(eo.old_string, `${eat}.old_string`, { max: SAMPLE_MAX_OLD_STRING_CHARS, multiline: true }),
          new_string: textValue(eo.new_string, `${eat}.new_string`, { max: MAX_IMPORT_MARKDOWN_BYTES, multiline: true, empty: true }),
        };
      });
      if (edits.length === 0) fail(`${sat}.edits`, "must hold at least one edit");
      // The propose route refuses edits whose new text alone could not fit in a body.
      const added = edits.reduce((n, e) => n + utf8Bytes(e.new_string), 0);
      if (added > MAX_IMPORT_MARKDOWN_BYTES) fail(`${sat}.edits`, `new_strings add up to ${added} bytes (max ${MAX_IMPORT_MARKDOWN_BYTES})`);
      const step: SampleEditStep = { kind, doc: bodyRef(o.doc, `${sat}.doc`, index), edits };
      if (o.citations !== undefined) {
        const numbers = new Set<number>();
        step.citations = list(o.citations, `${sat}.citations`, SAMPLE_MAX_CITATIONS).map((c, j) => {
          const cat = `${sat}.citations[${j}]`;
          const co = object(c, cat);
          const n = wholeValue(co.n, `${cat}.n`, 1);
          if (numbers.has(n)) fail(`${cat}.n`, `[^${n}] is cited twice`);
          numbers.add(n);
          const citation: ArchiveCitation = {
            n,
            doc: bodyRef(co.doc, `${cat}.doc`, index),
            content: text(co, "content", cat, { max: SAMPLE_MAX_CITATION_CHARS, multiline: true }),
          };
          if (co.heading_path !== undefined) citation.heading_path = text(co, "heading_path", cat, { max: SAMPLE_MAX_HEADING_PATH_CHARS });
          return citation;
        });
      }
      return step;
    }
    if (kind === "row") {
      const dbPath = pathValue(o.database, `${sat}.database`);
      const db = index.databases.get(dbPath);
      if (!db) fail(`${sat}.database`, `"${dbPath}" is not a database in items`);
      const table = db.tables.find((t) => t.name === o.table);
      if (!table) fail(`${sat}.table`, `must name a table of "${dbPath}"`);
      if (!isRowKey(o.row)) fail(`${sat}.row`, "must be a row key");
      const raw = object(o.values, `${sat}.values`);
      const values: SampleRowStep["values"] = Object.create(null);
      for (const [name, value] of Object.entries(raw)) {
        const column = table.columns.find((c) => c.name === name);
        if (!column) fail(`${sat}.values`, `"${name}" is not a column of table "${table.name}"`);
        const cell = archiveCellValue(column, value);
        if (!cell.ok) fail(`${sat}.values.${name}`, cell.reason);
        values[name] = value as SampleRowStep["values"][string];
      }
      if (Object.keys(values).length === 0) fail(`${sat}.values`, "must change at least one cell");
      return { kind, database: dbPath, table: table.name, row: o.row, values };
    }
    const body = text(o, "body", sat, { max: COMMENT_MAX_BODY_CHARS, multiline: true, trimmed: true });
    for (const m of body.matchAll(PLACEHOLDER)) {
      if (m[0] !== SAMPLE_ME) fail(`${sat}.body`, `${m[0]} is not a placeholder; ${SAMPLE_ME} is the only one`);
    }
    const step: SampleCommentStep = { kind, doc: bodyRef(o.doc, `${sat}.doc`, index), body };
    if (o.quote !== undefined) step.quote = text(o, "quote", sat, { max: COMMENT_MAX_QUOTE_CHARS, multiline: true });
    return step;
  });
}

// ---- Reading a manifest's contents ---------------------------------------------------------------

/** A Markdown body: a document's, or a row's page. */
export type ArchiveBody =
  | { kind: "doc"; path: string; item: ArchiveDoc }
  | { kind: "page"; path: string; item: ArchivePage; database: ArchiveDatabase; table: ArchiveTable };

/** The manifest's items by path. */
export interface ArchiveIndex {
  folders: Map<string, ArchiveFolder>;
  databases: Map<string, ArchiveDatabase>;
  /** Every body, by its file. */
  bodies: Map<string, ArchiveBody>;
  /** Every rows file, by its path. */
  tables: Map<string, { database: ArchiveDatabase; table: ArchiveTable }>;
}

export function archiveIndex(manifest: Pick<ArchiveManifest, "items">): ArchiveIndex {
  const index: ArchiveIndex = { folders: new Map(), databases: new Map(), bodies: new Map(), tables: new Map() };
  for (const item of manifest.items) {
    if (item.kind === "folder") index.folders.set(item.path, item);
    else if (item.kind === "doc") index.bodies.set(item.path, { kind: "doc", path: item.path, item });
    else {
      index.databases.set(item.path, item);
      for (const table of item.tables) {
        index.tables.set(table.file, { database: item, table });
        for (const page of table.pages) index.bodies.set(page.file, { kind: "page", path: page.file, item: page, database: item, table });
      }
    }
  }
  return index;
}

/** A body file holds the document's Markdown and one closing newline; an empty document is an empty file. */
export function bodyFile(markdown: string): string {
  return markdown === "" ? "" : `${markdown}\n`;
}

/**
 * The Markdown a body file holds, as `archive check` reads it: a file without its closing newline
 * is refused. An import takes one anyway, as it takes `\r\n` line ends.
 */
export function bodyMarkdown(file: string, path: string): string {
  if (file === "") return "";
  if (!file.endsWith("\n")) fail(path, "must end with a newline");
  return file.slice(0, -1);
}

/** A body as markdownToDoc reads it. */
type BodyDoc = ReturnType<typeof markdownToDoc>;

/** A body's text as the document actor's extractText walks it: blocks and hard breaks end lines. */
export function plainText(doc: BodyDoc): string {
  const parts: string[] = [];
  const walk = (node: BodyDoc): void => {
    if (node.isText) {
      parts.push(node.text ?? "");
      return;
    }
    node.forEach(walk);
    if (node.isBlock || node.type.name === "hardBreak") parts.push("\n");
  };
  doc.forEach(walk);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The title a flush derives from a body: its first non-empty line, as the document actor's
 * deriveTitle reads it. An export writes a heading title so, and `archive check` holds it to this.
 */
export function derivedTitle(doc: BodyDoc): string {
  for (const line of plainText(doc).split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, ARCHIVE_MAX_TITLE_CHARS);
  }
  return "";
}

/**
 * The rows of one table's file: one JSON object per line, each ending in `\n`, holding `_id` and
 * a value for any of the table's columns (an absent one is empty). Throws at `<file>:<line>`.
 */
export function parseTableRows(file: string, table: ArchiveTable): ArchiveRow[] {
  if (file === "") return [];
  if (!file.endsWith("\n")) fail(table.file, "the last line must end with a newline");
  const lines = file.slice(0, -1).split("\n");
  if (lines.length > DATABASE_MAX_ROWS) fail(table.file, `holds ${lines.length} rows (max ${DATABASE_MAX_ROWS})`);
  const columns = new Map(table.columns.map((c) => [c.name, c]));
  const keys = new Set<string>();
  return lines.map((line, i) => {
    const at = `${table.file}:${i + 1}`;
    if (line.includes("\r")) fail(at, "lines end in \\n, not \\r\\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(at, line.trim() === "" ? "is blank" : "is not JSON");
    }
    const row = object(parsed, at);
    if (!isRowKey(row._id)) fail(`${at}: _id`, "must be a row key: letters, digits, . _ and -");
    if (keys.has(row._id)) fail(`${at}: _id`, `"${row._id}" is used by an earlier row`);
    keys.add(row._id);
    const values: Record<string, RowValue> = Object.create(null);
    for (const [name, value] of Object.entries(row)) {
      if (name === "_id") continue;
      const column = columns.get(name);
      if (!column) fail(`${at}: ${name}`, `is not a column of table "${table.name}"`);
      const cell = archiveCellValue(column, value);
      if (!cell.ok) fail(`${at}: ${name}`, cell.reason);
      values[name] = cell.value;
    }
    return { key: row._id, values };
  });
}

/** The rows file for `rows`, canonical: `_id` first, then the columns in order, empty cells left out. */
export function formatTableRows(table: ArchiveTable, rows: readonly ArchiveRow[]): string {
  return rows
    .map((row) => {
      const line: Record<string, unknown> = Object.create(null);
      line._id = row.key;
      for (const column of table.columns) {
        const value = Object.hasOwn(row.values, column.name) ? row.values[column.name] : undefined;
        if (value === null || value === undefined) continue;
        line[column.name] = column.type === "checkbox" ? value === 1 : value;
      }
      return `${JSON.stringify(line)}\n`;
    })
    .join("");
}

// ---- Links and media ------------------------------------------------------------------------------

/** Where an archive link leads: an item's file or folder and, for a database, the table, view and row it opens. */
export interface ArchiveTarget {
  path: string;
  /** A database's table by name; its first table when absent. */
  table?: string;
  view?: string;
  row?: string;
}

const TARGET_KEYS = ["table", "view", "row"] as const;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Whether a link or image destination points into the archive: no scheme, not rooted at `/`, not a bare `#fragment`. */
export function isArchiveHref(href: string): boolean {
  return href !== "" && !SCHEME.test(href) && !href.startsWith("/") && !href.startsWith("#");
}

/** Resolve an archive link written in the body at `from`, as a browser resolves a relative URL. */
export function resolveArchiveHref(from: string, href: string): { ok: true; target: ArchiveTarget } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  const hash = href.indexOf("#");
  const pathPart = hash < 0 ? href : href.slice(0, hash);
  if (pathPart.includes("?")) return bad("has a ?query");
  if (pathPart.includes("\\")) return bad("uses a backslash");
  const out = archiveDirname(from) ? archiveDirname(from).split("/") : [];
  const raw = pathPart.split("/");
  // `Laws/` names the folder `Laws`.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  for (const segment of raw) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return bad("has a malformed %-escape");
    }
    if (name === "" || name.includes("/") || name.includes("\\")) return bad("has an empty or encoded-slash segment");
    if (name === ".") continue;
    if (name === "..") {
      if (out.length === 0) return bad("climbs out of the archive");
      out.pop();
      continue;
    }
    out.push(name);
  }
  if (out.length === 0) return bad("names the top of the archive");
  const path = out.join("/");
  const problem = archivePathProblem(path);
  if (problem) return bad(`leads to "${path}", a path that ${problem}`);
  const target: ArchiveTarget = { path };
  if (hash >= 0) {
    for (const part of href.slice(hash + 1).split("&")) {
      const eq = part.indexOf("=");
      const key = TARGET_KEYS.find((k) => k === (eq < 0 ? part : part.slice(0, eq)));
      if (!key) return bad(`has #${part}; a database link takes table=, view= and row=`);
      if (target[key] !== undefined) return bad(`names ${key} twice`);
      let value: string;
      try {
        value = decodeURIComponent(part.slice(eq + 1));
      } catch {
        return bad("has a malformed %-escape");
      }
      if (eq < 0 || value === "") return bad(`has an empty ${key}`);
      target[key] = value;
    }
  }
  return { ok: true, target };
}

const pct = (c: string): string => (c.charCodeAt(0) < 0x80 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : encodeURIComponent(c));

/** A path segment in a link: only what a Markdown destination or a URL would misread is escaped. */
const encodeSegment = (segment: string): string => segment.replace(/[\s%#?()&[\]^`{}]/g, pct);
const encodeFragmentValue = (value: string): string => encodeURIComponent(value).replace(/[()]/g, pct);

/** The link the body at `from` writes to reach `target`: relative, so it also works in an unzipped folder. */
export function archiveHref(from: string, target: ArchiveTarget): string {
  const fromDir = archiveDirname(from) ? archiveDirname(from).split("/") : [];
  const to = target.path.split("/");
  let shared = 0;
  while (shared < fromDir.length && shared < to.length && fromDir[shared] === to[shared]) shared++;
  const parts = [...fromDir.slice(shared).map(() => ".."), ...to.slice(shared).map(encodeSegment)];
  const fragment = TARGET_KEYS.flatMap((key) => {
    const value = target[key];
    return value === undefined ? [] : [`${key}=${encodeFragmentValue(value)}`];
  });
  return (parts.join("/") || ".") + (fragment.length ? `#${fragment.join("&")}` : "");
}

const MEDIA_EXTENSIONS: Record<string, SafeImageMime> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MEDIA_PATH = /^media\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/;

/** The archive path of an image: `media/<sha256 of its bytes>.<png|jpg|gif|webp>`. */
export function mediaPath(sha256: string, mime: SafeImageMime): string {
  const ext = Object.keys(MEDIA_EXTENSIONS).find((e) => MEDIA_EXTENSIONS[e] === mime)!;
  return `${MEDIA_DIR}/${sha256}.${ext}`;
}

/** The hash and type a media path names, or null when it is no media path. */
export function parseMediaPath(path: string): { sha256: string; mime: SafeImageMime } | null {
  const m = MEDIA_PATH.exec(path);
  return m ? { sha256: m[1]!, mime: MEDIA_EXTENSIONS[m[2]!]! } : null;
}

// ---- The samples index ----------------------------------------------------------------------------

export const SAMPLES_INDEX_FORMAT = "stuga-samples";
export const SAMPLES_INDEX_VERSION = 1;
export const SAMPLES_INDEX_NAME = "index.json";
export const SAMPLES_MAX = 100;
export const SAMPLES_INDEX_MAX_BYTES = 256 * 1024;
export const SAMPLE_MAX_TITLE_CHARS = 60;
/** One short line under the title where a new workspace is made. */
export const SAMPLE_MAX_DESCRIPTION_CHARS = 60;
export const SAMPLE_MAX_LANGS = 20;

const SAMPLE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SAMPLES_TAG = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.[1-9]\d*)?$/;
const LANGUAGE = /^[a-z]{2,3}$/;

/** One sample as the index lists it. */
export interface SampleEntry {
  id: string;
  title: string;
  description: string;
  /** The new workspace's name. */
  name: string;
  /** BCP 47 primary language tags of its text, e.g. `en`, `zh`. */
  langs: string[];
  /** Always `<id>.stuga.zip`, an asset of the same release. */
  file: string;
  sha256: string;
  bytes: number;
  /** The archive format version the file is written in. */
  archive_version: number;
}

export interface SamplesIndex {
  format: typeof SAMPLES_INDEX_FORMAT;
  version: number;
  /** The release the files are assets of: `vYYYY.MM.DD`, or `vYYYY.MM.DD.N` for a second one that day. */
  tag: string;
  samples: SampleEntry[];
}

export const sampleFileName = (id: string): string => `${id}${ARCHIVE_EXTENSION}`;

/**
 * Check a samples index and return it typed, with the first SAMPLES_MAX samples this node can
 * import. A later release may also list samples for a newer node: one written in a newer archive
 * version, or larger than an archive may be, is left out unread, and one this node cannot read,
 * such as one whose description is longer than it takes, is left out and `leftOut` hears why.
 * Throws an ArchiveError naming the first field it refuses of the index itself.
 */
export function parseSamplesIndex(raw: unknown, leftOut?: (err: ArchiveError) => void): SamplesIndex {
  const o = object(raw, "");
  if (o.format !== SAMPLES_INDEX_FORMAT) fail("format", `must be "${SAMPLES_INDEX_FORMAT}"`);
  const version = wholeValue(o.version, "version", 1);
  if (version > SAMPLES_INDEX_VERSION) fail("version", `the index is version ${version}; this node reads version ${SAMPLES_INDEX_VERSION}`);
  const tag = o.tag;
  const m = typeof tag === "string" ? SAMPLES_TAG.exec(tag) : null;
  if (!m || !isRealDate(`${m[1]}-${m[2]}-${m[3]}`)) fail("tag", "must be vYYYY.MM.DD or vYYYY.MM.DD.N");
  if (!Array.isArray(o.samples)) fail("samples", "must be an array");
  const ids = new Set<string>();
  const samples: SampleEntry[] = [];
  for (const [i, entry] of o.samples.entries()) {
    if (samples.length === SAMPLES_MAX) break;
    let sample: SampleEntry | null;
    try {
      sample = sampleEntry(entry, `samples[${i}]`, ids);
    } catch (err) {
      if (!(err instanceof ArchiveError)) throw err;
      leftOut?.(err);
      continue;
    }
    if (!sample) continue;
    ids.add(sample.id);
    samples.push(sample);
  }
  return { format: SAMPLES_INDEX_FORMAT, version, tag: tag as string, samples };
}

/** One entry of the index; null for one this node leaves out unread, and an ArchiveError for one it cannot read. */
function sampleEntry(entry: unknown, at: string, ids: ReadonlySet<string>): SampleEntry | null {
  const s = object(entry, at);
  const archiveVersion = wholeValue(s.archive_version, `${at}.archive_version`, 1);
  if (archiveVersion > ARCHIVE_VERSION) return null;
  const bytes = wholeValue(s.bytes, `${at}.bytes`, 1);
  if (bytes > ARCHIVE_MAX_BYTES) return null;
  if (typeof s.id !== "string" || !SAMPLE_ID.test(s.id)) fail(`${at}.id`, "must be 1 to 40 of a-z, 0-9 and -, starting with a letter or digit");
  if (ids.has(s.id)) fail(`${at}.id`, `"${s.id}" is listed twice`);
  const langs = list(s.langs, `${at}.langs`, SAMPLE_MAX_LANGS).map((lang, j) => {
    if (typeof lang !== "string" || !LANGUAGE.test(lang)) fail(`${at}.langs[${j}]`, "must be a primary language tag such as en or zh");
    return lang;
  });
  if (langs.length === 0 || new Set(langs).size !== langs.length) fail(`${at}.langs`, "must list each language once, at least one");
  if (s.file !== sampleFileName(s.id)) fail(`${at}.file`, `must be "${sampleFileName(s.id)}"`);
  if (typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.sha256)) fail(`${at}.sha256`, "must be 64 lowercase hex digits");
  return {
    id: s.id,
    title: text(s, "title", at, { max: SAMPLE_MAX_TITLE_CHARS, trimmed: true }),
    description: text(s, "description", at, { max: SAMPLE_MAX_DESCRIPTION_CHARS, trimmed: true }),
    name: text(s, "name", at, { max: ARCHIVE_MAX_WORKSPACE_NAME_CHARS, trimmed: true }),
    langs,
    file: s.file,
    sha256: s.sha256,
    bytes,
    archive_version: archiveVersion,
  };
}
