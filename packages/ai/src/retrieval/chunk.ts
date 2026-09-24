/**
 * Chunking for embeddings. Sizes are in characters (~4 per token): a recursive
 * splitter that breaks on the most natural separator under the cap, and a
 * heading-aware splitter that makes each Markdown section a citable chunk.
 */

export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 200;

// Coarse to fine; "" is a hard character cut.
const SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""];

/** Overlapping chunks of at most `size` chars; the overlap starts on a word boundary. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const pieces = splitRecursive(clean, size, SEPARATORS);
  return mergeWithOverlap(pieces, size, overlap);
}

/** Pieces of at most `size`, recursing to finer separators; not yet merged or overlapped. */
function splitRecursive(text: string, size: number, separators: string[]): string[] {
  if (text.length <= size) return text ? [text] : [];

  const [sep, ...rest] = separators;
  if (sep === undefined || sep === "") {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  const out: string[] = [];
  for (const part of splitKeepingSep(text, sep)) {
    if (part.length <= size) {
      if (part.trim()) out.push(part);
    } else {
      out.push(...splitRecursive(part, size, rest));
    }
  }
  return out;
}

/** Split on `sep`, keeping it attached to the preceding piece. */
function splitKeepingSep(text: string, sep: string): string[] {
  const parts = text.split(sep);
  return parts.map((p, i) => (i < parts.length - 1 ? p + sep : p)).filter((p) => p.length > 0);
}

/** Greedily pack pieces into chunks of at most `size`, then prepend each with the previous chunk's tail. */
function mergeWithOverlap(pieces: string[], size: number, overlap: number): string[] {
  const packed: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + p.length > size) {
      packed.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim()) packed.push(cur);

  if (overlap <= 0 || packed.length <= 1) return packed.map((c) => c.trim());

  return packed.map((chunk, i) => {
    if (i === 0) return chunk.trim();
    const prev = packed[i - 1]!;
    let tail = prev.slice(Math.max(0, prev.length - overlap));
    const sp = tail.indexOf(" ");
    if (sp > 0 && sp < tail.length - 1) tail = tail.slice(sp + 1);
    return `${tail.trim()} ${chunk.trim()}`.trim();
  });
}

// ---- Heading-aware chunking --------------------------------------------------

/** A section longer than this is subdivided. */
export const SECTION_MAX = 12_000;
/** Chunk size for Markdown with no headings. */
export const HEADINGLESS_TARGET = 6_000;

export interface HeadingChunk {
  content: string;
  /** "Overview > Geophysics > Internal heat"; "" for a preamble or headingless text. */
  headingPath: string;
}

/**
 * The exact text embedded for one chunk: its heading path, and the document
 * title on the first chunk. The write path, the reconcile path and the dedup
 * hash must all use this, so a hash always covers the bytes that were embedded.
 */
export function chunkEmbedInput(
  title: string,
  headingPath: string | null | undefined,
  content: string,
  isFirst: boolean,
): string {
  const hp = headingPath ? `${headingPath}\n\n` : "";
  return isFirst ? `${title}\n\n${hp}${content}` : `${hp}${content}`;
}

const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

interface Section {
  headingPath: string;
  content: string;
}

/** One chunk per heading section (oversize ones subdivided, small ones never merged); headingless text is paragraph-packed. */
export function headingAwareChunk(markdown: string): HeadingChunk[] {
  const clean = markdown.trim();
  if (!clean) return [];

  const sections = parseSections(clean);
  if (sections.length === 0) {
    return chunkText(clean, HEADINGLESS_TARGET, 0).map((content) => ({ content, headingPath: "" }));
  }
  return normalizeSections(sections);
}

/**
 * Sections in document order, each including its heading line; text before the
 * first heading is a preamble. Headings inside fenced code are ignored. [] when
 * there are no headings.
 */
function parseSections(md: string): Section[] {
  const lines = md.split("\n");
  let sawHeading = false;
  // The open fence's marker run; it closes only on a run of the same character at least as long.
  let fence: string | null = null;

  const raw: { level: number; title: string; body: string[] }[] = [];
  const preamble: string[] = [];
  for (const line of lines) {
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (fence === null) {
      if (marker) fence = marker;
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    }
    const m = fence === null && !marker ? ATX_HEADING.exec(line) : null;
    if (m) {
      sawHeading = true;
      raw.push({ level: m[1]!.length, title: m[2]!.trim(), body: [line] });
    } else if (raw.length === 0) {
      preamble.push(line);
    } else {
      raw[raw.length - 1]!.body.push(line);
    }
  }
  if (!sawHeading) return [];

  const out: Section[] = [];
  const pre = preamble.join("\n").trim();
  if (pre) out.push({ headingPath: "", content: pre });

  const stack: { level: number; title: string }[] = [];
  for (const sec of raw) {
    while (stack.length && stack[stack.length - 1]!.level >= sec.level) stack.pop();
    stack.push({ level: sec.level, title: sec.title });
    const headingPath = stack.map((s) => s.title).join(" > ");
    out.push({ headingPath, content: sec.body.join("\n").trim() });
  }
  return out;
}

/** Small sections are never merged: that would collapse distinct heading paths and blur citations. */
function normalizeSections(sections: Section[]): HeadingChunk[] {
  const out: HeadingChunk[] = [];
  for (const sec of sections) {
    if (!sec.content.trim()) continue;
    if (sec.content.length <= SECTION_MAX) {
      out.push({ content: sec.content, headingPath: sec.headingPath });
    } else {
      for (const piece of chunkText(sec.content, SECTION_MAX, 0)) {
        out.push({ content: piece, headingPath: sec.headingPath });
      }
    }
  }
  return out;
}
