/**
 * The database's open agent runs, one banner each. Ops on a table other than
 * the one on screen paint no ghost, so only those rows of the per-op list name
 * their table.
 */
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Check, X } from "lucide-react";
import type { DatabaseRunSummary, TableSchema } from "@stuga/protocol/databases/types";
import { pendingOps, useDbRuns } from "./db-runs-context";
import { RunBanner, RunNotices } from "./RunBanner";
import { itemKey } from "./run-ledger";

export function DbRunBar({ tables, activeTableId }: { tables: TableSchema[]; activeTableId: string | null }) {
  const { openRuns, notices, dismissNotice } = useDbRuns();
  return (
    <>
      <RunNotices notices={notices} dismissNotice={dismissNotice} />
      {openRuns.map((run) => (
        <DbRunBanner key={run.id} run={run} tables={tables} activeTableId={activeTableId} />
      ))}
    </>
  );
}

function DbRunBanner({
  run,
  tables,
  activeTableId,
}: {
  run: DatabaseRunSummary;
  tables: TableSchema[];
  activeTableId: string | null;
}) {
  const { busy, decide, inFlight } = useDbRuns();
  const pending = pendingOps(run);
  const n = pending.length;
  const tableName = (tableId: string) => tables.find((t) => t.table_id === tableId)?.display ?? "a new table";
  const offTable = pending.filter((op) => op.table_id !== activeTableId).length;

  return (
    <RunBanner
      updatedAt={run.updated_at}
      title={`${run.agent} proposes ${n} change${n === 1 ? "" : "s"}`}
      hint={
        offTable > 0
          ? `${offTable} in ${offTable === 1 ? "another table" : "other tables"} — see “Review each”`
          : "nothing is applied until you accept"
      }
      busy={busy}
      onDecide={(decision) => void decide(run.id, decision)}
      list={
        n > 0 ? (
          <ul className="db-run-list" aria-label={`Changes proposed by ${run.agent}`}>
            {pending.map((op) => {
              const flying = inFlight.has(itemKey(run.id, op.id));
              return (
                <li key={op.id} className={`db-run-list__row${flying ? " db-run-list__row--busy" : ""}`}>
                  <span className="db-run-list__summary">
                    <Text type="supporting">{op.summary}</Text>
                    {op.table_id !== activeTableId && (
                      <Text type="supporting" color="secondary">
                        {" "}
                        · {tableName(op.table_id)}
                      </Text>
                    )}
                  </span>
                  <HStack gap={1}>
                    <Button
                      label="Accept this change"
                      variant="primary"
                      size="sm"
                      isIconOnly
                      icon={<Check size={14} />}
                      isDisabled={flying}
                      onClick={() => void decide(run.id, "accept", [op.id])}
                    />
                    <Button
                      label="Reject this change"
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      icon={<X size={14} />}
                      isDisabled={flying}
                      onClick={() => void decide(run.id, "reject", [op.id])}
                    />
                  </HStack>
                </li>
              );
            })}
          </ul>
        ) : undefined
      }
    />
  );
}
