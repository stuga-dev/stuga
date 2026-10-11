/**
 * A folder of Markdown files as a workspace: an Obsidian vault, or notes from any app that writes
 * Markdown files. Each folder with notes in it is a folder, each note a document titled by its
 * first-level heading, else its `title:` property, else its file name, and each other file a note
 * links to or embeds goes along with it. Its properties are a list under the title. Obsidian's own
 * syntax is spelled as Stuga's Markdown: `[[links]]` and `![[embeds]]` resolved as Obsidian
 * resolves them, callouts as block quotes, `==highlights==` as bold, and `%%comments%%` and block
 * ids left out. What reads differently is noted in the conversion's changes.
 */
import { frontmatterList, stripFrontmatter } from "@stuga/protocol/text/markdown-import";
import { Changes, type Conversion, type DocEntry, type Entry, type FolderEntry, type LeftOutReason, type Resolved } from "./build.js";
import type { Source } from "./source.js";
import { IMAGE_FILE, dirname, readText, sourceHref, sourceTarget, unreadText, withinSource } from "./files.js";
import { escapeText, mapOutsideCodeSpans, mapProse } from "./text.js";

const NOTE = /\.(md|markdown)$/i;

/** Where a vault's links may lead, looked up as Obsidian looks them up. */
export class VaultIndex {
  /** Paths by path, ignoring case. */
  private readonly paths = new Map<string, string>();
  /** Paths by file name, ignoring case; a note's also by its name without `.md`. */
  private readonly names = new Map<string, string[]>();

  constructor(paths: Iterable<string>) {
    for (const path of [...paths].sort()) {
      this.paths.set(path.toLowerCase(), path);
      const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
      for (const key of NOTE.test(name) ? [name, name.replace(NOTE, "")] : [name]) {
        const list = this.names.get(key) ?? [];
        list.push(path);
        this.names.set(key, list);
      }
    }
  }

  /**
   * The file `target` names from the note at `from`: a path from the note's folder or the vault's
   * top (only the top when it starts with `/`), with or without `.md`, else the file of that name
   * nearest the note, as Obsidian's shortest links name one.
   */
  find(from: string, target: string): string | null {
    const wanted = target.replace(/^\/+/, "");
    if (wanted === "") return null;
    const bases = target.startsWith("/") ? [""] : [dirname(from), ""];
    for (const path of NOTE.test(wanted) ? [wanted] : [`${wanted}.md`, wanted]) {
      for (const base of bases) {
        const joined = withinSource(base, path);
        const found = joined === null ? undefined : this.paths.get(joined.toLowerCase());
        if (found) return found;
      }
    }
    const name = wanted.slice(wanted.lastIndexOf("/") + 1).toLowerCase();
    const suffix = `/${wanted.toLowerCase()}`;
    const named = (this.names.get(name) ?? []).filter((path) => !wanted.includes("/") || `/${path.toLowerCase()}`.endsWith(suffix) || `/${path.toLowerCase().replace(NOTE, "")}`.endsWith(suffix));
    if (named.length === 0) return null;
    const here = dirname(from);
    return named.find((path) => dirname(path) === here) ?? [...named].sort((a, b) => a.split("/").length - b.split("/").length)[0]!;
  }
}

