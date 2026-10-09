/**
 * Runs that applied at once on a document set to `auto`, offered on the
 * reviewer's next visit. Dismissing acks the run on the server, and the document
 * page has no other way back to a run, so dismissing a still-revertible run confirms.
 */
import { useState } from "react";
import type * as Y from "yjs";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import type { ApiError } from "../lib/http/client";
import { useAgentRuns } from "./agent-runs-context";
import { RunChangesDialog } from "./RunChangesDialog";
import { CatchUpBanner } from "./RunBanner";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";
import { runAgentLabel } from "../state/identity";

interface RunRef {
  runId: string;
  agent: string;
}

export function AgentCatchUpCard({ docId, ydoc }: { docId: string; ydoc: Y.Doc | null }) {
  const { unseenApplied, busy, revert, ack } = useAgentRuns();
  const toast = useToast();
  const [viewing, setViewing] = useState<(RunRef & { currentText: string }) | null>(null);
  // Separate from `viewing`, so the revert confirmation can open over the diff.
  const [reverting, setReverting] = useState<RunRef | null>(null);
  const [dismissing, setDismissing] = useState<RunRef | null>(null);

  if (unseenApplied.length === 0 && !viewing) return null;

  const viewingRun = viewing ? unseenApplied.find((r) => r.id === viewing.runId) : undefined;

  function openChanges(runId: string, agent: string) {
    const currentText = ydoc ? yXmlFragmentToMarkdown(ydoc.getXmlFragment("default")) : "";
    setViewing({ runId, agent, currentText });
  }

  async function doRevert(runId: string) {
    try {
      await revert(runId);
      setReverting(null);
      // The open diff described changes that are no longer in the document.
      setViewing(null);
    } catch (e) {
      setReverting(null);
      const { status, code } = e as ApiError;
      if (status === 409) {
        toast({
          body:
            code === "nothing_to_revert"
              ? t("review.catchUp.alreadyUndone")
              : t("review.catchUp.documentChanged"),
          type: "error",
        });
        return;
      }
      toast({ body: errorMessage(e, t("review.notice.undoChangesFailed")), type: "error" });
    }
  }

  return (
    <>
      {unseenApplied.map((run) => {
        const n = run.hunks.filter((h) => h.status === "auto_applied" || h.status === "accepted").length;
        const agent = runAgentLabel(run);
        const ref = { runId: run.id, agent };
        return (
          <CatchUpBanner
            key={run.id}
            title={
              n > 0
                ? t("review.catchUp.docTitle", { agent, count: n })
                : t("review.catchUp.docTitleNoCount", { agent })
            }
            description={t("review.catchUp.docDescription")}
            view={<Button label={t("review.catchUp.viewChanges")} variant="secondary" size="sm" onClick={() => openChanges(run.id, agent)} />}
            revert={
              !run.reverted && (
                <Button label={t("review.catchUp.revert")} variant="ghost" size="sm" isDisabled={busy} onClick={() => setReverting(ref)} />
              )
            }
            onDismiss={() => (run.reverted ? void ack(run.id) : setDismissing(ref))}
          />
        );
      })}
      {viewing && (
        <RunChangesDialog
          docId={docId}
          runId={viewing.runId}
          agent={viewing.agent}
          currentText={viewing.currentText}
          onClose={() => setViewing(null)}
          canRevert={!!viewingRun && !viewingRun.reverted}
          isReverting={busy}
          onRevert={() => setReverting({ runId: viewing.runId, agent: viewing.agent })}
        />
      )}
      <AlertDialog
        isOpen={reverting !== null}
        onOpenChange={(o) => !o && !busy && setReverting(null)}
        title={t("review.catchUp.revertTitle")}
        description={
          reverting
            ? t("review.catchUp.revertDescription", { agent: reverting.agent })
            : t("review.catchUp.revertDescriptionAnyAgent")
        }
        actionLabel={t("review.catchUp.revert")}
        isActionLoading={busy}
        onAction={() => reverting && void doRevert(reverting.runId)}
      />
      <AlertDialog
        isOpen={dismissing !== null}
        onOpenChange={(o) => !o && setDismissing(null)}
        title={t("review.catchUp.dismissTitle")}
        description={
          dismissing
            ? t("review.catchUp.dismissDescription", { agent: dismissing.agent })
            : t("review.catchUp.dismissDescriptionAnyAgent")
        }
        actionLabel={t("common.dismiss")}
        actionVariant="primary"
        onAction={() => {
          if (dismissing) void ack(dismissing.runId);
          setDismissing(null);
        }}
      />
    </>
  );
}
