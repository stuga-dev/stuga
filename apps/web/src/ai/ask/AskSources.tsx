/**
 * The sources an answer was built on, as cards, one per document. `renumber`
 * must be the same denseFootnoteMap the renderer used, so a card's [n] matches
 * its chips.
 */
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { Text } from "@astryxdesign/core/Text";
import { FileText } from "lucide-react";
import { citationHref, readableExcerpt, sectionLabel } from "../citations";
import { t } from "../../i18n/i18n";

export interface SourceCard {
  /** The first-cited passage, which the card opens at. */
  c: AiCitation;
  /** Every number the answer cites this document by, ascending. */
  numbers: number[];
  /** Empty when it would only repeat the title. */
  section: string;
  excerpt: string;
}

/**
 * One card per document, in cited order: a search returns several passages of
 * one document, and two cards under one title read as a duplicate.
 */
export function sourceCards(citations: readonly AiCitation[], renumber: Map<number, number>): SourceCard[] {
  const byDoc = new Map<string, SourceCard>();
  const cited = citations
    .filter((c) => renumber.has(c.n))
    .map((c) => ({ c, display: renumber.get(c.n)! }))
    .sort((a, b) => a.display - b.display);
  for (const { c, display } of cited) {
    const card = byDoc.get(c.doc_id);
    if (card) {
      if (!card.numbers.includes(display)) card.numbers.push(display);
      continue;
    }
    const section = sectionLabel(c.heading_path, c.title);
    byDoc.set(c.doc_id, {
      c,
      numbers: [display],
      section: section === (c.title ?? "").trim() ? "" : section,
      excerpt: readableExcerpt(c.content),
    });
  }
  return [...byDoc.values()];
}

export function AskSources({ citations, renumber }: { citations: AiCitation[]; renumber: Map<number, number> }) {
  const cards = sourceCards(citations, renumber);
  if (cards.length === 0) return null;

  return (
    <div className="ask-sources-block">
      <Text type="label" as="div">
        {t("ai.ask.sources")}
      </Text>
      <div className="ask-source-grid">
        {cards.map(({ c, numbers, section, excerpt }) => (
          <a
            key={c.doc_id}
            className="ask-source-card"
            // A new tab keeps the answer and its other sources on screen.
            href={citationHref(c)}
            target="_blank"
            rel="noopener noreferrer"
            title={t("ai.ask.openAtPassage", { title: c.title || t("common.untitled") })}
          >
            <span className="ask-source-card__head">
              <span className="ask-source-card__n">{numbers.map((n) => `[${n}]`).join("")}</span>
              <FileText size={13} aria-hidden />
              <span className="ask-source-card__title">{c.title || t("common.untitled")}</span>
            </span>
            {section && <span className="ask-source-card__section">{section}</span>}
            {excerpt && <span className="ask-source-card__excerpt">{excerpt}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
