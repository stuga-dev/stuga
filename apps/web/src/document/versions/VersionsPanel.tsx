/** The dock's Versions panel: history over REST, with compare, restore and delete in VersionCompareDialog. */
import { useCallback, useEffect, useState } from "react";
import type * as Y from "yjs";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { Docs, type Version } from "../../api";
import { useUserNames } from "../../state/identity";
import { versionLabel } from "../../lib/format";
import { VersionCompareDialog } from "./VersionCompareDialog";
import { VersionHistory } from "./VersionHistory";
import { useToast } from "@astryxdesign/core/Toast";

export function VersionsPanel({ docId, ydoc }: { docId: string; ydoc: Y.Doc | null }) {
  const toast = useToast();
  const [versions, setVersions] = useState<Version[]>([]);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshVersions = useCallback(() => {
    Docs.versions(docId).then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  }, [docId]);

  useEffect(() => refreshVersions(), [refreshVersions]);

  useUserNames(versions.flatMap((v) => v.authors.filter((a) => !a.startsWith("restore:")).map((a) => `user:${a}`)));

  // The server serializes versions with the same crdt-ops function, so unchanged content diffs as equal.
  function currentDocText(): string {
    if (!ydoc) return "";
    return yXmlFragmentToMarkdown(ydoc.getXmlFragment("default"));
  }

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
          ? "Only the document owner can restore a version."
          : status === 404
            ? "That version is no longer available."
            : "Please try again.";
      toast({ body: `Restore failed. ${reason}`, type: "error" });
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
          ? "Only the document owner can delete a version."
          : status === 409
            ? "You can't delete the current version."
            : status === 404
              ? "That version is no longer available."
              : "Please try again.";
      toast({ body: `Delete failed. ${reason}`, type: "error" });
    } finally {
      setBusy(false);
      // Either way: after a 404 the row is already gone.
      refreshVersions();
    }
  }

  return (
    <>
      <div className="side-body">
        <VersionHistory versions={versions} onOpen={setCompareSeq} />
      </div>

      {compareSeq !== null && (
        <VersionCompareDialog
          docId={docId}
          versions={versions}
          seq={compareSeq}
          currentText={currentDocText()}
          busy={busy}
          isHead={versions[0]?.seq === compareSeq}
          onClose={() => setCompareSeq(null)}
          onRestore={restoreVersion}
          onDelete={deleteVersion}
        />
      )}
    </>
  );
}
