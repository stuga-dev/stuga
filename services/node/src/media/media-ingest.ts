/**
 * Hosting the images an agent writes into Markdown. Each external or `data:`
 * image destination is fetched or decoded, stored like an upload and rewritten
 * to this node's media path. A failure leaves that destination as written and
 * is reported on an otherwise successful edit.
 */
import { fencedLines } from "@stuga/crdt-ops";
import type { NodeEnv } from "../env.js";
import {
  MediaValidationError,
  decodeBase64Image,
  fetchRemoteImage,
  imageUploadLimits,
  mediaUrl,
  storeImage,
  validateImageBytes,
} from "./media.js";
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";

/** The media store, the node's origin, and the settings whose upload ceiling an agent's image must meet. */
export type IngestEnv = Pick<NodeEnv, "media" | "publicOrigin" | "settings">;

/** Images fetched per edit; past it destinations are left alone and reported. */
const MAX_INGEST_PER_EDIT = 8;

export interface HostedImage {
  from: string;
  to: string;
}

export interface IngestResult {
  markdown: string;
  hosted: HostedImage[];
  /** Destinations left as written, with why. */
  failures: Array<{ url: string; reason: string }>;
  /** Whether MAX_INGEST_PER_EDIT stopped the pass before the end. */
  truncated: boolean;
}

/** A resolved image destination inside a Markdown string. */
interface ImageSpan {
  /** Offsets of the destination text only (not the `![alt](` / `)` around it). */
  start: number;
  end: number;
  dest: string;
  angled: boolean;
}

/** Undo CommonMark destination escaping (`\(` → `(`). */
const unescapeDest = (s: string): string => s.replace(/\\([\s\S])/g, "$1");

/** Re-escape a destination for the bare (non-angled) form. */
const escapeDest = (s: string): string => s.replace(/[()]/g, "\\$&");

/**
 * Every inline image destination outside fenced and inline code, where image
 * syntax is example text. Indented code blocks are not tracked: an edit fragment
 * carries no reliable indentation context.
 */
function scanImageDestinations(md: string): ImageSpan[] {
  const spans: ImageSpan[] = [];
  const lines = md.split("\n");
  const fenced = fencedLines(lines);
  /** Line start offset → the offset after that line, for lines inside a fence. */
  const fencedLineEnd = new Map<number, number>();
  let offset = 0;
  lines.forEach((line, k) => {
    if (fenced[k]) fencedLineEnd.set(offset, offset + line.length + 1);
    offset += line.length + 1;
  });

  let i = 0;
  while (i < md.length) {
    const skipTo = fencedLineEnd.get(i);
    if (skipTo !== undefined) {
      i = skipTo;
      continue;
    }
    const ch = md[i]!;

    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 0;
      while (md[i + run] === "`") run += 1;
      const close = md.indexOf("`".repeat(run), i + run);
      // An unclosed run is literal text.
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch !== "!" || md[i + 1] !== "[") {
      i += 1;
      continue;
    }

    let j = i + 2;
    let depth = 1;
    while (j < md.length && depth > 0) {
      if (md[j] === "\\") j += 2;
      else {
        if (md[j] === "[") depth += 1;
        else if (md[j] === "]") depth -= 1;
        j += 1;
      }
    }
    if (depth !== 0 || md[j] !== "(") {
      i += 2;
      continue;
    }
    j += 1;
    while (j < md.length && /\s/.test(md[j]!)) j += 1;

    const destStart = j;
    let dest: string;
    let angled = false;
    if (md[j] === "<") {
      angled = true;
      j += 1;
      const inner = j;
      while (j < md.length && md[j] !== ">" && md[j] !== "\n") {
        j += md[j] === "\\" ? 2 : 1;
      }
      if (md[j] !== ">") {
        i += 2;
        continue;
      }
      dest = unescapeDest(md.slice(inner, j));
      j += 1;
    } else {
      let parens = 0;
      const inner = j;
      while (j < md.length) {
        const c = md[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (/\s/.test(c)) break;
        if (c === "(") parens += 1;
        else if (c === ")") {
          if (parens === 0) break;
          parens -= 1;
        }
        j += 1;
      }
      dest = unescapeDest(md.slice(inner, j));
    }
    const destEnd = j;
    if (dest) spans.push({ start: destStart, end: destEnd, dest, angled });
    i = destEnd;
  }
  return spans;
}

