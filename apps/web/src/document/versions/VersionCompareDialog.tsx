/**
 * One version diffed against the current document or another version, with
 * Restore and Delete for those who manage the document. Delete lives here, not
 * in the list, so a version is only thrown away after it has been seen.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { Docs, type Version } from "../../api";
import { relativeTime, absoluteTime, versionLabel } from "../../lib/format";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { BlockDiffView, useBlockDiff } from "../../review/BlockDiffView";
import { authorsOf } from "./VersionHistory";

/** The live document is re-read at most this often while edits arrive. */
const FOLLOW_MS = 300;
/** A read slower than this stalls the tab while it runs, so edits then wait for Show latest. */
const FOLLOW_BUDGET_MS = 100;

/** The live document's Markdown. The server serializes versions with the same crdt-ops function, so unchanged content diffs as equal. */
export function currentMarkdown(ydoc: Y.Doc | null): string {
  return ydoc ? yXmlFragmentToMarkdown(ydoc.getXmlFragment("default")) : "";
}

/** The live document's Markdown and how long serializing it took. */
function timedRead(ydoc: Y.Doc | null): { text: string; ms: number } {
  const started = performance.now();
  const text = currentMarkdown(ydoc);
  return { text, ms: performance.now() - started };
}

/**
 * The live document's Markdown, following its edits, local or remote, while `follow` holds and a
 * read stays within budget. Past it, `behind` says edits have arrived since and `showLatest` reads them.
 * `target` is what the text is diffed against, so the commit that diffs and draws it is measured.
 */
function useCurrentMarkdown(ydoc: Y.Doc | null, follow: boolean, target: string | null) {
  const [latest, setLatest] = useState(() => timedRead(ydoc));
  const [behind, setBehind] = useState(false);
  // Taken after the mounting read, so the span below is diffing and drawing alone.
  const renderedAt = performance.now();
  // The document `latest` was read from and whether it has changed since; what the last read cost in all.
  const read = useRef({ doc: ydoc, stale: false, cost: 0 });

  // A read's cost: serializing, plus the diffing and drawing done by the commit that shows it.
  useLayoutEffect(() => {
    read.current.cost = latest.ms + (performance.now() - renderedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, target]);

  const readNow = useCallback(() => {
    if (!ydoc) return;
    const r = read.current;
    const next = timedRead(ydoc);
    r.doc = ydoc;
    r.stale = false;
    setBehind(false);
    // Unchanged text is not drawn again, and keeps the cost of the read that drew it.
    setLatest((prev) => (prev.text === next.text ? prev : next));
  }, [ydoc]);

  useEffect(() => {
    if (!ydoc) return;
    const r = read.current;
    let due: ReturnType<typeof setTimeout> | undefined;
    const fallBehind = () => {
      r.stale = true;
      if (follow) setBehind(true);
    };
    const onUpdate = () => {
      if (!follow || r.cost > FOLLOW_BUDGET_MS) fallBehind();
      else
        due ??= setTimeout(() => {
          due = undefined;
          // The target may have loaded since, and made reads slow.
          if (r.cost > FOLLOW_BUDGET_MS) fallBehind();
          else readNow();
        }, FOLLOW_MS);
    };
    // Edits made while another baseline was shown, or another document.
    if (follow && (r.doc !== ydoc || r.stale)) readNow();
    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
      if (due !== undefined) r.stale = true;
      clearTimeout(due);
    };
  }, [ydoc, follow, readNow]);
  return { text: latest.text, behind: follow && behind, showLatest: readNow };
}

export function VersionCompareDialog({
  docId,
  versions,
  seq,
  ydoc,
  busy,
  isHead,
  canManage,
  onClose,
  onRestore,
  onDelete,
}: {
  docId: string;
  versions: Version[];
  /** The version being viewed, the "after" side. */
  seq: number;
  /** The live document, the default baseline. */
  ydoc: Y.Doc | null;
  busy: boolean;
  /** Not deletable: the Current version, or one at or past the processed head, which the server refuses. */
  isHead: boolean;
  /** Restore and Delete are shown only to the owner or a workspace admin, on an unlocked document. */
  canManage: boolean;
  onClose: () => void;
  onRestore: (seq: number) => void;
  onDelete: (seq: number) => void;
}) {
  // "current" or another version's seq.
  const [chosen, setBaseline] = useState<string>("current");
  const [targetText, setTargetText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Confirmed in place in the footer, so the diff stays visible while deciding.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const viewed = versions.find((v) => v.seq === seq);
  const viewedLabel = viewed ? versionLabel(viewed.ts) : "this version";
  const viewedAuthors = viewed ? authorsOf(viewed, versions) : null;
  // A baseline a refresh dropped from the listing falls back to the current document.
  const baseVersion = versions.find((v) => String(v.seq) === chosen);
  const baseline = baseVersion ? chosen : "current";
  const baselineLabel = baseVersion ? versionLabel(baseVersion.ts) : "the current document";
  const current = useCurrentMarkdown(ydoc, baseline === "current", targetText);
  // The baseline version's text, once loaded.
  const [versionText, setVersionText] = useState<{ baseline: string; text: string } | null>(null);

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
    if (baseline === "current") return;
    let live = true;
    Docs.versionContent(docId, Number(baseline))
      .then((r) => live && setVersionText({ baseline, text: r.text }))
      .catch(() => live && setVersionText({ baseline, text: "(could not load this version)" }));
    return () => {
      live = false;
    };
  }, [docId, baseline]);

  // Derived in render, so a new read of the live document is diffed in the commit that measures it.
  const baseText = baseline === "current" ? current.text : versionText?.baseline === baseline ? versionText.text : null;
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
                    Saved <span title={absoluteTime(viewed.ts)}>{relativeTime(viewed.ts)}</span>
                    {viewedAuthors !== null && ` by ${viewedAuthors}`}
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
                  {current.behind && (
                    <Button
                      label="Show latest"
                      variant="ghost"
                      size="sm"
                      onClick={current.showLatest}
                      tooltip="The document has changed since this was shown"
                    />
                  )}
                </div>
              </div>

              <BlockDiffView
                blocks={blocks}
                changed={changed}
                loading={loading || baseText === null}
                unchangedText={`No differences — this version is identical to ${baselineLabel}.`}
                removedNote={`(in ${baselineLabel}, not here)`}
                addedNote={`(here, not in ${baselineLabel})`}
              />
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify={canManage ? "between" : "end"} vAlign="center">
              {!canManage ? null : confirmDelete ? (
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
                    isHead ? "The current version can't be deleted" : "Remove this version from the history"
                  }
                />
              )}
              <HStack gap={2}>
                <Button label="Close" variant="ghost" onClick={onClose} />
                {canManage && (
                  <Button
                    label="Restore this version"
                    variant="primary"
                    isDisabled={busy || loading}
                    isLoading={busy}
                    onClick={() => onRestore(seq)}
                    tooltip="Roll the document back to this version"
                  />
                )}
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
