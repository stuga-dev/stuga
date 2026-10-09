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
import { errorMessage, type ApiError } from "../lib/http/client";
import { saveBlob } from "../lib/download";
import type { DatabaseImportCheck, DatabaseImportError, DatabaseImportErrorCode, DatabaseImportResult, TableSchema } from "@stuga/protocol/databases/types";
import { t, type MessageKey } from "../i18n/i18n";
import { byteSize, fmtInt } from "../lib/format";
import { presentServerMessage } from "../lib/http/server-messages";
import { knownCellProblem } from "./model/cell-problems";
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

/** What each refusal code says to a person; the node's own text is written for agents. */
const PROBLEM_KEYS: Record<Exclude<DatabaseImportErrorCode, "malformed_row">, MessageKey> = {
  unknown_column: "database.import.error.unknownColumn",
  duplicate_column: "database.import.error.duplicateColumn",
  invalid_text: "database.import.error.invalidText",
  invalid_number: "database.import.error.invalidNumber",
  invalid_checkbox: "database.import.error.invalidCheckbox",
  invalid_date: "database.import.error.invalidDate",
  invalid_choice: "database.import.error.invalidChoice",
  invalid_files: "database.import.error.invalidFiles",
};

/** The fixed how-to the node attaches to a refused cell of each type. */
const HINT_KEYS: Partial<Record<DatabaseImportErrorCode, MessageKey>> = {
  invalid_number: "database.import.hint.number",
  invalid_checkbox: "database.import.hint.checkbox",
  invalid_date: "database.import.hint.date",
  invalid_files: "database.import.hint.files",
};

/** One refusal in the reader's language, from its code; a code this app does not know reads as the node sent it. */
export function importProblem(e: DatabaseImportError): string {
  if (e.code === "malformed_row") {
    const fields = /^row has (\d+) fields but the header has (\d+)$/.exec(e.message);
    if (fields) return t("database.import.error.fieldCount", { fields: Number(fields[1]), header: Number(fields[2]) });
    const columns = /^too many columns: this file has more than (\d+) /.exec(e.message);
    if (columns) return t("database.import.error.tooManyColumns", { max: Number(columns[1]) });
    return t(e.row === 0 ? "database.import.error.malformedFile" : "database.import.error.malformedRow");
  }
  // A cell the validator refused carries its reason, which says more than the code (a limit, the choices).
  const cell = knownCellProblem(e.message);
  if (cell) return cell;
  const key = PROBLEM_KEYS[e.code] as MessageKey | undefined;
  return key ? t(key) : presentServerMessage(e.message);
}

