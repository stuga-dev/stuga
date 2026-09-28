/**
 * A Notion export (Markdown & CSV) as a workspace. Notion names each page `<title> <id>.md` and
 * puts its subpages in a folder beside it, `<title> <id>/`; a database is `<title> <id>_all.csv`,
 * with every property, beside `<title> <id>.csv`, the view it was exported from, and its row pages
 * in the folder of the same name. So a page is a document, a page with subpages a folder holding
 * the page and its subpages, a database a database with a page for each row whose page holds more
 * than its properties (in a folder with what else its row pages hold), and any other folder, such as
 * a teamspace's, a folder. Links name pages by
 * id, so they lead where they did whichever folder a page lands in.
 */
import { parseCsv } from "../../databases/imports/format.js";
import { ARCHIVE_MAX_TABLE_FILE_BYTES, ArchiveError } from "../format.js";
import type { Conversion, DatabaseEntry, DocEntry, Entry, Resolved } from "./build.js";
import { IMAGE_FILE, dirname, readText, sourceTarget, withinSource } from "./files.js";
import type { Source } from "./source.js";
import { csvTable } from "./table.js";
import { headingLine, mapOutsideCodeSpans, mapProse, taskBox } from "./text.js";

/** `Title 0123456789abcdef0123456789abcdef.md`, and a database's `….csv` or `…_all.csv`. */
const NAMED = /^(.*?) ?([0-9a-f]{32})(_all)?\.(md|csv)$/;
/** An id in a Notion URL, dashed or not: `notion.so/Title-0123…` or `…/01234567-89ab-…`. */
const URL_ID = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i;
const HTML_PAGE = /^(.*?) ?[0-9a-f]{32}\.html$/;
/** The export's map of its pages, which also names the workspace. */
const INDEX = "index.html";
const WORKSPACE_NAME = /Workspace name: (.*?)<\/p>/;

interface Named {
  path: string;
  /** Where its subpages or row pages sit: its path less the extension. */
  folder: string;
  title: string;
  id: string;
  kind: "md" | "csv";
  /** A database's `_all.csv`, which holds every property. */
  all: boolean;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function named(path: string): Named | null {
  const m = NAMED.exec(baseName(path));
  if (!m) return null;
  const [, title, id, all = "", kind] = m;
  const folder = path.slice(0, path.length - `${all}.${kind}`.length);
  return { path, folder, title: title!.trim() || "Untitled", id: id!, kind: kind as Named["kind"], all: all !== "" };
}

/** Whether `source` is a Notion export: its pages and databases carry Notion's ids. Refuses Notion's HTML export, which it does not read. */
export function isNotionExport(source: Source): boolean {
  const paths = [...source.files.keys()];
  const md = paths.filter((p) => /\.(md|csv)$/i.test(p));
  const ids = md.filter((p) => named(p) !== null).length;
  if (md.length === 0 && paths.some((p) => HTML_PAGE.test(baseName(p)))) {
    throw new ArchiveError("", "this is Notion's HTML export; export as Markdown & CSV instead");
  }
  return ids > 0 && ids * 2 >= md.length;
}

/** A property line at the head of a row page: `Status: Done`. */
const PROPERTY = /^([^:\n]{1,200}): (.*)$/;

/**
 * A row page's body with the property lines Notion writes under its title left out, since the row
 * holds them: the lines up to the first that names no column. Null when nothing else is left.
 */
function withoutProperties(markdown: string, columns: ReadonlySet<string>): string | null {
  const lines = markdown.split("\n");
  let at = 1;
  while (at < lines.length && lines[at]!.trim() === "") at++;
  while (at < lines.length && columns.has(PROPERTY.exec(lines[at]!)?.[1]?.trim() ?? "\0")) at++;
  const rest = lines.slice(at).join("\n").trim();
  return rest ? `${lines[0]!}\n\n${rest}` : null;
}

/** A reference to another page inside a cell: `Launch plan (../Projects%20a1…/Launch%20plan%20b2….md)`. */
const CELL_LINK = /\s*\((?:[^()\s]|\([^()\s]*\))*\.md\)/g;
/** A file a files property holds, by its path in the export: `Page%20a1…/brief.pdf`. */
const CELL_FILE = /^[^\s,()]+\/[^\s,()]*\.[A-Za-z0-9]{1,6}$/;

/** Whether one of a cell's comma-separated parts is a file's path. */
const isCellFile = (part: string): boolean => CELL_FILE.test(part) && !part.includes("://");

/** A cell as the table holds it: a page it links to as the page's title, and a file as its name. */
function cellText(cell: string): string {
  const text = cell.replace(CELL_LINK, "");
  const parts = text.split(", ");
  if (!parts.every(isCellFile)) return text;
  return parts.map((part) => decodedName(baseName(part))).join(", ");
}

function decodedName(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `records` with their columns in the order of `view`, the table as it was shown, the title first and the rest after. */
function inViewOrder(records: string[][], view: readonly string[]): string[][] {
  const header = (records[0] ?? []).map((name) => name.trim());
  const shown = view.map((name) => header.indexOf(name.trim())).filter((i) => i > 0);
  const order = [...new Set([0, ...shown, ...header.keys()])];
  return records.map((record) => order.map((i) => record[i] ?? ""));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeHtml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) =>
    code[0] === "#" ? String.fromCodePoint(Number(code[1] === "x" || code[1] === "X" ? `0${code.slice(1)}` : code.slice(1))) : (ENTITIES[code.toLowerCase()] ?? entity),
  );

/** A callout's icon, when it is an image rather than an emoji. */
const ICON = /<img [^>]*>\s*/g;
const SUMMARY = /^\s*<summary>(.*)<\/summary>\s*$/i;
const DETAILS = /^\s*<\/?details>\s*$/i;

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])(?:\s|$)/;

