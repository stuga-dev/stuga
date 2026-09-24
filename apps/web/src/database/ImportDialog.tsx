/**
 * Import a CSV or JSONL file into one table. Choosing a file stages it and asks
 * the node for a dry-run verdict; the one button then says exactly what it will
 * do ("Import 1 row, skip 2").
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Banner } from "@astryxdesign/core/Banner";
import { AlertTriangle, Check, Download, FileText } from "lucide-react";
import { Databases } from "../api";
import type { ApiError } from "../lib/http/client";
import { saveBlob } from "../lib/download";
import type { DatabaseImportCheck, DatabaseImportError, DatabaseImportResult, TableSchema } from "@stuga/protocol/databases/types";
import { csvCell } from "@stuga/protocol/domain/audit";

const ACCEPT = ".csv,.tsv,.txt,.jsonl,.ndjson,.json,text/csv,text/tab-separated-values,text/plain,application/json";

/**
 * The table's display names as a header row and no example rows, which would
 * import as data. `csvCell` neutralises names a spreadsheet would run as formulas.
 */
export function importTemplateCsv(table: TableSchema): string {
  return `${table.columns.map((c) => csvCell(c.display)).join(",")}\r\n`;
}

type DateOrder = "mdy" | "dmy";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; check: DatabaseImportCheck }
  | { kind: "importing"; check: DatabaseImportCheck }
  | { kind: "done"; result: DatabaseImportResult };

interface ImportDialogProps {
  isOpen: boolean;
  docId: string;
  table: TableSchema;
  onClose: () => void;
  /** The page reloads the schema and the grid. */
  onImported: (result: DatabaseImportResult) => void;
}

const plural = (k: number, noun: string) => `${k.toLocaleString()} ${noun}${k === 1 ? "" : "s"}`;
const fileSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

