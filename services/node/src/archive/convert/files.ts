/** Paths, links and text files as the converters read them from an export. */
import { MAX_IMPORT_MARKDOWN_BYTES } from "@stuga/protocol/text/markdown-import";
import type { SourceFile } from "./source.js";

/** A file Stuga can show as an image, by its name; its bytes are checked when it is copied. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/** The folder `path` lies in, "" at the top. */
export const dirname = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** `path` from the folder `base`, with `.` and `..` resolved, or null when it climbs out of the export. */
export function withinSource(base: string, path: string): string | null {
  const out = base ? base.split("/") : [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.length ? out.join("/").normalize("NFC") : null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A text file's text, cleaned as an imported Markdown file is: no byte order mark, `\n` line ends,
 * and no control character Postgres refuses. Null for a file over `maxBytes`, a body's cap unless
 * given, or not UTF-8.
 */
export async function readText(file: SourceFile, maxBytes = MAX_IMPORT_MARKDOWN_BYTES): Promise<string | null> {
  if (file.size > maxBytes) return null;
  let text: string;
  try {
    text = UTF8.decode(await file.read());
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** How a converter writes a link it already resolved to a source file, for its resolver to read back. */
const SOURCE_SCHEME = "stuga-source:";

export const sourceHref = (path: string): string => `${SOURCE_SCHEME}${encodeURIComponent(path)}`;

export type SourceTarget =
  /** A source file a converter resolved. */
  | { kind: "source"; path: string }
  /** A path relative to the body, %-escapes decoded, without its `#fragment` or `?query`. */
  | { kind: "relative"; path: string }
  /** A URL outside the export, kept as written. */
  | { kind: "outside"; href: string }
  /** A bare `#fragment`, kept as written. */
  | { kind: "fragment"; href: string }
  | { kind: "none" };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** What a link or image destination in an export's Markdown names. */
export function sourceTarget(href: string): SourceTarget {
  if (href.startsWith(SOURCE_SCHEME)) return { kind: "source", path: decoded(href.slice(SOURCE_SCHEME.length)) };
  if (href.startsWith("#")) return href.length > 1 ? { kind: "fragment", href } : { kind: "none" };
  if (href.startsWith("obsidian:")) {
    // `obsidian://open?vault=Notes&file=Folder%2FNote` names a note of the vault.
    const file = URL.canParse(href) ? new URL(href).searchParams.get("file") : null;
    return file ? { kind: "relative", path: `/${file}` } : { kind: "none" };
  }
  // An image written into the page, which an import would keep as a URL of any length.
  if (href.startsWith("//") || /^data:/i.test(href)) return { kind: "none" };
  if (SCHEME.test(href)) return { kind: "outside", href };
  const path = decoded(href.replace(/[?#].*$/, ""));
  return path ? { kind: "relative", path } : { kind: "none" };
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text).normalize("NFC");
  } catch {
    return text.normalize("NFC");
  }
}