/** `[[target#heading|alias]]`, with `!` before it for an embed. A `|` in a table is written `\|`. */
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const COMMENT = /%%[\s\S]*?%%/g;
const HIGHLIGHT = /==(?=\S)([^=\n]*?\S)==/g;
const BLOCK_ID = /\s+\^[A-Za-z0-9-]+$/;
const CALLOUT = /^(\s*(?:>\s*)+)\[!([A-Za-z0-9_-]+)\][+-]?\s*(.*)$/;
/** A Markdown image's size, which Obsidian reads from its text: `![Chart|300](chart.png)`. */
const IMAGE_SIZE = /(!\[[^\]|]*)\|\d+(?:x\d+)?\]\(/g;
const EXCALIDRAW = /^---\n(?:(?!---).*\n)*?excalidraw-plugin:/;
/** Obsidian's math, which Stuga keeps as the text it is written in: `$$E=mc^2$$`, or `$x$` hugging its text. */
const MATH = /\$\$[^$]+\$\$|\$(?=[^\s$])[^$\n]*[^\s$]\$(?!\d)/;

/** The vault's Markdown as Stuga's: see the module comment. What reads differently is noted in `changes`. */
export function vaultMarkdown(markdown: string, from: string, index: VaultIndex, changes = new Changes()): string {
  let inComment = false;
  const inline = (part: string): string => {
    if (MATH.test(part)) changes.note("math", from);
    return part
      .replace(COMMENT, "")
      .replace(WIKILINK, (_, bang: string, inner: string) => wikilink(bang === "!", inner, from, index, changes))
      .replace(HIGHLIGHT, (_, text: string) => {
        changes.note("highlight", from);
        return `**${text}**`;
      })
      .replace(IMAGE_SIZE, "$1](");
  };
  return mapProse(markdown, (line) => {
    // A comment may span lines: `%%` opens one that runs to the next `%%`.
    if (inComment) {
      const end = line.indexOf("%%");
      if (end < 0) return null;
      inComment = false;
      line = line.slice(end + 2);
    }
    const closed = line.replace(COMMENT, "");
    const open = closed.indexOf("%%");
    if (open >= 0) {
      inComment = true;
      line = closed.slice(0, open);
      if (line.trim() === "") return null;
    }
    const callout = CALLOUT.exec(line);
    if (callout) {
      // The title is a paragraph of its own, so the callout's text does not run on from it.
      const [, quote, kind, title] = callout;
      line = `${quote}**${title ? title : escapeText(kind![0]!.toUpperCase() + kind!.slice(1).toLowerCase())}**\n${quote!.trimEnd()}`;
    }
    return mapOutsideCodeSpans(line.replace(BLOCK_ID, ""), inline);
  });
}

/** A wikilink or embed as a Markdown link or image to the file it resolves to, or its text when it resolves to none. */
function wikilink(embed: boolean, inner: string, from: string, index: VaultIndex, changes: Changes): string {
  const bar = inner.search(/\\?\|/);
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const alias = bar < 0 ? null : inner.slice(bar).replace(/^\\?\|/, "").trim();
  const hash = target.indexOf("#");
  const path = hash < 0 ? target : target.slice(0, hash);
  const heading = hash < 0 ? "" : target.slice(hash + 1).replace(/^\^.*/, "");
  const found = path === "" ? null : index.find(from, path);
  const isImage = found !== null && IMAGE_FILE.test(found);
  // An image's alias is a size, as `![[chart.png|300]]`.
  const label = alias && !(isImage && /^\d+(x\d+)?$/.test(alias)) ? alias : heading ? `${path} > ${heading}` : path || heading;
  if (found && isImage && embed) return `![${escapeText(label === path ? "" : label)}](${sourceHref(found)})`;
  if (!found) {
    changes.note(embed && path !== "" && IMAGE_FILE.test(path) ? "missing_image" : "unresolved_link", from);
    return escapeText(label);
  }
  if (embed && NOTE.test(found)) changes.note("embedded_note", from);
  if (heading && NOTE.test(found)) changes.note("heading_link", from);
  // A note, or any other file, which goes along with the note.
  return `[${escapeText(label)}](${sourceHref(found)})`;
}

/**
 * The title of a note and its body, its properties a list under its first-level heading, or at its
 * top when it has none: then the title is the `title` property or the file's name, and the body
 * gains no heading.
 */
export function titled(markdown: string, fileName: string, key = fileName, changes = new Changes()): { title: string; markdown: string } {
  const { body, title: property, properties } = stripFrontmatter(markdown);
  const text = body.replace(/^\s*\n/, "");
  const [first = "", ...rest] = text.split("\n");
  const heading = /^# +(.+?)(?: +#+)? *$/.exec(first);
  const title = heading ? heading[1]!.trim() : property?.trim() || fileName;
  const list = frontmatterList(properties, title);
  if (list) changes.note("front_matter", key);
  if (heading && property?.trim() && property.trim() !== title) changes.note("title_differs", key);
  if (!list) return { title, markdown: text };
  if (!heading) return { title, markdown: text.trim() ? `${list}\n\n${text}` : list };
  return { title, markdown: [first, list, rest.join("\n").replace(/^\s*\n/, "")].filter((part) => part.trim() !== "").join("\n\n") };
}

/** Whether `source` is a folder of Markdown notes. */
export function isVault(source: Source): boolean {
  return [...source.files.keys()].some((path) => NOTE.test(path));
}

export async function convertVault(source: Source): Promise<Conversion> {
  const index = new VaultIndex(source.files.keys());
  const consumed = new Set<string>();
  const skipped = new Map<string, LeftOutReason>();
  const changes = new Changes();
  const root: FolderEntry = { kind: "folder", title: "", children: [] };
  const folders = new Map<string, FolderEntry>([["", root]]);
  const folderOf = (dir: string): FolderEntry => {
    let folder = folders.get(dir);
    if (!folder) {
      folder = { kind: "folder", title: dir.slice(dir.lastIndexOf("/") + 1), children: [] };
      folders.set(dir, folder);
      folderOf(dirname(dir)).children.push(folder);
    }
    return folder;
  };

  for (const file of [...source.files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!NOTE.test(file.path)) continue;
    const text = await readText(file);
    if (text === null) {
      skipped.set(file.path, unreadText(file));
      continue;
    }
    // A drawing the Excalidraw plugin keeps as a note holds its drawing as data, not text.
    if (EXCALIDRAW.test(text)) {
      skipped.set(file.path, { reason: "not_kept" });
      continue;
    }
    consumed.add(file.path);
    const note = titled(text, file.path.slice(file.path.lastIndexOf("/") + 1).replace(NOTE, ""), file.path, changes);
    const doc: DocEntry = { kind: "doc", key: file.path, title: note.title, markdown: vaultMarkdown(note.markdown, file.path, index, changes) };
    folderOf(dirname(file.path)).children.push(doc);
  }

  const resolve = (from: string, href: string): Resolved => {
    const target = sourceTarget(href);
    if (target.kind === "outside" || target.kind === "fragment") return { href: target.href };
    const found = target.kind === "source" ? target.path : target.kind === "relative" ? index.find(from, target.path) : null;
    if (!found) return null;
    if (IMAGE_FILE.test(found)) return { image: found };
    if (NOTE.test(found)) return consumed.has(found) ? { item: found } : null;
    return { file: found };
  };

  return { name: source.name ?? "Notes", entries: prune(root.children), resolve, consumed, skipped, changes };
}

/** `entries` less every folder that holds no document. */
function prune(entries: Entry[]): Entry[] {
  return entries.flatMap((entry): Entry[] => {
    if (entry.kind !== "folder") return [entry];
    const children = prune(entry.children);
    return children.length ? [{ ...entry, children }] : [];
  });
}
