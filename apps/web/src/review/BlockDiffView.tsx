/**
 * Two markdown texts diffed block by block and rendered as rich text: blocks only
 * in the base are struck, blocks only in the target are green.
 */
import { useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { blockDiffMarkdown, type BlockDiffMarkdown } from "@stuga/crdt-ops";
import { Switch } from "@astryxdesign/core/Switch";
import { renderImageCaptions } from "../editor/image-caption-markdown";
import { renderTextDirection } from "../editor/text-direction-markdown";
import { renderTaskBoxes } from "../editor/task-list-markdown";
import { t } from "../i18n/i18n";

// html:false escapes raw HTML in document text, so the output is safe to inject.
const md = new MarkdownIt({ html: false, linkify: true });
renderImageCaptions(md);
renderTextDirection(md);
renderTaskBoxes(md);

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
  removedLabel,
  addedLabel,
}: {
  blocks: BlockDiffMarkdown[];
  changed: boolean;
  loading: boolean;
  failed?: boolean;
  unchangedText: string;
  /** What the red and the green mean, in place of "Removed" and "Added". */
  removedLabel?: string;
  addedLabel?: string;
}) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const shown = onlyDiff ? blocks.filter((b) => b.type !== "eq") : blocks;
  return (
    <>
      <div className="vcompare-controls">
        <p className="vcompare-legend">
          <span className="vcompare-legend-swatch vcompare-legend-swatch--del" />
          {removedLabel ?? t("review.diff.removed")}
          <span className="vcompare-legend-swatch vcompare-legend-swatch--ins" />
          {addedLabel ?? t("review.diff.added")}
        </p>
        <Switch label={t("review.diff.onlyChanges")} value={onlyDiff} onChange={setOnlyDiff} />
      </div>
      <div className="vcompare-diff">
        {loading ? (
          <p className="empty">{t("common.loading")}</p>
        ) : failed ? (
          <p className="empty">{t("review.diff.loadFailed")}</p>
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