/**
 * Notion writes a block's children indented 4 spaces. Under a list item that nests them; under
 * anything else, such as a paragraph or a toggle heading, CommonMark reads them as code, which
 * Notion always fences. So those are taken out a level, as often as they nest.
 */
function unindentChildren(markdown: string): string {
  for (;;) {
    let underList = false;
    let changed = false;
    const out = mapProse(markdown, (line) => {
      if (line.trim() === "") return line;
      if (!line.startsWith("    ")) {
        underList = LIST_ITEM.test(line);
        return line;
      }
      if (underList) return line;
      changed = true;
      return line.slice(4);
    });
    if (!changed) return out;
    markdown = out;
  }
}

/** Notion's Markdown as Stuga's: children read as Notion nests them, callouts as block quotes, toggles as their bold title and what they hold, and task boxes as characters. */
export function notionMarkdown(markdown: string): string {
  let inAside = false;
  return mapProse(unindentChildren(markdown), (line) => {
    const trimmed = line.trim();
    if (/^<aside>$/i.test(trimmed)) {
      inAside = true;
      return null;
    }
    if (/^<\/aside>$/i.test(trimmed)) {
      inAside = false;
      return "";
    }
    if (DETAILS.test(line)) return null;
    const summary = SUMMARY.exec(line);
    const text = mapOutsideCodeSpans(taskBox(summary ? `**${summary[1]!.trim()}**` : line), (part) => part.replace(ICON, ""));
    return inAside ? `> ${text}`.trimEnd() : text;
  });
}

/** A folder's name as a title: a teamspace's folder may carry an id too. */
const folderTitle = (path: string): string => baseName(path).replace(/\s*[0-9a-f]{32}\s*$/, "").trim() || "Untitled";

