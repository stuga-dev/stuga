/**
 * Normalization for Markdown imported from outside the app, and the title the
 * resulting document gets. Runs in the node (the trust boundary) and in the web
 * import dialog (to preview the title), so both derive the same one.
 *
 * Transforms: strip a leading BOM (it hides the first heading), turn YAML
 * frontmatter (it parses as a thematic break plus a setext heading) into a list
 * under the title, drop C0 controls Postgres TEXT rejects, and normalize CRLF so
 * no \r reaches the title.
 */

/** Ceiling on one imported body, in UTF-8 bytes. The client checks it to fail fast; the server is the authority. */
export const MAX_IMPORT_MARKDOWN_BYTES = 4 * 1024 * 1024;

/** Files one batch import may select. A UI guard rail: each file is its own request. */
export const MAX_IMPORT_FILES = 50;

/** Matches the DocActor's own title clamp. */
const MAX_TITLE_CHARS = 200;
/** How much of a heading line cleanTitle reads; bounds its quadratic inline-stripping patterns. */
const TITLE_SCAN_CHARS = 4096;

export interface ImportedMarkdown {
  /** The body to seed the document with — normalized, frontmatter a list under the title. */
  markdown: string;
  /** Always the first non-blank line of `markdown` with its heading marker stripped. */
  title: string;
}

/** UTF-8 byte length, for checks against MAX_IMPORT_MARKDOWN_BYTES. */
export function markdownByteLength(markdown: string): number {
  return new TextEncoder().encode(markdown).byteLength;
}

