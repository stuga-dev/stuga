/**
 * Two markdown texts diffed block by block and rendered as rich text: blocks only
 * in the base are struck, blocks only in the target are green.
 */
import { useMemo, useState, type ReactNode } from "react";
import MarkdownIt from "markdown-it";
import { blockDiffMarkdown, type BlockDiffMarkdown } from "@stuga/crdt-ops";
import { Switch } from "@astryxdesign/core/Switch";
import { renderImageCaptions } from "../editor/image-caption-markdown";
import { renderTextDirection } from "../editor/text-direction-markdown";

// html:false escapes raw HTML in document text, so the output is safe to inject.
const md = new MarkdownIt({ html: false, linkify: true });
renderImageCaptions(md);
renderTextDirection(md);

export function useBlockDiff(base: string | null, target: string | null): { blocks: BlockDiffMarkdown[]; changed: boolean } {
  return useMemo(() => {
    const blocks = base === null || target === null ? [] : blockDiffMarkdown(base, target);
    return { blocks, changed: blocks.some((b) => b.type !== "eq") };
  }, [base, target]);
}

export function BlockDiffView({
  blocks,
  changed,
  loading,
  failed = false,
  unchangedText,
  removedNote,
  addedNote,
}: {
  blocks: BlockDiffMarkdown[];
  changed: boolean;
  loading: boolean;
  failed?: boolean;
  unchangedText: string;
  removedNote?: ReactNode;
  addedNote?: ReactNode;
}) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const shown = onlyDiff ? blocks.filter((b) => b.type !== "eq") : blocks;
  return (
    <>
      <div className="vcompare-controls">
        <p className="vcompare-legend">
          <span className="vcompare-legend-swatch vcompare-legend-swatch--del" />
          Removed {removedNote && <span className="vcompare-legend-note">{removedNote}</span>}
          <span className="vcompare-legend-swatch vcompare-legend-swatch--ins" />
          Added {addedNote && <span className="vcompare-legend-note">{addedNote}</span>}
        </p>
        <Switch label="Only show changes" value={onlyDiff} onChange={setOnlyDiff} />
      </div>
      <div className="vcompare-diff">
        {loading ? (
          <p className="empty">Loading…</p>
        ) : failed ? (
          <p className="empty">Couldn’t load these changes.</p>
        ) : !changed ? (
          <p className="empty">{unchangedText}</p>
        ) : (
          shown.map((b, i) => (
            <div
              key={i}
              className={`vcompare-block vcompare-block--${b.type} ai-md`}
              dangerouslySetInnerHTML={{ __html: md.render(b.markdown) }}
            />
          ))
        )}
      </div>
    </>
  );
}