export function ImportDialog({ isOpen, docId, table, onClose, onImported }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null);
  /** The node's staging of the current file, reused by re-checks and the commit. */
  const [importId, setImportId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setFile(null);
    setPhase({ kind: "idle" });
    setError(null);
    setDateOrder(null);
    setImportId(null);
  }, [isOpen]);

  const busy = phase.kind === "checking" || phase.kind === "importing";

  /** Stage (once per file) and ask for the verdict. */
  async function check(f: File, order: DateOrder | null, staged: string | null) {
    setPhase({ kind: "checking" });
    setError(null);
    try {
      let id = staged;
      if (!id) {
        id = (await Databases.stageImport(docId, table.table_id, f)).import_id;
        setImportId(id);
      }
      const verdict = await Databases.checkImport(docId, id, order ? { date_order: order } : {});
      setPhase({ kind: "checked", check: verdict });
    } catch (e) {
      setPhase({ kind: "idle" });
      setError((e as ApiError).message || "Couldn’t read this file.");
    }
  }

  async function importNow() {
    if (phase.kind !== "checked" || !importId || !file) return;
    const { check: verdict } = phase;
    setPhase({ kind: "importing", check: verdict });
    setError(null);
    const opts = {
      on_error: verdict.rows_failed > 0 ? ("skip_bad_rows" as const) : ("abort" as const),
      ...(dateOrder ? { date_order: dateOrder } : {}),
    };
    try {
      let result: DatabaseImportResult;
      try {
        result = await Databases.commitImport(docId, importId, opts);
      } catch (e) {
        // The staging expired while the verdict was being read: import in one round trip instead.
        const status = (e as ApiError).status;
        if (status !== 404 && status !== 410) throw e;
        result = await Databases.importFile(docId, table.table_id, file, opts);
      }
      setPhase({ kind: "done", result });
      onImported(result);
    } catch (e) {
      setPhase({ kind: "checked", check: verdict });
      setError((e as ApiError).message || "Couldn’t import this file.");
    }
  }

  function chooseFile(f: File | null) {
    setFile(f);
    setDateOrder(null);
    setImportId(null);
    setError(null);
    if (f) void check(f, null, null);
    else setPhase({ kind: "idle" });
  }

  function flipDateOrder(order: DateOrder) {
    if (!file) return;
    setDateOrder(order);
    void check(file, order, importId);
  }

  function downloadTemplate() {
    saveBlob(new Blob([importTemplateCsv(table)], { type: "text/csv;charset=utf-8" }), `${table.name}-template.csv`);
  }

  const close = () => !busy && onClose();
  const verdict = phase.kind === "checked" || phase.kind === "importing" ? phase.check : null;

  const action = verdict
    ? verdict.rows_ready === 0
      ? { label: "Import", disabled: true }
      : verdict.rows_failed > 0
        ? { label: `Import ${plural(verdict.rows_ready, "row")}, skip ${verdict.rows_failed.toLocaleString()}`, disabled: false }
        : { label: `Import ${plural(verdict.rows_ready, "row")}`, disabled: false }
    : { label: "Import", disabled: true };

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={600}>
      <Layout
        header={<DialogHeader title={`Import into “${table.display}”`} onOpenChange={(o) => !o && close()} />}
        content={
          <LayoutContent>
            {phase.kind === "done" ? (
              <VStack gap={3}>
                <Banner
                  status="success"
                  title={`Imported ${plural(phase.result.rows_ingested, "row")}.`}
                  description={
                    phase.result.rows_skipped > 0
                      ? `${plural(phase.result.rows_skipped, "row")} with problems ${phase.result.rows_skipped === 1 ? "was" : "were"} left out.`
                      : undefined
                  }
                />
                {phase.result.errors.length > 0 && (
                  <div className="db-import__card">
                    <ErrorTable errors={phase.result.errors} truncated={phase.result.errors_truncated} />
                  </div>
                )}
              </VStack>
            ) : (
              <VStack gap={3}>
                {file ? (
                  <div className="db-import__file">
                    <FileText size={16} className="db-import__file-icon" />
                    <span className="db-import__file-name">{file.name}</span>
                    <span className="db-import__file-size">{fileSize(file.size)}</span>
                    <Button label="Change" variant="ghost" size="sm" isDisabled={busy} onClick={() => chooseFile(null)} />
                  </div>
                ) : (
                  <>
                    <FileInput
                      label="File"
                      description="CSV or JSONL. The first line names the columns; empty cells stay empty."
                      mode="dropzone"
                      accept={ACCEPT}
                      value={null}
                      onChange={(f) => chooseFile(Array.isArray(f) ? (f[0] ?? null) : f)}
                    />
                    <HStack gap={2} vAlign="center">
                      <Button
                        label="Download template"
                        variant="ghost"
                        size="sm"
                        icon={<Download size={15} />}
                        isDisabled={table.columns.length === 0}
                        onClick={downloadTemplate}
                      />
                      <Text type="supporting" color="secondary">
                        This table’s headers as a CSV, ready to fill in.
                      </Text>
                    </HStack>
                  </>
                )}

                {error && <Banner status="error" title={error} />}

                {phase.kind === "checking" && (
                  <div className="db-import__card db-import__card-head">
                    <HStack gap={2} vAlign="center">
                      <Spinner label="Checking the file" />
                      <Text type="supporting" color="secondary">
                        Checking the file…
                      </Text>
                    </HStack>
                  </div>
                )}

                {verdict && <Verdict check={verdict} dateOrder={dateOrder} onDateOrder={flipDateOrder} busy={busy} />}
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {phase.kind === "done" ? (
                <Button label="Done" variant="primary" onClick={onClose} />
              ) : (
                <>
                  <Button label="Cancel" variant="ghost" onClick={close} isDisabled={busy} />
                  <Button
                    label={action.label}
                    variant="primary"
                    onClick={() => void importNow()}
                    isDisabled={action.disabled || busy}
                    isLoading={phase.kind === "importing"}
                  />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** One headline, the matched columns, the problems, and the date order when the file left it ambiguous. */
function Verdict({
  check,
  dateOrder,
  onDateOrder,
  busy,
}: {
  check: DatabaseImportCheck;
  dateOrder: DateOrder | null;
  onDateOrder: (order: DateOrder) => void;
  busy: boolean;
}) {
  const allGood = check.rows_failed === 0 && check.rows_ready > 0;
  const nothing = check.rows_ready === 0;
  const headline = nothing
    ? check.rows_total === 0
      ? "The file has no data rows."
      : `None of the ${plural(check.rows_total, "row")} can be imported.`
    : allGood
      ? `${plural(check.rows_ready, "row")} ready to import.`
      : `${check.rows_ready.toLocaleString()} of ${plural(check.rows_total, "row")} ready to import.`;
  const detail = nothing
    ? check.errors.some((e) => e.row === 0)
      ? "The file’s headers don’t match this table’s columns — download the template to get them right."
      : "Every row has a problem; they are listed below."
    : allGood
      ? undefined
      : `${plural(check.rows_failed, "row")} ${check.rows_failed === 1 ? "has" : "have"} a problem and will be left out unless you fix the file.`;
  const effectiveOrder = dateOrder ?? check.guessed_date_order ?? null;
  const matched = check.matched_columns.length;
  const columnsLine =
    matched === 0
      ? null
      : check.ignored_columns.length === 0
        ? `All ${plural(matched, "column")} matched.`
        : `${plural(matched, "column")} matched · ignored: ${check.ignored_columns.join(", ")}`;

  return (
    <div className={`db-import__card${nothing ? " db-import__card--bad" : allGood ? " db-import__card--good" : ""}`}>
      <div className="db-import__card-head">
        <HStack gap={2} vAlign="start">
          <span className="db-import__card-icon">{allGood ? <Check size={18} /> : <AlertTriangle size={18} />}</span>
          <VStack gap={1}>
            <Text type="body" weight="semibold">
              {headline}
            </Text>
            {detail && (
              <Text type="supporting" color="secondary">
                {detail}
              </Text>
            )}
            {columnsLine && (
              <Text type="supporting" color="secondary">
                {columnsLine}
              </Text>
            )}
          </VStack>
        </HStack>
      </div>

      {check.errors.length > 0 && (
        <div className="db-import__card-section db-import__card-section--flush">
          <ErrorTable errors={check.errors} truncated={check.errors_truncated} />
        </div>
      )}

      {effectiveOrder && (
        <div className="db-import__card-section">
        <RadioList
          label="Dates like 1/4/26 in this file are"
          size="sm"
          orientation="horizontal"
          value={effectiveOrder}
          isDisabled={busy}
          onChange={(v) => {
            if (v !== effectiveOrder) onDateOrder(v as DateOrder);
          }}
        >
          <RadioListItem value="mdy" label="Month / day / year" description="1/4/26 = January 4" />
          <RadioListItem value="dmy" label="Day / month / year" description="1/4/26 = 1 April" />
        </RadioList>
        </div>
      )}
    </div>
  );
}

/** One line per refused cell. */
function ErrorTable({ errors, truncated }: { errors: DatabaseImportError[]; truncated: boolean }) {
  return (
    <div className="db-import__errors">
      <table className="db-import__table">
        <thead>
          <tr>
            <th className="db-import__num">Row</th>
            <th>Column</th>
            <th>Value</th>
            <th>Problem</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => (
            <tr key={i}>
              <td className="db-import__num">{e.row === 0 ? "header" : e.row}</td>
              <td>{e.column ?? ""}</td>
              <td className="db-import__value">{e.value ?? ""}</td>
              <td>
                <div>{e.message}</div>
                {e.hint ? <div className="db-import__hint">{e.hint}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="db-import__more">
          <Text type="supporting" color="secondary">
            Only the first {errors.length} problems are shown.
          </Text>
        </div>
      )}
    </div>
  );
}
