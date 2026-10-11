/** The dock's Versions panel: history over REST, with compare, restore and delete in VersionCompareDialog. */
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";
import { Docs, type VersionListing } from "../../api";
import { useUserNames } from "../../state/identity";
import { versionLabel } from "../../lib/format";
import { INDEX_ALLOWANCE_MS } from "../use-refresh-after-indexing";
import { noteOwnRestore, rememberRestore, restoreSettled, restoreSettling } from "../restore-notice";
import { useLandedRunsKey } from "../../review/agent-runs-context";
import { VersionCompareDialog, currentMarkdown } from "./VersionCompareDialog";
import { VersionHistory } from "./VersionHistory";
import { useToast } from "../../ui/use-toast";
import { t } from "../../i18n/i18n";
import { forceReload } from "../../sync/forced-reload";

/** A version owed by the interval is recorded minutes after the last edit, with no update to announce it. */
const POLL_INTERVAL_MS = 60_000;
/** The node writes a version as it picks up the snapshot's job, ahead of indexing it. */
const VERSION_JOB_ALLOWANCE_MS = 2_000;

/** Just after a restore, how often the list asks again for the restore's own row. */
const SETTLE_POLL_MS = 2_000;

const EMPTY: VersionListing = { versions: [], head_seq: 0, can_manage: false };

/**
 * The listing, re-read while mounted: once edits have settled long enough to be
 * snapshotted and indexed, every minute while the page is visible, and when it
 * becomes visible again. Only the newest request's answer is kept.
 */
function useVersionListing(docId: string, ydoc: Y.Doc | null): [VersionListing, () => void, boolean] {
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

  // A restore reloaded the page before the node recorded it: until its row is listed, nothing here is Current.
  const [settling, setSettling] = useState(() => restoreSettling(docId));
  useEffect(() => {
    if (settling === null) return;
    const tick = setInterval(() => {
      if (restoreSettling(docId) === null) setSettling(null);
      else refresh();
    }, SETTLE_POLL_MS);
    return () => clearInterval(tick);
  }, [docId, settling, refresh]);
  useEffect(() => {
    if (settling === null || !listing.versions[0]?.authors.includes(`restore:v${settling}`)) return;
    restoreSettled(docId);
    setSettling(null);
  }, [docId, settling, listing]);

  // An AI change that landed, or one accepted or reverted, is snapshotted at once when a version is due.
  const [mountedAt] = useState(() => Date.now());
  const landed = useLandedRunsKey(mountedAt);
  const seenLanded = useRef(landed);
  useEffect(() => {
    if (landed === seenLanded.current) return;
    seenLanded.current = landed;
    refresh();
    const soon = setTimeout(refresh, VERSION_JOB_ALLOWANCE_MS);
    const indexed = setTimeout(refresh, INDEX_ALLOWANCE_MS);
    return () => {
      clearTimeout(soon);
      clearTimeout(indexed);
    };
  }, [landed, refresh]);

  return [listing, refresh, settling !== null];
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
  const [{ versions, head_seq: headSeq, can_manage: canManage }, refreshVersions, settling] = useVersionListing(docId, ydoc);
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
  const currentSeq = newest !== undefined && newestIsCurrent && !settling ? newest.seq : null;

  // A refresh can drop the version being viewed: retention pruned it, or someone deleted it.
  useEffect(() => {
    if (compareSeq === null || versions.some((v) => v.seq === compareSeq)) return;
    setCompareSeq(null);
    toast({ body: t("document.versions.gone"), type: "info" });
  }, [versions, compareSeq, toast]);

  async function restoreVersion(seq: number) {
    setBusy(true);
    const restored = versions.find((v) => v.seq === seq);
    noteOwnRestore(docId, seq);
    try {
      await Docs.restoreVersion(docId, seq);
      // The actor's DOC_RESET reloads the page; this covers a missing socket, and the reload still says what happened.
      if (restored) rememberRestore(docId, { by: "", at: restored.ts, seq });
      setTimeout(forceReload, 800);
    } catch (err) {
      setBusy(false);
      const status = (err as { status?: number }).status;
      const body =
        status === 403
          ? t("document.versions.restoreForbidden")
          : status === 404
            ? t("document.versions.restoreGone")
            : t("document.versions.restoreFailed");
      toast({ body, type: "error" });
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
      toast({
        body: label ? t("document.versions.deleted", { version: versionLabel(label) }) : t("document.versions.deletedUnnamed"),
        type: "info",
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const body =
        status === 403
          ? t("document.versions.deleteForbidden")
          : status === 409
            ? t("document.versions.deleteCurrent")
            : status === 404
              ? t("document.versions.deleteGone")
              : t("document.versions.deleteFailed");
      toast({ body, type: "error" });
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
