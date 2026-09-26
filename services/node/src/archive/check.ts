/**
 * `stuga-node archive check <directory>`: hold an unzipped workspace archive to format v1 and to
 * what an import will meet, so a sample is known good before it is published. Past the manifest:
 * every file it names is there and nothing else is, every body is Markdown exactly as Stuga
 * writes it and gives its title, every row reads, every link and image resolves, and every sample
 * step finds what it changes.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyRenumberedStrEdits, docToMarkdown, getStugaSchema, markdownToDoc } from "@stuga/crdt-ops";
import { markdownByteLength, MAX_IMPORT_MARKDOWN_BYTES } from "@stuga/protocol/text/markdown-import";
import { DEFAULT_MAX_UPLOAD_BYTES, sniffImageMime } from "../media/media.js";
import { refused, type ExitCode } from "../ops/outcome.js";
import {
  ARCHIVE_MAX_BODY_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_MANIFEST_BYTES,
  ARCHIVE_MAX_ROWS,
  ARCHIVE_MAX_TABLE_FILE_BYTES,
  ARCHIVE_MAX_UNPACKED_BYTES,
  ArchiveError,
  MANIFEST_NAME,
  MEDIA_DIR,
  archiveIndex,
  archiveTitle,
  bodyMarkdown,
  derivedTitle,
  isArchiveHref,
  mediaPath,
  parseManifest,
  parseMediaPath,
  parseTableRows,
  plainText,
  resolveArchiveHref,
  type ArchiveFilterNode,
  type ArchiveIndex,
  type ArchiveManifest,
} from "./format.js";

export const ARCHIVE_USAGE = "stuga-node archive check <directory> [--json]";

/** A note for whoever keeps the archive, beside it; never part of what an import reads. */
const README = "README.md";

/** An archive's files, however they are stored. */
export interface ArchiveFiles {
  /** Every file by its archive path (`/`-separated), with its size in bytes. */
  sizes: ReadonlyMap<string, number>;
  read(path: string): Promise<Uint8Array>;
  /** Entries that cannot be archive files, such as a symbolic link, with why. */
  others: ReadonlyMap<string, string>;
}

export interface CheckIssue {
  /** The file, and for the manifest the field: `stuga.json: items[3].path`, `Obligations/Obligations.jsonl:12: Law`. */
  at: string;
  message: string;
  /** For a body Stuga would write differently: the lines that differ, `-` as written and `+` as Stuga writes them. */
  diff?: string;
}

export interface ArchiveCheck {
  manifest: ArchiveManifest | null;
  issues: CheckIssue[];
  counts: { items: number; bodies: number; rows: number; images: number; steps: number };
}

/**
 * The files under `dir`. Names starting with a dot (`.DS_Store`, `.git`) are skipped, as a
 * folder carries them without meaning to; they are never part of an archive.
 */
export async function directoryFiles(dir: string): Promise<ArchiveFiles> {
  const sizes = new Map<string, number>();
  const others = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) others.set(path, "is a symbolic link; an archive holds only files");
      else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) sizes.set(path, (await stat(join(dir, path))).size);
      else others.set(path, "is not a file");
    }
  };
  await walk("");
  return { sizes, others, read: async (path) => new Uint8Array(await readFile(join(dir, path))) };
}

type Doc = ReturnType<typeof markdownToDoc>;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text a comment's quote is matched against, as the web reads a selection. */
const quoteText = (doc: Doc): string => doc.textBetween(0, doc.content.size, " ");

/**
 * An id an import mints is up to 12 random letters and digits. A body as an import writes it holds
 * each as 12 of this stand-in, which meetsDestination reads as any letter or digit.
 */
const ID_CHAR = "\ue000";
const ID = ID_CHAR.repeat(12);
const ID_LETTER = /[A-Za-z0-9]/;

