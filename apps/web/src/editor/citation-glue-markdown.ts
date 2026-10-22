/** Citation markers for the read-only markdown renderers, kept on the line of the word before them, as in the editor. */

/** A text run's pieces: text still to escape, or a citation marker's HTML. */
export type GluePiece = string | { marker: string };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Where the last character before `text`'s trailing spaces starts, or 0 if it is all spaces. */
function hugStart(text: string): number {
  const word = text.trimEnd();
  return word ? graphemes.segment(word).containing(word.length - 1)!.index : 0;
}

/** Where the character `text` opens with ends, or 0 if it opens with a space. */
function leadEnd(text: string): number {
  const first = graphemes.segment(text).containing(0);
  return first && /\S/.test(first.segment) ? first.segment.length : 0;
}

/**
 * `pieces` as HTML, each run of markers in a span that does not wrap (`.citation-glue`) together
 * with the spaces and character before it and the character after it. A chip that is a <button> is
 * an atomic inline, which a line may break around whatever touches it, so the span holds both sides.
 */
export function glueCitations(pieces: readonly GluePiece[], escape: (text: string) => string): string {
  let out = "";
  let text = "";
  let open = false;
  for (const piece of pieces) {
    if (typeof piece === "string") {
      text += piece;
      continue;
    }
    const lead = open ? leadEnd(text) : 0;
    const cut = hugStart(text);
    // Between two markers, text too short to break in stays inside the one span.
    if (open && cut <= lead) out += escape(text);
    else out += `${escape(text.slice(0, lead))}${open ? "</span>" : ""}${escape(text.slice(lead, cut))}<span class="citation-glue">${escape(text.slice(cut))}`;
    out += piece.marker;
    open = true;
    text = "";
  }
  if (!open) return escape(text);
  const lead = leadEnd(text);
  return `${out}${escape(text.slice(0, lead))}</span>${escape(text.slice(lead))}`;
}