/** The refusal's hint, if the node gave one, in the reader's language. */
export function importHint(e: DatabaseImportError): string | null {
  if (!e.hint) return null;
  const near = /^did you mean "(.*)"\?$/s.exec(e.hint);
  if (near) return t("database.import.hint.didYouMean", { value: near[1] });
  const choices = /^choices: (.*)$/s.exec(e.hint);
  if (choices && e.code === "invalid_choice") return t("database.import.hint.choices", { choices: choices[1] });
  const key = HINT_KEYS[e.code];
  return key ? t(key) : presentServerMessage(e.hint);
}

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
      setError(errorMessage(e, t("database.import.readFailed")));
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
      setError(errorMessage(e, t("database.import.failed")));
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
    saveBlob(new Blob([importTemplateCsv(table)], { type: "text/csv;charset=utf-8" }), t("database.import.templateFileName", { table: table.name }));
  }

  const close = () => !busy && onClose();
  const verdict = phase.kind === "checked" || phase.kind === "importing" ? phase.check : null;

  const action = verdict
    ? verdict.rows_ready === 0
      ? { label: t("common.import"), disabled: true }
      : verdict.rows_failed > 0
        ? { label: t("database.import.actionRowsSkip", { count: verdict.rows_ready, skipped: verdict.rows_failed }), disabled: false }
        : { label: t("database.import.actionRows", { count: verdict.rows_ready }), disabled: false }
    : { label: t("common.import"), disabled: true };

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={600}>
      <Layout
        header={<DialogHeader title={t("database.import.title", { name: table.display })} onOpenChange={(o) => !o && close()} />}
        content={
          <LayoutContent>
            {phase.kind === "done" ? (
              <VStack gap={3}>
                <Banner
                  status="success"
                  title={t("database.import.done", { count: phase.result.rows_ingested })}
                  description={
                    phase.result.rows_skipped > 0 ? t("database.import.skipped", { count: phase.result.rows_skipped }) : undefined
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
                    <span className="db-import__file-size">{byteSize(file.size)}</span>
                    <Button label={t("database.import.change")} variant="ghost" size="sm" isDisabled={busy} onClick={() => chooseFile(null)} />
                  </div>
                ) : (
                  <>
                    <FileInput
                      label={t("database.import.file")}
                      description={t("database.import.fileHelp")}
                      mode="dropzone"
                      accept={ACCEPT}
                      value={null}
                      onChange={(f) => chooseFile(Array.isArray(f) ? (f[0] ?? null) : f)}
                    />
                    <HStack gap={2} vAlign="center">
                      <Button
                        label={t("database.import.template")}
                        variant="ghost"
                        size="sm"
                        icon={<Download size={15} />}
                        isDisabled={table.columns.length === 0}
                        onClick={downloadTemplate}
                      />
                      <Text type="supporting" color="secondary">
                        {t("database.import.templateHelp")}
                      </Text>
                    </HStack>
                  </>
                )}

                {error && <Banner status="error" title={error} />}

                {phase.kind === "checking" && (
                  <div className="db-import__card db-import__card-head">
                    <HStack gap={2} vAlign="center">
                      <Spinner label={t("database.import.checking")} />
                      <Text type="supporting" color="secondary">
                        {t("database.import.checkingEllipsis")}
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
                <Button label={t("common.done")} variant="primary" onClick={onClose} />
              ) : (
                <>
                  <Button label={t("common.cancel")} variant="ghost" onClick={close} isDisabled={busy} />
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
      ? t("database.import.noDataRows")
      : t("database.import.noneImportable", { count: check.rows_total })
    : allGood
      ? t("database.import.allReady", { count: check.rows_ready })
      : t("database.import.someReady", { ready: check.rows_ready, total: check.rows_total });
  const detail = nothing
    ? check.errors.some((e) => e.row === 0)
      ? t("database.import.headersMismatch")
      : t("database.import.everyRowBad")
    : allGood
      ? undefined
      : t("database.import.someBad", { count: check.rows_failed });
  const effectiveOrder = dateOrder ?? check.guessed_date_order ?? null;
  const matched = check.matched_columns.length;
  const columnsLine =
    matched === 0
      ? null
      : check.ignored_columns.length === 0
        ? t("database.import.allColumnsMatched", { count: matched })
        : t("database.import.columnsMatchedIgnored", { count: matched, ignored: check.ignored_columns.join(", ") });

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
          label={t("database.import.dateOrder")}
          size="sm"
          orientation="horizontal"
          value={effectiveOrder}
          isDisabled={busy}
          onChange={(v) => {
            if (v !== effectiveOrder) onDateOrder(v as DateOrder);
          }}
        >
          <RadioListItem value="mdy" label={t("database.import.mdy")} description={t("database.import.mdyExample")} />
          <RadioListItem value="dmy" label={t("database.import.dmy")} description={t("database.import.dmyExample")} />
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
            <th className="db-import__num">{t("common.row")}</th>
            <th>{t("database.column.label")}</th>
            <th>{t("database.value.label")}</th>
            <th>{t("database.import.problem")}</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => {
            const hint = importHint(e);
            return (
              <tr key={i}>
                <td className="db-import__num">{e.row === 0 ? t("database.import.headerRow") : fmtInt(e.row)}</td>
                <td>{e.column ?? ""}</td>
                <td className="db-import__value">{e.value ?? ""}</td>
                <td>
                  <div>{importProblem(e)}</div>
                  {hint ? <div className="db-import__hint">{hint}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {truncated && (
        <div className="db-import__more">
          <Text type="supporting" color="secondary">
            {t("database.import.truncated", { count: errors.length })}
          </Text>
        </div>
      )}
    </div>
  );
}
