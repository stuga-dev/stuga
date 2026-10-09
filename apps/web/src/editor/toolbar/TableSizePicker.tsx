/** Insert a table by hovering its size on a grid. */
import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Popover } from "@astryxdesign/core/Popover";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Table as TableIcon } from "lucide-react";
import { t } from "../../i18n/i18n";

const MAX_ROWS = 8;
const MAX_COLS = 10;

export function TableSizePicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ rows: number; cols: number }>({ rows: 0, cols: 0 });

  function close() {
    setOpen(false);
    setHover({ rows: 0, cols: 0 });
  }

  function insert(rows: number, cols: number) {
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    close();
  }

  const label = hover.rows > 0 ? t("editor.tableSize.dimensions", { rows: hover.rows, cols: hover.cols }) : t("editor.tableSize.insert");

  return (
    <Popover
      isOpen={open}
      onOpenChange={(o) => (o ? setOpen(true) : close())}
      label={t("editor.tableSize.label")}
      content={
        <div className="tb-grid-pop" role="dialog" aria-label={t("editor.tableSize.label")}>
          <div className="tb-grid-label">{label}</div>
          <div
            className="tb-grid"
            style={{ gridTemplateColumns: `repeat(${MAX_COLS}, 16px)` }}
            onMouseLeave={() => setHover({ rows: 0, cols: 0 })}
          >
            {Array.from({ length: MAX_ROWS * MAX_COLS }).map((_, i) => {
              const r = Math.floor(i / MAX_COLS) + 1;
              const c = (i % MAX_COLS) + 1;
              const on = r <= hover.rows && c <= hover.cols;
              return (
                <div
                  key={i}
                  className={`tb-grid-cell${on ? " on" : ""}`}
                  onMouseEnter={() => setHover({ rows: r, cols: c })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(r, c)}
                />
              );
            })}
          </div>
        </div>
      }
    >
      {({ ref, onClick }) => (
        <IconButton
          ref={ref as React.Ref<HTMLButtonElement>}
          label={t("editor.tableSize.insert")}
          tooltip={t("editor.tableSize.insert")}
          variant="ghost"
          size="sm"
          icon={<TableIcon size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
        />
      )}
    </Popover>
  );
}
