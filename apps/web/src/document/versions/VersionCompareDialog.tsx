/**
 * One version diffed against the current document or another version, with
 * Restore and Delete. Delete lives here, not in the list, so a version is only
 * thrown away after it has been seen.
 */
import { useEffect, useState } from "react";
import { Docs, type Version } from "../../api";
import { authorLabel } from "../../state/identity";
import { relativeTime, absoluteTime, versionLabel } from "../../lib/format";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { BlockDiffView, useBlockDiff } from "../../review/BlockDiffView";

function authorsLabel(v: Version): string {
  return v.authors.map(authorLabel).join(", ") || "—";
}

export function VersionCompareDialog({
  docId,
  versions,
  seq,
  currentText,
  busy,
  isHead,
  onClose,
  onRestore,
  onDelete,
}: {
  docId: string;
  versions: Version[];
  /** The version being viewed, the "after" side. */
  seq: number;
  /** Markdown of the live document, the default baseline. */
  currentText: string;
  busy: boolean;
  /** The newest version cannot be deleted: the document loads from it. */
  isHead: boolean;
  onClose: () => void;
  onRestore: (seq: number) => void;
  onDelete: (seq: number) => void;
}) {
  // "current" or another version's seq.
  const [baseline, setBaseline] = useState<string>("current");
  const [targetText, setTargetText] = useState<string | null>(null);
  const [baseText, setBaseText] = useState<string>(currentText);
  const [loading, setLoading] = useState(true);
  // Confirmed in place in the footer, so the diff stays visible while deciding.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const viewed = versions.find((v) => v.seq === seq);
  const viewedLabel = viewed ? versionLabel(viewed.ts) : "this version";
  const baselineTs = baseline === "current" ? null : versions.find((v) => v.seq === Number(baseline))?.ts;
  const baselineLabel = baseline === "current" ? "the current document" : baselineTs ? versionLabel(baselineTs) : "the other version";

  useEffect(() => {
    let live = true;
    setLoading(true);
    Docs.versionContent(docId, seq)
      .then((r) => live && setTargetText(r.text))
      .catch(() => live && setTargetText("(could not load this version)"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [docId, seq]);

  useEffect(() => {
    if (baseline === "current") {
      setBaseText(currentText);
      return;
    }
    let live = true;
    const baseSeq = Number(baseline);
    Docs.versionContent(docId, baseSeq)
      .then((r) => live && setBaseText(r.text))
      .catch(() => live && setBaseText("(could not load this version)"));
    return () => {
      live = false;
    };
  }, [docId, baseline, currentText]);

  const { blocks, changed } = useBlockDiff(baseText, targetText);

  const baselineOptions = [
    { value: "current", label: "Current document" },
    ...versions
      .filter((v) => v.seq !== seq)
      .map((v) => ({ value: String(v.seq), label: `${versionLabel(v.ts)} · ${relativeTime(v.ts)}` })),
  ];

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="info" width={720}>
      <Layout
        header={<DialogHeader title={viewedLabel} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <div className="vcompare">
              <div className="vcompare-head">
                {viewed && (
                  <p className="vcompare-meta">
                    Saved <span title={absoluteTime(viewed.ts)}>{relativeTime(viewed.ts)}</span> by {authorsLabel(viewed)}
                  </p>
                )}
                <div className="vcompare-baseline">
                  <span className="vcompare-baseline-label">Compare with</span>
                  <div style={{ minWidth: 220 }}>
                    <Selector
                      label="Compare with"
                      isLabelHidden
                      size="sm"
                      value={baseline}
                      onChange={setBaseline}
                      options={baselineOptions}
                    />
                  </div>
                </div>
              </div>

              <BlockDiffView
                blocks={blocks}
                changed={changed}
                loading={loading}
                unchangedText={`No differences — this version is identical to ${baselineLabel}.`}
                removedNote={`(in ${baselineLabel}, not here)`}
                addedNote={`(here, not in ${baselineLabel})`}
              />
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="between" vAlign="center">
              {confirmDelete ? (
                <HStack gap={2} vAlign="center">
                  <span className="vcompare-confirm">
                    Delete this version ({viewedLabel}) permanently? The document itself is unchanged.
                  </span>
                  <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} />
                  <Button
                    label="Delete"
                    variant="destructive"
                    size="sm"
                    isLoading={busy}
                    isDisabled={busy}
                    onClick={() => onDelete(seq)}
                  />
                </HStack>
              ) : (
                <Button
                  label="Delete"
                  variant="ghost"
                  size="sm"
                  isDisabled={busy || isHead}
                  onClick={() => setConfirmDelete(true)}
                  tooltip={
                    isHead
                      ? "The newest version can't be deleted — it's what the document loads from"
                      : "Remove this version from the history"
                  }
                />
              )}
              <HStack gap={2}>
                <Button label="Close" variant="ghost" onClick={onClose} />
                <Button
                  label="Restore this version"
                  variant="primary"
                  isDisabled={busy || loading}
                  isLoading={busy}
                  onClick={() => onRestore(seq)}
                  tooltip="Roll the document back to this version"
                />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