/** Where an import points an archive link or image, in the forms import.ts's nodeHref and mediaUrl write. */
function importedHref(from: string, href: string, index: ArchiveIndex, image: boolean): string {
  const resolved = resolveArchiveHref(from, href);
  // One that does not resolve is a problem of its own.
  if (!resolved.ok) return `/doc/${ID}`;
  const { path, table, view, row } = resolved.target;
  if (image) return `/api/docs/${ID}/media/${parseMediaPath(path)?.sha256 ?? ID}`;
  if (index.bodies.get(path)?.kind === "page") return `/doc/${ID}?row=${ID}.tbl_${ID}.row_${ID}`;
  if (index.folders.has(path)) return `/?folder=${path.split("/").map(() => `f_${ID}`).join("/")}`;
  if (table === undefined && view === undefined && row === undefined) return `/doc/${ID}`;
  return `/doc/${ID}?table=tbl_${ID}${view === undefined ? "" : `&view=view_${ID}`}${row === undefined ? "" : `&row=row_${ID}`}`;
}

/** `node`, in the body at `from`, with every archive link and image pointed at the node as an import writes it; `written` gathers each. */
function pointedAtNode(node: Doc, from: string, index: ArchiveIndex, written: Set<string>): Doc {
  const point = (href: string, image: boolean): string => {
    if (!isArchiveHref(href)) return href;
    const to = importedHref(from, href, index, image);
    written.add(to);
    return to;
  };
  const marks = node.marks.map((m) => (m.type.name === "link" ? m.type.create({ ...m.attrs, href: point(String(m.attrs.href ?? ""), false) }) : m));
  if (node.isText) return node.mark(marks);
  const children: Doc[] = [];
  node.forEach((child) => void children.push(pointedAtNode(child, from, index, written)));
  const attrs = node.type.name === "image" ? { ...node.attrs, src: point(String(node.attrs.src ?? ""), true) } : node.attrs;
  return node.type.create(attrs, children, marks);
}

/**
 * Whether `needle` could occur in `text` across or inside one of the `written` destinations, an id
 * matching any letters and digits. An occurrence that starts before a destination holds the
 * character before it, and one that ends after it the character after, so only those are tried.
 */
function meetsDestination(text: string, written: Iterable<string>, needle: string): boolean {
  const fits = (p: number): boolean => {
    if (p < 0 || p + needle.length > text.length) return false;
    for (let q = 0; q < needle.length; q++) {
      const t = text[p + q];
      if (t === ID_CHAR ? !ID_LETTER.test(needle[q]!) : t !== needle[q]) return false;
    }
    return true;
  };
  /** Where `c` is in the needle, from index `from` to `to`. */
  const at = (c: string | undefined, from: number, to: number): number[] => {
    const found: number[] = [];
    if (c === undefined) return found;
    for (let k = needle.indexOf(c, from); k >= 0 && k <= to; k = needle.indexOf(c, k + 1)) found.push(k);
    return found;
  };
  for (const dest of written) {
    for (let d = text.indexOf(dest); d >= 0; d = text.indexOf(dest, d + 1)) {
      const end = d + dest.length;
      for (let p = d; p + needle.length <= end; p++) if (fits(p)) return true;
      if (at(text[d - 1], 0, needle.length - 2).some((k) => fits(d - 1 - k))) return true;
      if (at(text[end], 1, Math.min(needle.length - 1, end - d)).some((k) => fits(end - k))) return true;
    }
  }
  return false;
}

/** A text's size once an import writes it: each id stand-in is three bytes, and each id letter one. */
const importedBytes = (text: string): number => markdownByteLength(text) - 2 * (text.split(ID_CHAR).length - 1);

