/**
 * What an applied agent run changed: the document as the run opened against the
 * run's committed text (or the live document before the run is finalized). The
 * revert itself stays with the caller, so there is one revert path and one
 * confirmation.
 */
import { useEffect, useState } from "react";
import { Runs } from "../api";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { BlockDiffView, useBlockDiff } from "./BlockDiffView";

export function RunChangesDialog({
  docId,
  runId,
  agent,
  currentText,
  onClose,
  onRevert,
  canRevert,
  isReverting,
}: {
  docId: string;
  runId: string;
  agent: string;
  /** Markdown of the live document, the "after" side until the run stores its own. */
  currentText: string;
  onClose: () => void;
  onRevert: () => void;
  /** False once the run was reverted or left the catch-up list. */
  canRevert: boolean;
  isReverting: boolean;
}) {
  const [baseText, setBaseText] = useState<string | null>(null);
  const [targetText, setTargetText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailed(false);
    Runs.detail(docId, runId, { full: true })
      .then((d) => {
        if (!live) return;
        setBaseText(d.baseline_markdown ?? "");
        setTargetText(d.final_markdown ?? currentText);
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [docId, runId, currentText]);

  const { blocks, changed } = useBlockDiff(baseText, targetText);

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="info" width={720}>
      <Layout
        header={<DialogHeader title={`Changes by ${agent}`} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <div className="vcompare">
              <BlockDiffView
                blocks={blocks}
                changed={changed}
                loading={loading}
                failed={failed}
                unchangedText="No differences — the document is unchanged."
              />
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Close" variant="ghost" onClick={onClose} />
              {/* With nothing differing, the server would answer a revert with 409. */}
              {canRevert && changed && !loading && !failed && (
                <Button label="Revert these changes" variant="secondary" isDisabled={isReverting} onClick={onRevert} />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