/** A frontmatter fence: exactly `---` (or more dashes) alone on its line. */
const FENCE = /^-{3,}\s*$/;
/** A top-level frontmatter entry: permissive about the value, strict about the key (a bare or quoted word). */
const YAML_ENTRY = /^(?:"[^"]+"|'[^']+'|[A-Za-z0-9_.$-]+)\s*:(?:\s.*)?$/;
const YAML_KEY_VALUE = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.$-]+))\s*:\s?(.*)$/;
const YAML_COMMENT = /^#/;
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/;
const CODE_FENCE = /^ {0,3}(?:```|~~~)/;
/** Lines that open a non-paragraph block, so a `---` under them is a thematic break. */
const NON_PARAGRAPH_START = /^ {0,3}(?:[*+-]\s|\d+[.)]\s|>|\||#{1,6}\s|<)/;

/**
 * Keys a single-entry block must use to count as frontmatter, so a lone line of
 * prose like "TODO: finish the intro" between two rules is kept.
 */
const FRONTMATTER_KEYS = new Set([
  "title",
  "date",
  "author",
  "authors",
  "tags",
  "categories",
  "category",
  "slug",
  "description",
  "draft",
  "layout",
  "permalink",
  "summary",
  "keywords",
  "aliases",
  "created",
  "updated",
  "modified",
  "publish",
  "published",
  "status",
  "type",
  "weight",
  "id",
  "uuid",
  "cover",
  "image",
  "lang",
  "language",
  "series",
  "toc",
]);

/** One top-level frontmatter entry, its value read as one line of text: a list's items joined with commas. */
export interface FrontmatterProperty {
  key: string;
  value: string;
}

/**
 * Strip a leading frontmatter block and return its `title:` and its entries. Only a closed block
 * whose every non-blank line looks like YAML counts, because a leading `---` is also a valid
 * thematic break.
 */
export function stripFrontmatter(text: string): { body: string; title: string | null; properties: FrontmatterProperty[] } {
  const none = { body: text, title: null, properties: [] };
  const lines = text.split("\n");
  if (lines.length === 0 || !FENCE.test(lines[0] ?? "")) return none;

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close === -1) return none;

  let title: string | null = null;
  const entries: Array<{ key: string; inline: string; more: string[] }> = [];
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (YAML_COMMENT.test(trimmed)) continue;
    // Indented lines and `- item` entries continue the preceding key.
    if (/^\s/.test(line) || /^-(?:\s|$)/.test(trimmed)) {
      entries.at(-1)?.more.push(trimmed);
      continue;
    }
    if (!YAML_ENTRY.test(trimmed)) return none;
    const kv = YAML_KEY_VALUE.exec(line);
    const key = kv?.[1] ?? kv?.[2] ?? kv?.[3] ?? "";
    entries.push({ key, inline: kv?.[4] ?? "", more: [] });
    if (key.toLowerCase() === "title" && title === null) {
      const value = unquote(kv?.[4] ?? "");
      if (value) title = value;
    }
  }
  if (entries.length === 0) return none;
  if (entries.length === 1 && !FRONTMATTER_KEYS.has(entries[0]!.key.toLowerCase())) return none;

  const properties = entries.flatMap(({ key, inline, more }) => {
    const value = yamlText(inline, more);
    return value ? [{ key, value }] : [];
  });
  return { body: lines.slice(close + 1).join("\n"), title, properties };
}

/**
 * An entry's value as one line: a scalar unquoted, `[a, b]` or a `- item` list as `a, b`, a block
 * scalar's lines joined, and a nested map's `key: value` lines joined with commas.
 */
function yamlText(inline: string, more: string[]): string {
  const raw = inline.trim();
  // An unquoted value ends where a comment starts.
  const value = /^["']/.test(raw) ? raw : raw.replace(/\s+#.*$/, "");
  if (/^[|>][-+]?\d*$/.test(value)) return more.join(" ").trim();
  if (value.startsWith("[") && value.endsWith("]")) return listText(value.slice(1, -1).split(","));
  if (value) return unquote(value);
  return listText(more.map((line) => line.replace(/^-\s*/, "")));
}

const listText = (items: string[]): string =>
  items
    .map(unquote)
    .filter((item) => item !== "")
    .join(", ");

/** Obsidian's styling of a note, which says nothing about it. */
const STYLING_KEYS = new Set(["cssclass", "cssclasses"]);

/** Text as Markdown that reads as that text. */
const escapeMarkdown = (text: string): string => text.replace(/[\\`*_[\]<>#!|~&]/g, "\\$&");

/**
 * Frontmatter entries as a Markdown list, one `key: value` item each, so what they said stays
 * visible in the document; "" for none. `title`, which names the document, is left out when it
 * says what the document is titled.
 */
export function frontmatterList(properties: readonly FrontmatterProperty[], title: string): string {
  const shown = properties.filter(({ key, value }) => {
    const name = key.toLowerCase();
    if (STYLING_KEYS.has(name)) return false;
    return !(name === "title" && cleanTitle(value) === title);
  });
  return shown.map(({ key, value }) => `- ${escapeMarkdown(key)}: ${escapeMarkdown(value.replace(/\s+/g, " "))}`).join("\n");
}

/** Drop matching surrounding quotes from a YAML scalar. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Reduce a heading's Markdown to the plain text the document will hold, so the
 * stored title equals what the DocActor derives from the body on flush.
 */
function cleanTitle(raw: string): string {
  // Clamp before stripping: several patterns are quadratic in the line length.
  const text = raw.slice(0, TITLE_SCAN_CHARS)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → its alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link → its label
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1") // reference link → its label
    .replace(/`+([^`]*)`+/g, "$1") // code span → its content
    .replace(/(\*\*\*|___)(.*?)\1/g, "$2") // bold+italic
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, "$1"); // unescape
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

/** "My Notes.md" → "My Notes". */
function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return cleanTitle(base.replace(/\.(md|markdown|mdown|mkd|txt)$/i, "").replace(/[_-]+/g, " "));
}

/** The leading ATX or setext heading, if the first non-blank block is one. */
function leadingHeading(lines: string[]): string | null {
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length) return null;

  const first = lines[i] ?? "";
  // Fenced or indented code is not a heading, and a `---` after a fence line is code.
  if (CODE_FENCE.test(first)) return null;
  if (/^ {4,}\S/.test(first)) return null;

  const atx = ATX_HEADING.exec(first);
  if (atx) {
    const text = cleanTitle(atx[2]!.replace(/\s+#+\s*$/, ""));
    return text || null;
  }

  // A setext underline only applies to a paragraph above it.
  const next = lines[i + 1];
  if (next !== undefined && SETEXT_UNDERLINE.test(next) && first.trim() !== "" && !NON_PARAGRAPH_START.test(first)) {
    return cleanTitle(first) || null;
  }
  return null;
}

/**
 * Normalize imported Markdown and decide its title. The DocActor re-derives
 * `docs.title` from the body's first non-blank line on every flush, so the title
 * must be that line: a leading heading is the title as-is; otherwise the
 * frontmatter title, filename or "Untitled" is prepended as an H1. The
 * frontmatter's entries follow the title as a list.
 */
export function normalizeImportedMarkdown(raw: string, opts: { filename?: string } = {}): ImportedMarkdown {
  const cleaned = (raw ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  const { body: afterFrontmatter, title: frontmatterTitle, properties } = stripFrontmatter(cleaned);
  // trimEnd, not /\s+$/: that regex backtracks quadratically on a non-space tail.
  const body = afterFrontmatter.replace(/^\n+/, "").trimEnd();

  const lines = body.split("\n");
  const heading = leadingHeading(lines);
  const title =
    heading ||
    (frontmatterTitle ? cleanTitle(frontmatterTitle) : "") ||
    (opts.filename ? titleFromFilename(opts.filename) : "") ||
    "Untitled";
  // The frontmatter shows as a list under the title, so nothing it said is lost.
  const list = frontmatterList(properties, title);
  if (body === "" && list === "") return { markdown: "", title: "" };
  if (heading) {
    const end = headingEnd(lines);
    const rest = lines.slice(end).join("\n").replace(/^\n+/, "");
    const head = lines.slice(0, end).join("\n");
    return { markdown: [head, list, rest].filter((part) => part !== "").join("\n\n"), title };
  }
  // The blank lines keep the body a separate block, whatever its first line holds.
  return { markdown: [`# ${title}`, list, body].filter((part) => part !== "").join("\n\n"), title };
}

/** The index of the line after the leading heading leadingHeading found: one line for ATX, two for setext. */
function headingEnd(lines: string[]): number {
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  return ATX_HEADING.test(lines[i] ?? "") ? i + 1 : i + 2;
}
