/** The dock's Versions panel: history over REST, with compare, restore and delete in VersionCompareDialog. */
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";
import { Docs, type VersionListing } from "../../api";
import { useUserNames } from "../../state/identity";
import { versionLabel } from "../../lib/format";
import { INDEX_ALLOWANCE_MS } from "../use-refresh-after-indexing";
import { VersionCompareDialog, currentMarkdown } from "./VersionCompareDialog";
import { VersionHistory } from "./VersionHistory";
import { useToast } from "@astryxdesign/core/Toast";

/** A version owed by the interval is recorded minutes after the last edit, with no update to announce it. */
const POLL_INTERVAL_MS = 60_000;

const EMPTY: VersionListing = { versions: [], head_seq: 0, can_manage: false };

/**
 * The listing, re-read while mounted: once edits have settled long enough to be
 * snapshotted and indexed, every minute while the page is visible, and when it
 * becomes visible again. Only the newest request's answer is kept.
 */
function useVersionListing(docId: string, ydoc: Y.Doc | null): [VersionListing, () => void] {
  const [listing, setListing] = useState<VersionListing>(EMPTY);
  const latest = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latest.current;
    Docs.versions(docId).then(
      (r) => request === latest.current && setListing(r),
      // A failed re-read keeps what is shown.
      () => {},
    );
  }, [docId]);

  useEffect(() => {
    refresh();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(settle);
      settle = setTimeout(refresh, DOC_FLUSH_INTERVAL_MS + INDEX_ALLOWANCE_MS);
    };
    // Background tabs throttle timers, so a returning page re-reads at once.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const poll = setInterval(onVisible, POLL_INTERVAL_MS);
    ydoc?.on("update", onUpdate);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      // Drops an answer still in flight.
      latest.current++;
      clearTimeout(settle);
      clearInterval(poll);
      ydoc?.off("update", onUpdate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, ydoc]);

  return [listing, refresh];
}

/** A version's Markdown, read once per seq (a seq names one snapshot for good); null until read or when the read fails. */
function useVersionText(docId: string, seq: number | null): string | null {
  const [read, setRead] = useState<{ docId: string; seq: number; text: string } | null>(null);
  useEffect(() => {
    if (seq === null) return;
    let live = true;
    Docs.versionContent(docId, seq).then(
      (r) => live && setRead({ docId, seq, text: r.text }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [docId, seq]);
  return read && read.docId === docId && read.seq === seq ? read.text : null;
}

export function VersionsPanel({ docId, ydoc }: { docId: string; ydoc: Y.Doc | null }) {
  const toast = useToast();
  const [{ versions, head_seq: headSeq, can_manage: canManage }, refreshVersions] = useVersionListing(docId, ydoc);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useUserNames(versions.flatMap((v) => v.authors.filter((a) => !a.startsWith("restore:")).map((a) => `user:${a}`)));

  // At or past the head (a version is recorded before its snapshot is processed), the newest
  // version is current. Past it, the head may still hold the same text: an edit undone, or one
  // Markdown does not carry (underline, image or column widths). No version is owed then.
  const newest = versions[0];
  const ahead = newest !== undefined && headSeq > newest.seq;
  const newestText = useVersionText(docId, ahead ? newest.seq : null);
  const newestIsCurrent = !ahead || (newestText !== null && ydoc !== null && newestText === currentMarkdown(ydoc));
  const currentSeq = newest !== undefined && newestIsCurrent ? newest.seq : null;

  // A refresh can drop the version being viewed: retention pruned it, or someone deleted it.
  useEffect(() => {
    if (compareSeq === null || versions.some((v) => v.seq === compareSeq)) return;
    setCompareSeq(null);
    toast({ body: "That version is no longer in the history.", type: "info" });
  }, [versions, compareSeq, toast]);

  async function restoreVersion(seq: number) {
    setBusy(true);
    try {
      await Docs.restoreVersion(docId, seq);
      // The actor's DOC_RESET reloads the page; this covers a missing socket.
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      setBusy(false);
      const status = (err as { status?: number }).status;
      const reason =
        status === 403
          ? "Only the owner or a workspace admin can restore a version."
          : status === 404
            ? "That version is no longer available."
            : "Please try again.";
      toast({ body: `Restore failed. ${reason}`, type: "error" });
      // Gone: closed here, so the refresh that drops the row adds no second toast.
      if (status === 404) {
        setCompareSeq(null);
        refreshVersions();
      }
    }
  }

  async function deleteVersion(seq: number) {
    setBusy(true);
    // Read before the refresh drops the row.
    const label = versions.find((v) => v.seq === seq)?.ts;
    try {
      await Docs.deleteVersion(docId, seq);
      setCompareSeq(null);
      toast({ body: `${label ? versionLabel(label) : "That version"} deleted from history.`, type: "info" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const reason =
        status === 403
          ? "Only the owner or a workspace admin can delete a version."
          : status === 409
            ? "You can't delete the current version."
            : status === 404
              ? "That version is no longer available."
              : "Please try again.";
      toast({ body: `Delete failed. ${reason}`, type: "error" });
      // Gone: closed here, so the refresh below adds no second toast.
      if (status === 404) setCompareSeq(null);
    } finally {
      setBusy(false);
      // Either way: after a 404 the row is already gone.
      refreshVersions();
    }
  }

  return (
    <>
      <div className="side-body">
        <VersionHistory versions={versions} currentSeq={currentSeq} onOpen={setCompareSeq} />
      </div>

      {compareSeq !== null && (
        <VersionCompareDialog
          docId={docId}
          versions={versions}
          seq={compareSeq}
          ydoc={ydoc}
          busy={busy}
          // The server refuses any seq at or past the processed head. Current stays too: the
          // actor owes no version for text that has one, so deleting it would leave none.
          isHead={compareSeq >= headSeq || compareSeq === currentSeq}
          canManage={canManage}
          onClose={() => setCompareSeq(null)}
          onRestore={restoreVersion}
          onDelete={deleteVersion}
        />
      )}
    </>
  );
}