export async function convertNotion(source: Source): Promise<Conversion> {
  const consumed = new Set<string>();
  const pages = new Map<string, Named>();
  const databases = new Map<string, Named>();
  /** A database's other CSV, the view it was exported from, which gives its columns' order. */
  const views = new Map<string, Named>();
  let workspace = "Notion";
  for (const path of source.files.keys()) {
    if (path === INDEX) {
      consumed.add(path);
      const name = WORKSPACE_NAME.exec((await readText(source.files.get(path)!)) ?? "")?.[1];
      if (name?.trim()) workspace = unescapeHtml(name).trim();
      continue;
    }
    const found = named(path);
    if (!found) continue;
    if (found.kind === "md") {
      pages.set(found.id, found);
      continue;
    }
    consumed.add(path);
    const known = databases.get(found.id);
    if (known?.all) views.set(found.id, found);
    else {
      if (known) views.set(found.id, known);
      databases.set(found.id, found);
    }
  }

  /** Where each page's links lead, by the source path of the page or database, and by its id. */
  const byPath = new Map<string, { item: string; row?: string }>();
  const byId = new Map<string, { item: string; row?: string }>();
  const place = (item: Named, to: { item: string; row?: string }): void => {
    byPath.set(item.path, to);
    byId.set(item.id, to);
  };

  // A stub page Notion writes for a full-page database carries the database's id; the database is the page.
  for (const [id, db] of databases) {
    const stub = pages.get(id);
    if (!stub) continue;
    consumed.add(stub.path);
    pages.delete(id);
    byPath.set(stub.path, { item: db.path });
  }
  // A linked view is a CSV of its own with no `_all`, named as the database it shows, which has one.
  const withAll = new Map([...databases.values()].filter((db) => db.all).map((db) => [db.title.toLowerCase(), db]));
  const linked = new Map<string, Named>();
  for (const db of databases.values()) {
    const shown = db.all ? undefined : withAll.get(db.title.toLowerCase());
    if (shown) linked.set(db.id, shown);
  }

  const inFolder = new Map<string, Named[]>();
  for (const item of [...pages.values(), ...databases.values()]) inFolder.set(dirname(item.path), [...(inFolder.get(dirname(item.path)) ?? []), item]);
  const subfolders = new Map<string, string[]>();
  const folders = new Set<string>();
  for (const path of source.files.keys()) {
    for (let dir = dirname(path); dir && !folders.has(dir); dir = dirname(dir)) {
      folders.add(dir);
      subfolders.set(dirname(dir), [...(subfolders.get(dirname(dir)) ?? []), dir]);
    }
  }
  /** The folder a page's subpages or a database's row pages sit in: `Title <id>/`, or `Title/`. */
  const ownFolder = (item: Named): string | null => {
    if (folders.has(item.folder)) return item.folder;
    const plain = withinSource(dirname(item.path), item.title);
    return plain !== null && folders.has(plain) ? plain : null;
  };

  const read = async (page: Named): Promise<string | null> => {
    const text = await readText(source.files.get(page.path)!);
    if (text !== null) consumed.add(page.path);
    return text;
  };
  const docOf = (page: Named, markdown: string | null): DocEntry => {
    const body = notionMarkdown(markdown ?? "").replace(/^\s+/, "");
    return { kind: "doc", key: page.path, title: page.title, markdown: body.startsWith("# ") ? body : `${headingLine(page.title)}\n\n${body}`.trimEnd() };
  };

  /** What `dir` holds, less `skip`: its pages and databases, and the folders none of them owns. */
  const entriesIn = async (dir: string, skip: ReadonlySet<string> = new Set()): Promise<Entry[]> => {
    const out: Entry[] = [];
    const owned = new Set<string>();
    for (const item of (inFolder.get(dir) ?? []).sort((a, b) => a.title.localeCompare(b.title))) {
      if (skip.has(item.path)) continue;
      const folder = ownFolder(item);
      if (folder) owned.add(folder);
      if (databases.get(item.id) === item) {
        const shown = linked.get(item.id);
        if (!shown) out.push(...(await databaseEntries(item, folder)));
        else {
          place(item, { item: shown.path });
          if (folder) out.push(...(await entriesIn(folder)));
        }
        continue;
      }
      const doc = docOf(item, await read(item));
      const children = folder ? await entriesIn(folder) : [];
      place(item, { item: item.path });
      out.push(children.length ? { kind: "folder", title: item.title, children: [doc, ...children] } : doc);
    }
    for (const folder of (subfolders.get(dir) ?? []).sort()) {
      if (owned.has(folder)) continue;
      const children = await entriesIn(folder);
      if (children.length) out.push({ kind: "folder", title: folderTitle(folder), children });
    }
    return out;
  };

  /**
   * A database, and with it what its folder holds that no row page can: pages no row names, and
   * row pages' subpages, the two together in a folder of the database's name.
   */
  const databaseEntries = async (db: Named, folder: string | null): Promise<Entry[]> => {
    const text = await readText(source.files.get(db.path)!, ARCHIVE_MAX_TABLE_FILE_BYTES);
    // A table it cannot read is left out, and its row pages kept as pages.
    if (text === null) {
      consumed.delete(db.path);
      return folder ? entriesIn(folder) : [];
    }
    let raw = parseCsv(text);
    const view = views.get(db.id);
    const viewText = view ? await readText(source.files.get(view.path)!, ARCHIVE_MAX_TABLE_FILE_BYTES) : null;
    if (viewText) raw = inViewOrder(raw, parseCsv(viewText)[0] ?? []);
    const records = raw.map((record) => record.map(cellText));
    const columns = new Set(records[0]?.map((name) => name.trim()) ?? []);
    // A files property's column: every cell a list of paths, and some of them files the export holds,
    // from the table's folder or the one above. The title is never one.
    const filesColumns = new Map<number, string[][]>();
    for (let c = 1; c < (raw[0]?.length ?? 0); c++) {
      const cells = raw.slice(1).map((record) => (record[c] ? record[c]!.split(", ") : []));
      if (!cells.every((parts) => parts.every(isCellFile))) continue;
      const files = cells.map((parts) =>
        parts.flatMap((part) => {
          const name = decodedName(part);
          const found = [dirname(db.path), dirname(dirname(db.path))].map((base) => withinSource(base, name)).find((path) => path !== null && source.files.has(path));
          return found ? [found] : [];
        }),
      );
      if (files.some((list) => list.length > 0)) filesColumns.set(c, files);
    }

    // Rows carry no id: a row page is matched to its row by its heading, which holds the whole
    // title where a file name may be cut short, in order.
    const rowPages = (folder ? (inFolder.get(folder) ?? []) : []).filter((item) => pages.get(item.id) === item);
    const texts = new Map<Named, string | null>();
    const waiting = new Map<string, Named[]>();
    for (const page of rowPages) {
      const markdown = await read(page);
      texts.set(page, markdown);
      const title = /^# (.+)$/.exec(markdown?.split("\n", 1)[0] ?? "")?.[1]?.trim() ?? page.title;
      waiting.set(title, [...(waiting.get(title) ?? []), page]);
    }
    const matched = records.slice(1).map((record) => waiting.get((record[0] ?? "").trim() || "Untitled")?.shift() ?? null);
    const table = csvTable(records, (i) => matched[i]?.id ?? `row-${i + 1}`, new Set([0]), filesColumns);

    const entry: DatabaseEntry = { kind: "database", key: db.path, title: db.title, columns: table.columns, rows: table.rows, pages: [] };
    place(db, { item: db.path });
    for (const [i, page] of matched.entries()) {
      if (!page) continue;
      const row = table.rows[i]!.key;
      const markdown = texts.get(page);
      const body = markdown ? withoutProperties(markdown, columns) : null;
      if (body === null) {
        place(page, { item: db.path, row });
        continue;
      }
      const doc = docOf(page, body);
      entry.pages.push({ key: page.path, row, title: doc.title, markdown: doc.markdown });
      place(page, { item: page.path });
    }
    // A page no row names, such as a template, stays a page when it holds more than properties.
    const loose: Entry[] = [];
    for (const page of rowPages) {
      if (matched.includes(page)) continue;
      const markdown = texts.get(page);
      const body = markdown ? withoutProperties(markdown, columns) : null;
      if (body === null) continue;
      loose.push(docOf(page, body));
      place(page, { item: page.path });
    }
    const rest = folder ? await entriesIn(folder, new Set(rowPages.map((page) => page.path))) : [];
    // What its folder holds besides rows goes with it, in a folder of its name, as Notion nests it.
    const beside = [...loose, ...rest];
    return beside.length ? [{ kind: "folder", title: db.title, children: [entry, ...beside] }] : [entry];
  };

  const entries = await entriesIn("");
  const top = inFolder.get("") ?? [];

  const resolve = (from: string, href: string): Resolved => {
    const target = sourceTarget(href);
    if (target.kind === "fragment") return { href: target.href };
    if (target.kind === "outside") {
      const id = /^https?:\/\/([^/]+\.)?notion\.(so|site)\//i.test(href) ? URL_ID.exec(href) : null;
      const to = id ? byId.get(id.slice(1).join("").toLowerCase()) : undefined;
      return to ?? { href: target.href };
    }
    if (target.kind === "source") return IMAGE_FILE.test(target.path) ? { image: target.path } : { file: target.path };
    if (target.kind !== "relative") return null;
    const path = withinSource(dirname(from), target.path);
    if (path === null) return null;
    const to = byPath.get(path) ?? byId.get(named(path)?.id ?? "");
    if (to) return to;
    // A page or database the export does not hold leads nowhere; any other file it holds is carried.
    if (!source.files.has(path) || named(path)) return null;
    return IMAGE_FILE.test(path) ? { image: path } : { file: path };
  };

  return {
    name: workspace,
    entries,
    start: top.length === 1 && pages.get(top[0]!.id) === top[0] ? top[0]!.path : undefined,
    resolve,
    consumed,
  };
}