/** The relative media path for a destination this node already serves, or null. */
function isAlreadyLocal(dest: string, env: IngestEnv): string | null {
  if (MEDIA_GET_PATH.test(dest)) return dest;
  let url: URL;
  try {
    url = new URL(dest);
  } catch {
    return null;
  }
  let sameHost = false;
  try {
    sameHost = !!env.publicOrigin && new URL(env.publicOrigin).host === url.host;
  } catch {
    sameHost = false;
  }
  // The node's own absolute URL collapses to the relative form, so the document works from any origin.
  return sameHost && MEDIA_GET_PATH.test(url.pathname) ? url.pathname : null;
}

const maxBytes = (env: IngestEnv): number => imageUploadLimits(env.settings.current().maxBodyBytes).bytes;

/** Store one destination in the document's workspace and return its media path. */
async function ingestOne(env: IngestEnv, workspaceId: string, docId: string, dest: string): Promise<string> {
  if (dest.startsWith("data:")) {
    if (!/^data:image\//i.test(dest)) throw new MediaValidationError(415, "data URI is not an image");
    const { bytes, mime } = validateImageBytes(decodeBase64Image(dest), maxBytes(env));
    const { hash } = await storeImage(env.media, workspaceId, bytes, mime);
    return mediaUrl(docId, hash);
  }
  const { bytes, mime } = await fetchRemoteImage(dest, maxBytes(env));
  const { hash } = await storeImage(env.media, workspaceId, bytes, mime);
  return mediaUrl(docId, hash);
}

/**
 * Rewrite every external image destination in `markdown` to one hosted in
 * `workspaceId`. `cache` is shared across the fields of one edit, which stays
 * within one workspace, so a URL is fetched once.
 */
export async function hostExternalImages(
  env: IngestEnv,
  workspaceId: string,
  docId: string,
  markdown: string,
  cache: Map<string, string | { error: string }> = new Map(),
): Promise<IngestResult> {
  const spans = scanImageDestinations(markdown);
  if (spans.length === 0) return { markdown, hosted: [], failures: [], truncated: false };

  const hosted: HostedImage[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  const rewrites = new Map<number, { end: number; text: string; angled: boolean }>();
  let fetched = 0;
  let truncated = false;

  for (const span of spans) {
    const local = isAlreadyLocal(span.dest, env);
    if (local) {
      if (local !== span.dest) rewrites.set(span.start, { end: span.end, text: local, angled: span.angled });
      continue;
    }
    // A relative path that is not media is a broken reference, not ours to host.
    if (!/^(https?:|data:)/i.test(span.dest)) continue;

    const cached = cache.get(span.dest);
    if (typeof cached === "string") {
      rewrites.set(span.start, { end: span.end, text: cached, angled: span.angled });
      hosted.push({ from: span.dest, to: cached });
      continue;
    }
    if (cached) {
      failures.push({ url: span.dest, reason: cached.error });
      continue;
    }
    if (fetched >= MAX_INGEST_PER_EDIT) {
      truncated = true;
      continue;
    }
    fetched += 1;
    try {
      const to = await ingestOne(env, workspaceId, docId, span.dest);
      cache.set(span.dest, to);
      rewrites.set(span.start, { end: span.end, text: to, angled: span.angled });
      hosted.push({ from: span.dest, to });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      cache.set(span.dest, { error: reason });
      failures.push({ url: span.dest, reason });
    }
  }

  if (rewrites.size === 0) return { markdown, hosted, failures, truncated };

  // Offsets are into the original string, so splicing in order keeps them valid.
  let out = "";
  let cursor = 0;
  for (const [start, r] of [...rewrites].sort((a, b) => a[0] - b[0])) {
    out += markdown.slice(cursor, start);
    out += r.angled ? `<${r.text}>` : escapeDest(r.text);
    cursor = r.end;
  }
  out += markdown.slice(cursor);
  return { markdown: out, hosted, failures, truncated };
}

/** What went wrong, for a person, who sees hosted images in the diff anyway. */
export function ingestWarning(failures: Array<{ url: string; reason: string }>, truncated: boolean): string {
  const parts = failures.map((f) => `Couldn’t download ${f.url} — ${f.reason}. The link was left as-is.`);
  if (truncated) parts.push(`Only the first ${MAX_INGEST_PER_EDIT} images were downloaded; the rest kept their original links.`);
  return parts.join(" ");
}

/** The note on an agent's result. It reports rewrites too, or the agent "corrects" a path it did not write. */
export function ingestNote(hosted: HostedImage[], failures: Array<{ url: string; reason: string }>, truncated: boolean): string {
  const parts: string[] = [];
  if (hosted.length) {
    parts.push(`Hosted ${hosted.length} image${hosted.length === 1 ? "" : "s"} in this workspace (external URLs were downloaded and rewritten to permanent /api/docs/…/media/… paths).`);
  }
  const warning = ingestWarning(failures, truncated);
  if (warning) parts.push(warning);
  return parts.join(" ");
}
