/**
 * Deep links from a citation to its passage. A citation has no character
 * offset, so the opened document is searched by text: `q` (a slice of the
 * excerpt) lands on the paragraph, and `sec` (the whole heading path, since
 * section names repeat) is the fallback when Markdown syntax keeps `q` from
 * matching the rendered DOM.
 */
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";

/** A citation as the popover shows it. */
export interface CitationDetail {
  n: number;
  doc_id: string;
  title: string;
  heading_path?: string | null;
  /** Frozen excerpt of the cited passage; empty or absent when none was recorded. */
  content?: string | null;
}

/** Longest prefix of the excerpt worth putting in a URL. */
const SNIPPET_CHARS = 80;
/** Below this a match is more likely to be coincidence than the passage. */
const SNIPPET_MIN = 12;

/** "Doc > Phase 2 > 2.2 Hand-off" becomes ["Doc", "Phase 2", "2.2 Hand-off"]. */
export function headingSegments(headingPath?: string | null): string[] {
  if (!headingPath) return [];
  return headingPath.split(">").map((p) => p.trim()).filter(Boolean);
}

/**
 * The section a passage came from, without a leading segment that repeats the
 * document title shown right above it.
 */
export function sectionLabel(headingPath?: string | null, title?: string | null): string {
  const segs = headingSegments(headingPath);
  const t = (title ?? "").trim();
  if (segs.length > 1 && t && segs[0] === t) segs.shift();
  return segs.join(" › ");
}

/** The excerpt as readable prose: no heading lines (the card shows the section) and no Markdown syntax. */
export function readableExcerpt(content?: string | null): string {
  if (!content) return "";
  const body = content
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("#");
    })
    .join(" ");
  return stripMarkdown(body);
}

/** A distinctive slice of the excerpt's prose, cut on a word boundary so it can still match. */
export function excerptSnippet(content?: string | null): string {
  const cleaned = readableExcerpt(content);
  if (cleaned.length < SNIPPET_MIN) return "";
  if (cleaned.length <= SNIPPET_CHARS) return cleaned;
  const cut = cleaned.slice(0, SNIPPET_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > SNIPPET_MIN ? cut.slice(0, lastSpace) : cut;
}

/** Drop Markdown syntax so the text can be compared against rendered DOM text. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/`+/g, " ")
    .replace(/[*_~]+/g, " ")
    .replace(/^\s*>+/gm, " ")
    .replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Route + hints for opening a citation's document at its passage. */
export function citationHref(c: Pick<CitationDetail, "doc_id" | "heading_path" | "content">): string {
  const params = new URLSearchParams();
  const q = excerptSnippet(c.content);
  if (q) params.set("q", q);
  const sec = headingSegments(c.heading_path).join(" > ");
  if (sec) params.set("sec", sec);
  const qs = params.toString();
  return `/doc/${c.doc_id}${qs ? `?${qs}` : ""}`;
}

/** One entry per cited document, in first-cited order (a search returns several passages per document). */
export function citedSources(citations: readonly AiCitation[]): { doc_id: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const c of citations) if (!seen.has(c.doc_id)) seen.set(c.doc_id, c.title);
  return [...seen.entries()].map(([doc_id, title]) => ({ doc_id, title }));
}
