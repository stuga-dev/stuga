/** Runs that applied at once on a database set to `auto`, offered on the next visit. */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useToast } from "@astryxdesign/core/Toast";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { useDbRuns } from "./db-runs-context";
import { CatchUpBanner } from "./RunBanner";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";
import { runAgentLabel } from "../state/identity";

export function DbCatchUpCard({ onViewActivity }: { onViewActivity: () => void }) {
  const { unseenApplied, busy, revert, ack } = useDbRuns();
  const toast = useToast();
  const [reverting, setReverting] = useState<DatabaseRunSummary | null>(null);

  // The dialog outlives the last card: reverting it empties `unseenApplied` while the click is in flight.
  if (unseenApplied.length === 0 && reverting === null) return null;

  async function onRevert() {
    if (!reverting) return;
    try {
      await revert(reverting.id);
      setReverting(null);
      toast({ body: t("review.catchUp.reverted"), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("review.notice.undoChangesFailed")), type: "error" });
    }
  }

  return (
    <>
      {unseenApplied.map((run) => {
        const n = run.ops.filter((o) => o.status === "auto_applied" || o.status === "accepted").length;
        return (
          <CatchUpBanner
            key={run.id}
            title={
              n > 0
                ? t("review.catchUp.dbTitle", { agent: runAgentLabel(run), count: n })
                : t("review.catchUp.dbTitleNoCount", { agent: runAgentLabel(run) })
            }
            description={t("review.catchUp.dbDescription")}
            view={<Button label={t("review.catchUp.viewActivity")} variant="secondary" size="sm" onClick={onViewActivity} />}
            revert={
              !run.reverted && (
                <Button label={t("review.catchUp.revertAll")} variant="ghost" size="sm" isDisabled={busy} onClick={() => setReverting(run)} />
              )
            }
            onDismiss={() => void ack(run.id)}
          />
        );
      })}
      <AlertDialog
        isOpen={reverting !== null}
        onOpenChange={(o) => !o && !busy && setReverting(null)}
        title={
          reverting
            ? t("review.catchUp.dbRevertTitle", { agent: runAgentLabel(reverting) })
            : t("review.catchUp.dbRevertTitleAnyAgent")
        }
        // The actor restores what it can, last writer wins: it does not keep later edits.
        description={t("review.catchUp.dbRevertDescription")}
        actionLabel={t("review.catchUp.revertAll")}
        isActionLoading={busy}
        onAction={onRevert}
      />
    </>
  );
}
