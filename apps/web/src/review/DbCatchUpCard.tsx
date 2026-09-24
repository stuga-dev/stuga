/** Runs that applied at once on a database set to `auto`, offered on the next visit. */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useToast } from "@astryxdesign/core/Toast";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { useDbRuns } from "./db-runs-context";
import { CatchUpBanner } from "./RunBanner";
import { errorMessage } from "../lib/http/client";

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
      toast({ body: "Changes reverted.", type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn’t undo these changes."), type: "error" });
    }
  }

  return (
    <>
      {unseenApplied.map((run) => {
        const n = run.ops.filter((o) => o.status === "auto_applied" || o.status === "accepted").length;
        return (
          <CatchUpBanner
            key={run.id}
            title={n > 0 ? `${run.agent} made ${n} change${n === 1 ? "" : "s"} to this database` : `${run.agent} changed this database`}
            description="Already applied by this database’s auto-apply setting."
            view={<Button label="View activity" variant="secondary" size="sm" onClick={onViewActivity} />}
            revert={
              !run.reverted && (
                <Button label="Revert all" variant="ghost" size="sm" isDisabled={busy} onClick={() => setReverting(run)} />
              )
            }
            onDismiss={() => void ack(run.id)}
          />
        );
      })}
      <AlertDialog
        isOpen={reverting !== null}
        onOpenChange={(o) => !o && !busy && setReverting(null)}
        title={`Revert everything ${reverting?.agent ?? "this agent"} changed?`}
        // The actor restores what it can, last writer wins: it does not keep later edits.
        description="Reverts this run where possible. Later edits to the same rows may be lost."
        actionLabel="Revert all"
        isActionLoading={busy}
        onAction={onRevert}
      />
    </>
  );
}
