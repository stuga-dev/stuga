/**
 * Floating card for a clicked citation marker: excerpt, source and an "Open
 * document" link. It is `position: fixed`, so it flips above its chip when it
 * would overflow the bottom and closes on scroll rather than detaching from it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { FileText } from "lucide-react";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { citationHref, readableExcerpt, sectionLabel, type CitationDetail } from "./citations";

/** Clearance kept from every window edge. */
const MARGIN = 8;
/** Half the card's fixed width (styles/ask.css), for the horizontal clamp. */
const HALF = 170;

/** `top` places the card below the chip; `anchorTop` is the edge it flips above. */
export interface CitationAnchor {
  top: number;
  left: number;
  anchorTop: number;
}

export function anchorBelow(el: Element): CitationAnchor {
  const r = el.getBoundingClientRect();
  return { top: r.bottom + 4, left: r.left + r.width / 2, anchorTop: r.top - 4 };
}

export function CitationPopover({
  citation,
  anchor,
  onClose,
}: {
  citation: CitationDetail;
  anchor: CitationAnchor;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const bye = () => onClose();
    document.addEventListener("keydown", onKey);
    // Deferred so the click that opened the card, and any scroll that focusing
    // its chip causes, don't close it straight away.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      window.addEventListener("scroll", bye, true);
      window.addEventListener("resize", bye);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", bye, true);
      window.removeEventListener("resize", bye);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const fitsBelow = anchor.top + h <= window.innerHeight - MARGIN;
    setTop(Math.max(MARGIN, fitsBelow ? anchor.top : anchor.anchorTop - h - MARGIN));
  }, [anchor.top, anchor.anchorTop, citation]);

  const left = Math.min(Math.max(anchor.left, HALF + MARGIN), window.innerWidth - HALF - MARGIN);
  const section = sectionLabel(citation.heading_path, citation.title);
  const source = section ? `${citation.title || "Untitled"} — ${section}` : citation.title || "Untitled";
  const excerpt = readableExcerpt(citation.content);

  return (
    <div ref={ref} className="citation-popover" style={{ top, left }} role="dialog" aria-label="Citation">
      {excerpt ? (
        <blockquote className="citation-popover__excerpt">{excerpt}</blockquote>
      ) : (
        <p className="citation-popover__empty">No excerpt available.</p>
      )}
      <div className="citation-popover__source" title={source}>
        <FileText size={13} />
        <span className="citation-popover__source-name">{source}</span>
      </div>
      {citation.doc_id ? (
        <a
          className="citation-popover__open"
          href={citationHref(citation)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
        >
          Open document ↗
        </a>
      ) : null}
    </div>
  );
}

/**
 * Popover state for rendered assistant HTML, whose `.citation-ref` chips carry
 * `data-cite-raw` (the citation's number) and `data-cite-display` (its label).
 */
export function useCitationPopover(): {
  onChipClick: (e: MouseEvent, citations: readonly AiCitation[] | undefined) => void;
  popover: ReactNode;
} {
  const [open, setOpen] = useState<{ citation: CitationDetail; anchor: CitationAnchor } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const onChipClick = useCallback((e: MouseEvent, citations: readonly AiCitation[] | undefined) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".citation-ref");
    if (!el) return;
    const raw = Number(el.dataset.citeRaw);
    const cite = citations?.find((c) => c.n === raw);
    if (!cite) return;
    setOpen({ citation: { ...cite, n: Number(el.dataset.citeDisplay) || raw }, anchor: anchorBelow(el) });
  }, []);
  const popover = open ? <CitationPopover citation={open.citation} anchor={open.anchor} onClose={close} /> : null;
  return { onChipClick, popover };
}
