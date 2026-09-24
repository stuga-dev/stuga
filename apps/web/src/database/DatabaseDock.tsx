/** The database page's dock: the AI co-author, the Activity feed and the open row. */
import type { TableSchema } from "@stuga/protocol/databases/types";
import { useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { History, PanelRightOpen, RefreshCw, Sparkles } from "lucide-react";
import { Dock, useDockState, type DockController } from "../ui/Dock";
import { ActivityPanel } from "./ActivityPanel";
import { RowPanel } from "./RowPanel";
import { TableAiPanel } from "./TableAiPanel";

type DatabaseDockTab = "ai" | "activity" | "row";

/** AI needs write access. The Row tab exists while a row is open, last in the strip so it moves no other tab. */
export function useDatabaseDock({ rowOpen, readOnly }: { rowOpen: boolean; readOnly: boolean }): DockController<DatabaseDockTab> {
  return useDockState<DatabaseDockTab>(
    "stuga_db_dock",
    [{ id: "ai", when: !readOnly }, { id: "activity" }, { id: "row", when: rowOpen }],
    "ai",
  );
}

export function DatabaseDock({
  dock,
  width,
  onResize,
  docId,
  table,
  rowId,
  readOnly,
  rowsKey,
  editsKey,
  onRowSaved,
  onRowClosed,
  onReverted,
  onWriteDenied,
}: {
  dock: DockController<DatabaseDockTab>;
  width: number;
  onResize: (next: number) => void;
  docId: string;
  /** The table on screen; the row panel waits for it. */
  table: TableSchema | null;
  rowId: string | null;
  readOnly: boolean;
  /** Bumped when rows change. */
  rowsKey: number;
  /** Bumped when the grid edits a cell. */
  editsKey: number;
  onRowSaved: () => void;
  onRowClosed: () => void;
  onReverted: () => void;
  onWriteDenied: () => void;
}) {
  const [activityRefresh, setActivityRefresh] = useState(0);
  return (
    <Dock
      dock={dock}
      width={width}
      onResize={onResize}
      tabs={[
        {
          id: "ai",
          label: "AI co-author",
          icon: <Sparkles size={15} />,
          render: () => <TableAiPanel docId={docId} activeTable={table?.display ?? null} />,
        },
        {
          id: "activity",
          label: "Activity",
          icon: <History size={15} />,
          actions: (
            <IconButton
              label="Refresh activity"
              tooltip="Refresh activity"
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={15} />}
              onClick={() => setActivityRefresh((k) => k + 1)}
            />
          ),
          render: () => (
            <ActivityPanel
              docId={docId}
              // The counters only grow, so the sum changes on any cause.
              refreshKey={rowsKey + editsKey + activityRefresh}
              readOnly={readOnly}
              onReverted={onReverted}
              onWriteDenied={onWriteDenied}
            />
          ),
        },
        {
          id: "row",
          label: "Row",
          icon: <PanelRightOpen size={15} />,
          // Closing the row withholds this tab, and the dock goes back to what the row replaced.
          close: { label: "Close row", onClose: onRowClosed },
          render: () =>
            table && rowId ? (
              <RowPanel
                key={`${table.table_id}:${rowId}`}
                docId={docId}
                table={table}
                rowId={rowId}
                refreshKey={rowsKey}
                readOnly={readOnly}
                onSaved={onRowSaved}
                onWriteDenied={onWriteDenied}
              />
            ) : null,
        },
      ]}
    />
  );
}
