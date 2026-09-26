/**
 * Renders assistant markdown for the AI panels. `html:false` escapes raw HTML,
 * so the output is safe for dangerouslySetInnerHTML. Citation markers become
 * chips in the text-token rule, never in the final HTML, so brackets inside
 * code spans or attribute values are left alone.
 */
import MarkdownIt from "markdown-it";
import { renderImageCaptions } from "../editor/image-caption-markdown";
import { renderTextDirection } from "../editor/text-direction-markdown";
import { denseFootnoteMap } from "@stuga/crdt-ops";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
renderImageCaptions(md);
renderTextDirection(md);

/** Env threaded through md.render to the text rule. */
interface CiteEnv {
  cites?: AiCitation[];
  /** Raw citation number → display number (1, 2, … by first appearance). */
  renumber?: Map<number, number>;
  /** Render every marker as an inert chip; no citation exists to open yet. */
  pending?: boolean;
}

/** Escape a string for safe interpolation into an HTML attribute value. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CITE_MARKER = /\[\^?(\d+)\]/g;

/**
 * Escape a text token, turning `[n]`/`[^n]` markers that match a citation into
 * chips. Under `pending` only the `[^n]` form becomes an inert chip, so a plain
 * `array[0]` is never dressed up as a source.
 */
function renderTextWithCitations(
  content: string,
  cites: AiCitation[],
  renumber?: Map<number, number>,
  pending?: boolean,
): string {
  let out = "";
  let last = 0;
  CITE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_MARKER.exec(content)) !== null) {
    const raw = Number(m[1]);
    const cite = cites.find((c) => c.n === raw);
    const pendingHere = !cite && pending && m[0].startsWith("[^");
    if (!cite && !pendingHere) continue;
    out += md.utils.escapeHtml(content.slice(last, m.index));
    const display = renumber?.get(raw) ?? raw;
    if (cite) {
      const title = escapeAttr(`Source: ${cite.title}`);
      out += `<button class="citation-ref" data-cite-raw="${raw}" data-cite-display="${display}" title="${title}">[${display}]</button>`;
    } else {
      // No data-cite-raw, so the delegated click handler ignores it.
      out += `<span class="citation-ref citation-ref--pending" title="Source appears when the answer finishes">[${display}]</span>`;
    }
    last = m.index + m[0].length;
  }
  out += md.utils.escapeHtml(content.slice(last));
  return out;
}

md.renderer.rules.text = (tokens, idx, _options, env) => {
  const content = tokens[idx]!.content;
  const { cites, renumber, pending } = (env ?? {}) as CiteEnv;
  if ((!cites || cites.length === 0) && !pending) return md.utils.escapeHtml(content);
  return renderTextWithCitations(content, cites ?? [], renumber, pending);
};

/**
 * Render one assistant turn. Chips carry the raw citation number
 * (data-cite-raw) and its display number (data-cite-display). `pending` is for
 * a turn still streaming, before its citations arrive; the display numbers are
 * prefix-stable, so a chip never renumbers as text streams in.
 */
export function renderAssistantHtml(
  text: string,
  citations?: AiCitation[],
  opts?: { pending?: boolean },
): string {
  const cites = citations ?? [];
  const pending = !!opts?.pending && cites.length === 0;
  if (cites.length === 0 && !pending) return md.render(text);
  const renumber = denseFootnoteMap(text, 1);
  return md.render(text, { cites, renumber, pending } satisfies CiteEnv);
}
