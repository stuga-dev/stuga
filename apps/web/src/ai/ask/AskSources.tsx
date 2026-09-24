/**
 * The sources an answer was built on, as cards. `renumber` must be the same
 * denseFootnoteMap the renderer used, so a card's [n] matches its chip.
 */
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { Text } from "@astryxdesign/core/Text";
import { FileText } from "lucide-react";
import { citationHref, readableExcerpt, sectionLabel } from "../citations";

export function AskSources({ citations, renumber }: { citations: AiCitation[]; renumber: Map<number, number> }) {
  const shown = citations
    .filter((c) => renumber.has(c.n))
    .map((c) => ({
      c,
      display: renumber.get(c.n)!,
      section: sectionLabel(c.heading_path, c.title),
      excerpt: readableExcerpt(c.content),
    }))
    .sort((a, b) => a.display - b.display);
  if (shown.length === 0) return null;

  return (
    <div className="ask-sources-block">
      <Text type="label" as="div">
        Sources
      </Text>
      <div className="ask-source-grid">
        {shown.map(({ c, display, section, excerpt }) => (
          <a
            key={display}
            className="ask-source-card"
            // A new tab keeps the answer and its other sources on screen.
            href={citationHref(c)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open “${c.title || "Untitled"}” at this passage`}
          >
            <span className="ask-source-card__head">
              <span className="ask-source-card__n">[{display}]</span>
              <FileText size={13} aria-hidden />
              <span className="ask-source-card__title">{c.title || "Untitled"}</span>
            </span>
            {section && <span className="ask-source-card__section">{section}</span>}
            {excerpt && <span className="ask-source-card__excerpt">{excerpt}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