/** Every link and image destination in a document, and how many mentions it holds. */
function destinations(doc: Doc): { links: Set<string>; images: Set<string>; mentions: number } {
  const out = { links: new Set<string>(), images: new Set<string>(), mentions: 0 };
  doc.descendants((node) => {
    if (node.type.name === "image") out.images.add(String(node.attrs.src ?? ""));
    if (node.type.name === "mention") out.mentions += 1;
    for (const mark of node.marks) if (mark.type.name === "link") out.links.add(String(mark.attrs.href ?? ""));
  });
  return out;
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

function leavesOf(node: ArchiveFilterNode | null): Array<{ column: string; value?: unknown }> {
  if (!node) return [];
  if ("and" in node) return node.and.flatMap(leavesOf);
  if ("or" in node) return node.or.flatMap(leavesOf);
  return [node];
}

/**
 * Control characters but a tab, line separators, direction marks and a byte order mark, as `\\u`
 * escapes: a terminal would act on them or hide them, and an archive's names and text hold them.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\ufeff\p{Bidi_Control}]/gu;
const escaped = (text: string): string => text.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A diff line with its unprintable characters escaped and its trailing spaces shown. */
function visible(line: string): string {
  return escaped(line).replace(/ +$/, (spaces) => "·".repeat(spaces.length));
}

/** A line diff of the part that differs; one too large to align is shown removed, then added. */
function middleDiff(a: string[], b: string[]): string[] {
  if (a.length * b.length > 1_000_000) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i++]}`);
      j++;
    } else if (j === b.length || (i < a.length && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  return out;
}

/** Where `before` and `after` differ, line by line with two lines of context, in at most `max` lines. */
export function lineDiff(before: string, after: string, max = 40): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines = [
    `@@ line ${head + 1} @@`,
    ...[
      ...a.slice(Math.max(0, head - 2), head).map((l) => ` ${l}`),
      ...middleDiff(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
      ...a.slice(a.length - tail, a.length - tail + 2).map((l) => ` ${l}`),
    ].map((l) => l[0] + visible(l.slice(1))),
  ];
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n") : lines.join("\n");
}

/** Check the archive `files` hold. Every problem found is listed; a manifest it cannot read stops the check there. */
export async function checkArchive(files: ArchiveFiles): Promise<ArchiveCheck> {
  const issues: CheckIssue[] = [];
  const problem = (at: string, message: string, diff?: string): void => void issues.push(diff === undefined ? { at, message } : { at, message, diff });
  const counts = { items: 0, bodies: 0, rows: 0, images: 0, steps: 0 };

  for (const [path, why] of files.others) problem(path, why);
  if (files.sizes.size > ARCHIVE_MAX_ENTRIES) problem("archive", `holds ${files.sizes.size} files (max ${ARCHIVE_MAX_ENTRIES})`);
  const total = [...files.sizes.values()].reduce((n, size) => n + size, 0);
  if (total > ARCHIVE_MAX_UNPACKED_BYTES) problem("archive", `holds ${total} bytes (max ${ARCHIVE_MAX_UNPACKED_BYTES})`);

  const readText = async (path: string, max: number): Promise<string | null> => {
    const size = files.sizes.get(path);
    if (size === undefined) {
      const decomposed = [...files.sizes.keys()].some((p) => p !== path && p.normalize("NFC") === path);
      if (decomposed) problem(path, "is stored under a decomposed Unicode name; rename it to its NFC form");
      else if (path === MANIFEST_NAME) problem(path, "is missing, so this is not an archive's top folder; check the folder the archive unzips to");
      else problem(path, `is missing; ${MANIFEST_NAME} names it`);
      return null;
    }
    if (size > max) {
      problem(path, `is ${size} bytes (max ${max})`);
      return null;
    }
    const bytes = await files.read(path);
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch {
      problem(path, "is not UTF-8 text");
      return null;
    }
    if (!text.startsWith("\ufeff")) return text;
    // Checked past the mark, so one save as UTF-8 without it is all the file needs.
    problem(path, "starts with a byte order mark; save it as UTF-8 without one");
    return text.slice(1);
  };

  const manifestText = await readText(MANIFEST_NAME, ARCHIVE_MAX_MANIFEST_BYTES);
  if (manifestText === null) return { manifest: null, issues, counts };
  let manifest: ArchiveManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestText));
  } catch (err) {
    if (err instanceof ArchiveError) problem(err.at ? `${MANIFEST_NAME}: ${err.at}` : MANIFEST_NAME, err.reason);
    else if (err instanceof SyntaxError) problem(MANIFEST_NAME, `is not JSON: ${err.message}`);
    else throw err;
    return { manifest: null, issues, counts };
  }
  const index = archiveIndex(manifest);
  counts.items = manifest.items.length;
  counts.steps = manifest.sample?.steps.length ?? 0;

  const rows = await checkRows(index, readText, problem);
  for (const keys of rows.values()) counts.rows += keys.size;
  if (counts.rows > ARCHIVE_MAX_ROWS) problem("archive", `holds ${counts.rows} rows (max ${ARCHIVE_MAX_ROWS})`);

  // Bodies: canonical Markdown, titles, links and images.
  const schema = getStugaSchema();
  const bodies = new Map<string, string>();
  const imported = new Map<string, Imported>();
  const shown = new Map<string, string>();
  for (const body of index.bodies.values()) {
    const file = await readText(body.path, ARCHIVE_MAX_BODY_BYTES);
    if (file === null) continue;
    counts.bodies += 1;
    let markdown = file;
    try {
      markdown = bodyMarkdown(file, body.path);
    } catch (err) {
      if (!(err instanceof ArchiveError)) throw err;
      // Checked on as it stands, for the other problems it may have.
      problem(err.at, err.reason);
    }
    const doc = markdownToDoc(markdown, schema);
    const canonical = docToMarkdown(doc);
    bodies.set(body.path, canonical);
    if (canonical !== markdown) problem(body.path, "is not Markdown as Stuga writes it, so an import would change it", lineDiff(markdown, canonical));
    const derived = derivedTitle(doc);
    const title = archiveTitle(derived);
    if (body.item.title_source === "heading" && derived && title !== body.item.title) {
      problem(body.path, `its first line gives the title "${title}", but ${MANIFEST_NAME} says "${body.item.title}"`);
    }
    const found = destinations(doc);
    const written = new Set<string>();
    const pointed = [...found.links, ...found.images].some(isArchiveHref) ? docToMarkdown(pointedAtNode(doc, body.path, index, written)) : canonical;
    imported.set(body.path, { text: pointed, written });
    if (found.mentions) problem(body.path, "holds a mention; an archive writes a person as plain @name text");
    for (const href of found.links) {
      const why = linkProblem(body.path, href, index, rows);
      if (why) problem(body.path, why);
    }
    for (const src of found.images) {
      const image = imageTarget(body.path, src);
      if (typeof image === "string") problem(body.path, image);
      else if (image) shown.set(image.path, shown.get(image.path) ?? body.path);
    }
  }

  // Images: named for their bytes, of the type they say, each shown somewhere.
  for (const [path, size] of files.sizes) {
    if (!path.startsWith(`${MEDIA_DIR}/`)) continue;
    const media = parseMediaPath(path);
    if (!media) {
      problem(path, `is not named ${MEDIA_DIR}/<sha256>.<png|jpg|gif|webp>`);
      continue;
    }
    counts.images += 1;
    if (!shown.has(path)) problem(path, "is not shown by any body");
    // The format takes the largest a node can be set to; every node takes this much.
    if (size > DEFAULT_MAX_UPLOAD_BYTES) {
      problem(path, `is ${size} bytes (max ${DEFAULT_MAX_UPLOAD_BYTES}, the upload limit a node starts with)`);
      continue;
    }
    const bytes = await files.read(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const mime = sniffImageMime(bytes);
    if (!mime) problem(path, "is not a PNG, JPEG, GIF or WebP image");
    else if (hash !== media.sha256 || mime !== media.mime) problem(path, `is named for other bytes; these are ${mediaPath(hash, mime)}`);
  }
  for (const [path, body] of shown) if (!files.sizes.has(path)) problem(body, `shows ${path}, which is missing`);

  // Nothing else: an import reads only what the manifest names.
  const named = new Set<string>([MANIFEST_NAME, ...index.bodies.keys(), ...index.tables.keys()]);
  for (const path of files.sizes.keys()) {
    if (named.has(path) || path.startsWith(`${MEDIA_DIR}/`) || path === README) continue;
    problem(path, `is not part of the archive: ${MANIFEST_NAME} names no such file`);
  }

  checkSteps(manifest, index, { bodies, imported }, rows, problem);
  return { manifest, issues, counts };
}

type Problem = (at: string, message: string, diff?: string) => void;

/** A body as an import writes it, and the link and image destinations it wrote there. */
interface Imported {
  text: string;
  written: Set<string>;
}

/** Every table's row keys, by its rows file; a file that does not read is left out. */
async function checkRows(
  index: ArchiveIndex,
  readText: (path: string, max: number) => Promise<string | null>,
  problem: Problem,
): Promise<Map<string, Set<string>>> {
  const rows = new Map<string, Set<string>>();
  for (const [file, { table }] of index.tables) {
    const text = await readText(file, ARCHIVE_MAX_TABLE_FILE_BYTES);
    if (text === null) continue;
    try {
      rows.set(file, new Set(parseTableRows(text, table).map((r) => r.key)));
    } catch (err) {
      if (!(err instanceof ArchiveError)) throw err;
      problem(err.at, err.reason);
      continue;
    }
    const keys = rows.get(file)!;
    for (const page of table.pages) {
      if (!keys.has(page.row)) problem(page.file, `is the page of row "${page.row}", which ${file} does not hold`);
    }
    for (const view of table.views) {
      for (const leaf of leavesOf(view.filter)) {
        if (leaf.column === "_id" && typeof leaf.value === "string" && !keys.has(leaf.value)) {
          problem(file, `view "${view.name}" filters on row "${leaf.value}", which the file does not hold`);
        }
      }
    }
  }
  return rows;
}

/** Why a link in the body at `from` does not resolve, or null when it does or leaves the archive. */
function linkProblem(from: string, href: string, index: ArchiveIndex, rows: Map<string, Set<string>>): string | null {
  if (href.startsWith("mention:")) return `links to "${href}"; an archive writes a person as plain @name text`;
  if (href.startsWith("/")) return `links to "${href}" on the node it came from; link by relative path, or by full URL`;
  if (!isArchiveHref(href)) return null;
  const resolved = resolveArchiveHref(from, href);
  if (!resolved.ok) return `link "${href}" ${resolved.reason}`;
  const { path, table, view, row } = resolved.target;
  const fragment = table !== undefined || view !== undefined || row !== undefined;
  if (index.bodies.has(path) || index.folders.has(path)) return fragment ? `link "${href}": only a database link takes table, view or row` : null;
  const db = index.databases.get(path);
  if (!db) return `link "${href}" leads to "${path}", which is not in the archive`;
  if (!fragment) return null;
  const t = table === undefined ? db.tables[0] : db.tables.find((x) => x.name === table);
  if (!t) return `link "${href}": database "${path}" has no ${table === undefined ? "table" : `table "${table}"`}`;
  if (view !== undefined && !t.views.some((v) => v.name === view)) return `link "${href}": table "${t.name}" has no view "${view}"`;
  if (row !== undefined && rows.get(t.file)?.has(row) === false) return `link "${href}": table "${t.name}" has no row "${row}"`;
  return null;
}

/** The media file an image shows, why it cannot show one, or null for an image on the web. */
function imageTarget(from: string, src: string): { path: string } | string | null {
  if (src.startsWith("data:")) return `holds an image as a data: URI; an archive keeps images under ${MEDIA_DIR}/`;
  if (src.startsWith("/")) return `shows "${src}" from the node it came from; an archive keeps images under ${MEDIA_DIR}/`;
  if (!isArchiveHref(src)) return null;
  const resolved = resolveArchiveHref(from, src);
  if (!resolved.ok) return `image "${src}" ${resolved.reason}`;
  const { path, ...fragment } = resolved.target;
  if (Object.keys(fragment).length || !parseMediaPath(path)) return `image "${src}" leads to "${path}", which is no ${MEDIA_DIR}/<sha256>.<ext> file`;
  return { path };
}

/** What an archive link in a sample edit's text would be: an import rewrites links, so an edit must not hold one. */
function archiveLinkIn(snippet: string, schema: ReturnType<typeof getStugaSchema>): string | null {
  const found = destinations(markdownToDoc(snippet, schema));
  return [...found.links, ...found.images].find(isArchiveHref) ?? null;
}

const MARKER = /\[\^(\d+)\](?!:)/g;

/**
 * Each sample step finds what it changes, in the bodies and rows as the steps before it leave them.
 * An edit step is replayed as the propose route runs it: on the body as an import writes it, with
 * its markers renumbered past the body's footnotes, the result held to the route's size cap, and
 * then as Stuga writes it.
 */
function checkSteps(
  manifest: ArchiveManifest,
  index: ArchiveIndex,
  /** Each body as Stuga writes it, and as an import writes it. */
  texts: { bodies: Map<string, string>; imported: Map<string, Imported> },
  rows: Map<string, Set<string>>,
  problem: Problem,
): void {
  const { bodies, imported } = texts;
  const schema = getStugaSchema();
  const docs = new Map<string, Doc>();
  const docOf = (markdown: string): Doc => docs.get(markdown) ?? docs.set(markdown, markdownToDoc(markdown, schema)).get(markdown)!;
  // Sample agent reads its own pending edits laid over a body, so a later step sees the earlier ones.
  const proposed = new Map<string, string>();
  for (const [i, step] of (manifest.sample?.steps ?? []).entries()) {
    const at = `${MANIFEST_NAME}: sample.steps[${i}]`;
    if (step.kind === "edit") {
      const body = bodies.get(step.doc);
      const { text: fresh, written } = imported.get(step.doc) ?? {};
      if (body === undefined || fresh === undefined || written === undefined) continue;
      const start = proposed.get(step.doc) ?? fresh;
      const citations = (step.citations ?? []).map((c) => ({ n: c.n, doc_id: "", title: "" }));
      const { markdown: next, renumber } = applyRenumberedStrEdits(start, step.edits, citations);
      const renumbered = (s: string): string => s.replace(MARKER, (all, n: string) => (renumber.has(Number(n)) ? `[^${renumber.get(Number(n))}]` : all));
      const cited = new Set(citations.map((c) => c.n));
      let text = start;
      let found = true;
      for (const [j, edit] of step.edits.entries()) {
        const eat = `${at}.edits[${j}]`;
        const links = { old_string: archiveLinkIn(edit.old_string, schema), new_string: archiveLinkIn(edit.new_string, schema) };
        for (const key of ["old_string", "new_string"] as const) {
          if (links[key]) problem(`${eat}.${key}`, `holds the archive link "${links[key]}"; an import rewrites links, so an edit leaves them alone`);
        }
        for (const marker of new Set([...edit.new_string.matchAll(MARKER)].map((m) => Number(m[1])))) {
          if (!cited.has(marker)) problem(`${eat}.new_string`, `holds [^${marker}], which no citation of this step has; Stuga renumbers it, and it would show no source`);
        }
        if (links.old_string) {
          found = false;
          continue;
        }
        const n = occurrences(text, edit.old_string);
        const meets = meetsDestination(text, written, edit.old_string);
        if (n === 1 && !meets) {
          const hit = text.indexOf(edit.old_string);
          text = text.slice(0, hit) + renumbered(edit.new_string) + text.slice(hit + edit.old_string.length);
          continue;
        }
        found = false;
        const where = text === fresh ? step.doc : `${step.doc} as the earlier edits leave it`;
        // The body as an import writes it differs from the body only in its destinations.
        if (meets || (text === fresh && occurrences(body, edit.old_string) === 1)) {
          problem(`${eat}.old_string`, "could fall in a link or image destination, which an import rewrites to a node URL with random ids");
        } else {
          problem(`${eat}.old_string`, n === 0 ? `does not occur in ${where}` : `occurs ${n} times in ${where}; it must occur once`);
        }
      }
      for (const [j, citation] of (step.citations ?? []).entries()) {
        const cat = `${at}.citations[${j}]`;
        if (!step.edits.some((e) => e.new_string.includes(`[^${citation.n}]`))) problem(`${cat}.n`, `no new_string of this step holds [^${citation.n}]`);
        const source = bodies.get(citation.doc);
        if (source !== undefined && !source.includes(citation.content) && !plainText(docOf(source)).includes(citation.content)) {
          problem(`${cat}.content`, `does not occur in ${citation.doc}`);
        }
      }
      if (!found) {
        proposed.set(step.doc, text);
        continue;
      }
      const size = importedBytes(next);
      if (size > MAX_IMPORT_MARKDOWN_BYTES) {
        problem(`${at}.edits`, `leave ${step.doc} ${size} bytes, more than a proposed body may be (${MAX_IMPORT_MARKDOWN_BYTES})`);
      }
      // What the route stores and a later step reads: the result as Stuga writes it.
      let canonical: string;
      try {
        canonical = docToMarkdown(markdownToDoc(next, schema));
      } catch {
        canonical = next;
      }
      if (canonical === start) problem(`${at}.edits`, "changes nothing once Stuga writes it, so an import would have nothing to propose");
      proposed.set(step.doc, canonical);
    } else if (step.kind === "row") {
      const table = index.databases.get(step.database)?.tables.find((t) => t.name === step.table);
      if (table && rows.get(table.file)?.has(step.row) === false) problem(`${at}.row`, `"${step.row}" is not a row of ${table.file}`);
    } else if (step.quote !== undefined) {
      const body = bodies.get(step.doc);
      const n = body === undefined ? 1 : occurrences(quoteText(docOf(body)), step.quote);
      if (n !== 1) problem(`${at}.quote`, n === 0 ? `does not occur in ${step.doc}` : `occurs ${n} times in ${step.doc}; it must occur once to be placed`);
    }
  }
}

/** Run `stuga-node archive check`: exit 0 when the archive passes, 2 when it does not. */
export async function runArchiveCommand(argv: string[], write: (text: string) => void): Promise<ExitCode> {
  const [sub, ...rest] = argv;
  const args = rest.filter((a) => !a.startsWith("--"));
  const flags = rest.filter((a) => a.startsWith("--"));
  if (sub !== "check" || args.length !== 1 || flags.some((f) => f !== "--json")) throw refused(`usage: ${ARCHIVE_USAGE}`);
  const json = flags.includes("--json");
  const dir = resolve(args[0]!);
  const info = await stat(dir).catch(() => null);
  if (!info) throw refused(`${args[0]} does not exist`);
  if (!info.isDirectory()) throw refused(`${args[0]} is not a directory; unzip the archive and check the folder it makes`);

  const { issues, counts } = await checkArchive(await directoryFiles(dir));
  if (json) {
    // JSON.stringify leaves C1 and direction characters raw; escaped, they read the same.
    write(`${escaped(JSON.stringify({ ok: issues.length === 0, counts, issues }))}\n`);
  } else {
    for (const issue of issues) {
      write(`${escaped(issue.at)}: ${escaped(issue.message)}\n`);
      if (issue.diff) write(`${issue.diff.replace(/^/gm, "    ")}\n`);
    }
    const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
    const summary = [n(counts.items, "item"), n(counts.bodies, "body", "bodies"), n(counts.rows, "row"), n(counts.images, "image"), n(counts.steps, "sample step")].join(", ");
    write(issues.length ? `${n(issues.length, "problem")} in ${dir} (${summary})\n` : `${dir} passes: ${summary}\n`);
  }
  return issues.length ? 2 : 0;
}
