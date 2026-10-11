/**
 * The database's open agent runs, one banner each. Ops on a table other than
 * the one on screen paint no ghost, so only those rows of the per-op list name
 * their table.
 */
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import type { DatabaseRunOp, DatabaseRunSummary, TableSchema } from "@stuga/protocol/databases/types";
import { pendingOps, useDbRuns } from "./db-runs-context";
import { anchorOf, keepFocus, useRejectNote, type NoteAnchor } from "./RejectNoteDialog";
import { RunBanner, RunNotices } from "./RunBanner";
import { itemKey } from "./run-ledger";
import { noteLabels } from "./note-mode";
import { t } from "../i18n/i18n";
import { describeProposal } from "../database/op-lines";
import { runAgentLabel } from "../state/identity";

/** What an op would do, in the reader's language; an op proposed before ops carried detail has only its English summary. */
function opLine(op: DatabaseRunOp): string {
  return op.detail ? describeProposal(op.detail) : op.summary;
}

/** `locked`: the database is locked, so its changes can be rejected but not accepted until it is unlocked. */
export function DbRunBar({ tables, activeTableId, locked = false }: { tables: TableSchema[]; activeTableId: string | null; locked?: boolean }) {
  const { openRuns, notices, dismissNotice } = useDbRuns();
  return (
    <>
      <RunNotices notices={notices} dismissNotice={dismissNotice} />
      {openRuns.map((run) => (
        <DbRunBanner key={run.id} run={run} tables={tables} activeTableId={activeTableId} locked={locked} />
      ))}
    </>
  );
}

function DbRunBanner({
  run,
  tables,
  activeTableId,
  locked,
}: {
  run: DatabaseRunSummary;
  tables: TableSchema[];
  activeTableId: string | null;
  locked: boolean;
}) {
  const { busy, decide, inFlight } = useDbRuns();
  const { ask, dialog } = useRejectNote();
  // A database run is always an agent's: its note waits for that agent.
  const requestChanges = (opIds: string[] | undefined, anchor: NoteAnchor, quote: string, returnFocus?: HTMLElement | null) => {
    const labels = noteLabels("agent", opIds === undefined);
    ask({
      title: labels.submit,
      submitLabel: labels.submit,
      hint: labels.hint,
      anchor,
      returnFocus,
      quote,
      onSubmit: (note) => void decide(run.id, "reject", opIds, note),
    });
  };
  const pending = pendingOps(run);
  const n = pending.length;
  const tableName = (tableId: string) => tables.find((table) => table.table_id === tableId)?.display ?? t("review.runBar.newTable");
  const offTable = pending.filter((op) => op.table_id !== activeTableId).length;
  const agent = runAgentLabel(run);

  return (
    <>
      <RunBanner
        updatedAt={run.updated_at}
        title={t("review.runBar.dbTitle", { agent, count: n })}
        acceptBlocked={locked}
        hint={
          locked
            ? t("review.runBar.lockedHint")
            : offTable > 0
              ? t("review.runBar.dbHintOffTable", { count: offTable })
              : t("review.runBar.dbHint")
        }
        busy={busy}
        onDecide={(decision) => void decide(run.id, decision)}
        noteAction={{
          label: noteLabels("agent", true).trigger,
          onOpen: (anchor, returnFocus) =>
            requestChanges(undefined, anchor, t("review.runBar.dbQuoteAll", { count: n, agent }), returnFocus),
        }}
        list={
          n > 0 ? (
            <ul className="db-run-list" aria-label={t("review.changeList.label", { agent })}>
              {pending.map((op) => {
                const flying = inFlight.has(itemKey(run.id, op.id));
                return (
                  <li key={op.id} className={`db-run-list__row${flying ? " db-run-list__row--busy" : ""}`}>
                    <span className="db-run-list__summary">
                      <Text type="supporting">{opLine(op)}</Text>
                      {op.table_id !== activeTableId && (
                        <Text type="supporting" color="secondary">
                          {" "}
                          · {tableName(op.table_id)}
                        </Text>
                      )}
                    </span>
                    <HStack gap={1}>
                      <Button
                        label={t("review.runBar.acceptOne")}
                        variant="secondary"
                        size="sm"
                        isDisabled={flying || locked}
                        onClick={() => void decide(run.id, "accept", [op.id])}
                      >
                        {t("common.accept")}
                      </Button>
                      <Button
                        label={t("review.runBar.rejectOne")}
                        variant="ghost"
                        size="sm"
                        isDisabled={flying}
                        onClick={() => void decide(run.id, "reject", [op.id])}
                      >
                        {t("common.reject")}
                      </Button>
                      <Button
                        label={t("review.runBar.rejectOneWithNote")}
                        variant="ghost"
                        size="sm"
                        isDisabled={flying}
                        onMouseDown={keepFocus}
                        onClick={(e) => requestChanges([op.id], anchorOf(e), opLine(op))}
                      >
                        {noteLabels("agent").trigger}
                      </Button>
                    </HStack>
                  </li>
                );
              })}
            </ul>
          ) : undefined
        }
      />
      {dialog}
    </>
  );
}
