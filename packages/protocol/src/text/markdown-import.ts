/**
 * Normalization for Markdown imported from outside the app, and the title the
 * resulting document gets. Runs in the node (the trust boundary) and in the web
 * import dialog (to preview the title), so both derive the same one.
 *
 * Transforms: strip a leading BOM (it hides the first heading), strip YAML
 * frontmatter (it parses as a thematic break plus a setext heading), drop C0
 * controls Postgres TEXT rejects, and normalize CRLF so no \r reaches the title.
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
  /** The body to seed the document with — normalized, frontmatter removed. */
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

/**
 * Strip a leading frontmatter block and return its `title:`. Only a closed block
 * whose every non-blank line looks like YAML counts, because a leading `---` is
 * also a valid thematic break.
 */
function stripFrontmatter(text: string): { body: string; title: string | null } {
  const lines = text.split("\n");
  if (lines.length === 0 || !FENCE.test(lines[0] ?? "")) return { body: text, title: null };

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close === -1) return { body: text, title: null };

  let title: string | null = null;
  const keys: string[] = [];
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (YAML_COMMENT.test(trimmed)) continue;
    // Indented lines and `- item` entries continue the preceding key.
    if (/^\s/.test(line) || /^-(?:\s|$)/.test(trimmed)) continue;
    if (!YAML_ENTRY.test(trimmed)) return { body: text, title: null };
    const kv = YAML_KEY_VALUE.exec(line);
    const key = (kv?.[1] ?? kv?.[2] ?? kv?.[3] ?? "").toLowerCase();
    keys.push(key);
    if (key === "title" && title === null) {
      const value = unquote(kv?.[4] ?? "");
      if (value) title = value;
    }
  }
  if (keys.length === 0) return { body: text, title: null };
  if (keys.length === 1 && !FRONTMATTER_KEYS.has(keys[0]!)) return { body: text, title: null };

  return { body: lines.slice(close + 1).join("\n"), title };
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
 * frontmatter title, filename or "Untitled" is prepended as an H1.
 */
export function normalizeImportedMarkdown(raw: string, opts: { filename?: string } = {}): ImportedMarkdown {
  const cleaned = (raw ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  const { body: afterFrontmatter, title: frontmatterTitle } = stripFrontmatter(cleaned);
  // trimEnd, not /\s+$/: that regex backtracks quadratically on a non-space tail.
  const body = afterFrontmatter.replace(/^\n+/, "").trimEnd();

  if (body === "") return { markdown: "", title: "" };

  const heading = leadingHeading(body.split("\n"));
  if (heading) return { markdown: body, title: heading };

  const fallback =
    (frontmatterTitle ? cleanTitle(frontmatterTitle) : "") ||
    (opts.filename ? titleFromFilename(opts.filename) : "") ||
    "Untitled";
  // The blank line keeps the body a separate block, whatever its first line holds.
  return { markdown: `# ${fallback}\n\n${body}`, title: fallback };
}
