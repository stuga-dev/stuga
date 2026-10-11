/**
 * Import a CSV or JSONL file into one table, or into a new one made from it.
 * Choosing a file stages it and asks the node for a dry-run verdict; each of the
 * file's columns then goes to a column of the table, to a new column, or
 * nowhere, and any change is checked again. The one button says exactly what
 * it will do ("Import 1 row, skip 2").
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Banner } from "@astryxdesign/core/Banner";
import { AlertTriangle, Check, Download, FileText } from "lucide-react";
import { Databases } from "../api";
import type { ImportShape } from "../api/databases";
import { errorMessage, type ApiError } from "../lib/http/client";
import { saveBlob } from "../lib/download";
import type {
  DatabaseImportCheck,
  DatabaseImportError,
  DatabaseImportErrorCode,
  DatabaseImportHeader,
  DatabaseImportResult,
  TableSchema,
} from "@stuga/protocol/databases/types";
import { t, type MessageKey } from "../i18n/i18n";
import { byteSize, fmtInt } from "../lib/format";
import { presentServerMessage } from "../lib/http/server-messages";
import { knownCellProblem } from "./model/cell-problems";
import { columnTypeLabel } from "./model/column-types";
import {
  checkedAs,
  choiceCounts,
  defaultChoices,
  importShape,
  mappableHeaders,
  tableNameFromFile,
  type HeaderChoice,
  type ImportTarget,
} from "./model/import-mapping";
import { csvCell } from "@stuga/protocol/domain/audit";
import { IMPORT_FILE_ACCEPT } from "./handed-import";

const ACCEPT = IMPORT_FILE_ACCEPT;

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
  /** A file chosen before the dialog opened, as for a database made from a CSV. */
  initialFile?: File | null;
  onClose: () => void;
  /** The page reloads the schema and the grid; `result.table_id` names a new table. */
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

export function ImportDialog({ isOpen, docId, table, initialFile = null, onClose, onImported }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null);
  /** The node's staging of the current file, reused by re-checks and the commit. */
  const [importId, setImportId] = useState<string | null>(null);
  const [target, setTarget] = useState<ImportTarget>({ kind: "table" });
  /** Where each of the file's columns goes; null until the node has read the file. */
  const [choices, setChoices] = useState<Record<string, HeaderChoice> | null>(null);
  /** Only the latest check may land: choices change faster than the node answers. */
  const checkSeq = useRef(0);
  // An empty table, as a database just made from a file has, offers no template and no second table.
  const emptyTable = table.columns.length === 0 && table.row_count === 0;

  useEffect(() => {
    if (!isOpen) return;
    setFile(null);
    setPhase({ kind: "idle" });
    setError(null);
    setDateOrder(null);
    setImportId(null);
    setTarget({ kind: "table" });
    setChoices(null);
    if (initialFile) chooseFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh dialog per opening
  }, [isOpen]);

  const busy = phase.kind === "checking" || phase.kind === "importing";

  /**
   * Stage (once per file) and ask for the verdict. Without `shape` the node
   * matches the headers itself, and its reading seeds the choices; when those
   * differ from it (a close match, a new column), the file is checked again as chosen.
   */
  async function check(f: File, order: DateOrder | null, staged: string | null, as: { target: ImportTarget; choices: Record<string, HeaderChoice> | null }) {
    const seq = ++checkSeq.current;
    setPhase({ kind: "checking" });
    setError(null);
    try {
      let id = staged;
      if (!id) {
        id = (await Databases.stageImport(docId, table.table_id, f)).import_id;
        setImportId(id);
      }
      const dates = order ? { date_order: order } : {};
      const shape: ImportShape = as.choices ? importShape(as.choices, as.target) : as.target.kind === "new" ? { new_table: as.target.name } : {};
      let verdict = await Databases.checkImport(docId, id, { ...shape, ...dates });
      let next = as.choices;
      if (!next) {
        next = defaultChoices(verdict, as.target);
        if (!checkedAs(verdict, next)) verdict = await Databases.checkImport(docId, id, { ...importShape(next, as.target), ...dates });
      }
      if (seq !== checkSeq.current) return;
      setChoices(next);
      setPhase({ kind: "checked", check: verdict });
    } catch (e) {
      if (seq !== checkSeq.current) return;
      setPhase({ kind: "idle" });
      setError(errorMessage(e, t("database.import.readFailed")));
    }
  }

  async function importNow() {
    if (phase.kind !== "checked" || !importId || !file || !choices) return;
    const { check: verdict } = phase;
    setPhase({ kind: "importing", check: verdict });
    setError(null);
    const opts = {
      ...importShape(choices, target),
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
    setChoices(null);
    setTarget({ kind: "table" });
    // Into an empty table every column is new, since none matches: its columns are made from the file.
    if (f) void check(f, null, null, { target: { kind: "table" }, choices: null });
    else {
      checkSeq.current++;
      setPhase({ kind: "idle" });
    }
  }

  function flipDateOrder(order: DateOrder) {
    if (!file) return;
    setDateOrder(order);
    void check(file, order, importId, { target, choices });
  }

  function choose(header: string, choice: HeaderChoice) {
    if (!file || !choices) return;
    const next = { ...choices, [header]: choice };
    setChoices(next);
    void check(file, dateOrder, importId, { target, choices: next });
  }

  function chooseTarget(next: ImportTarget) {
    if (!file) return;
    setTarget(next);
    // A new table starts from the file again; back to this table, from the node's own matching.
    void check(file, dateOrder, importId, { target: next, choices: null });
  }

  function renameNewTable(name: string) {
    setTarget({ kind: "new", name });
  }

  function downloadTemplate() {
    saveBlob(new Blob([importTemplateCsv(table)], { type: "text/csv;charset=utf-8" }), t("database.import.templateFileName", { table: table.name }));
  }

  const close = () => !busy && onClose();
  const verdict = phase.kind === "checked" || phase.kind === "importing" ? phase.check : null;
  const newName = target.kind === "new" ? target.name.trim() : "";

  const action = verdict
    ? verdict.rows_ready === 0 || (target.kind === "new" && newName === "")
      ? { label: t("common.import"), disabled: true }
      : verdict.rows_failed > 0
        ? { label: t("database.import.actionRowsSkip", { count: verdict.rows_ready, skipped: verdict.rows_failed }), disabled: false }
        : { label: t("database.import.actionRows", { count: verdict.rows_ready }), disabled: false }
    : { label: t("common.import"), disabled: true };

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={640}>
      <Layout
        header={
          <DialogHeader
            title={target.kind === "new" ? t("database.import.titleNewTable") : t("database.import.title", { name: table.display })}
            onOpenChange={(o) => !o && close()}
          />
        }
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
                    {!emptyTable && (
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
                    )}
                  </>
                )}

                {file && !emptyTable && (
                  <HStack gap={3} vAlign="end" wrap="wrap">
                    <RadioList
                      label={t("database.import.target")}
                      size="sm"
                      orientation="horizontal"
                      value={target.kind}
                      isDisabled={busy}
                      onChange={(v) => {
                        if (v === target.kind) return;
                        chooseTarget(v === "new" ? { kind: "new", name: tableNameFromFile(file.name) } : { kind: "table" });
                      }}
                    >
                      <RadioListItem value="table" label={t("database.import.targetTable", { name: table.display })} />
                      <RadioListItem value="new" label={t("database.import.targetNew")} />
                    </RadioList>
                    {target.kind === "new" && (
                      <div className="db-import__name">
                        <TextInput label={t("database.import.newTableName")} size="sm" value={target.name} onChange={renameNewTable} isDisabled={busy} />
                      </div>
                    )}
                  </HStack>
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

                {verdict && <Verdict check={verdict} choices={choices} dateOrder={dateOrder} onDateOrder={flipDateOrder} busy={busy} />}

                {verdict && choices && (
                  <ColumnMapping
                    headers={mappableHeaders(verdict)}
                    choices={choices}
                    table={table}
                    intoNewTable={target.kind === "new"}
                    busy={busy}
                    onChoose={choose}
                  />
                )}
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

/** Each of the file's columns and where it goes: a column of the table, a new column, or nowhere. */
function ColumnMapping({
  headers,
  choices,
  table,
  intoNewTable,
  busy,
  onChoose,
}: {
  headers: DatabaseImportHeader[];
  choices: Record<string, HeaderChoice>;
  table: TableSchema;
  intoNewTable: boolean;
  busy: boolean;
  onChoose: (header: string, choice: HeaderChoice) => void;
}) {
  const columns = [...table.columns].sort((a, b) => a.position - b.position);
  const valueOf = (c: HeaderChoice | undefined) => (!c || c.kind === "skip" ? "skip" : c.kind === "new" ? "new" : `col:${c.columnId}`);
  return (
    <div className="db-import__card">
      <div className="db-import__card-head">
        <Text type="body" weight="semibold">
          {t("database.import.columns")}
        </Text>
      </div>
      <div className="db-import__map">
        {headers.map((h) => {
          const near = h.suggestion ? columns.find((c) => c.column_id === h.suggestion) : undefined;
          const options = [
            ...(intoNewTable
              ? []
              : [
                  ...(near ? [{ value: `col:${near.column_id}`, label: t("database.import.map.closeMatch", { name: near.display }) }] : []),
                  ...columns.filter((c) => c !== near).map((c) => ({ value: `col:${c.column_id}`, label: c.display })),
                ]),
            { value: "new", label: t("database.import.map.newColumn", { type: columnTypeLabel(h.new_type) }) },
            { value: "skip", label: t("database.import.map.skip") },
          ];
          return (
            <div key={h.header} className="db-import__map-row">
              <span className="db-import__map-header" title={h.header}>
                {h.header}
              </span>
              <span className="db-import__map-arrow" aria-hidden="true">
                →
              </span>
              <div className="db-import__map-choice">
                <Selector
                  label={t("database.import.map.label", { header: h.header })}
                  isLabelHidden
                  size="sm"
                  value={valueOf(choices[h.header])}
                  isDisabled={busy}
                  options={options}
                  onChange={(v) => {
                    const value = String(v);
                    onChoose(h.header, value === "new" ? { kind: "new" } : value === "skip" ? { kind: "skip" } : { kind: "column", columnId: value.slice(4) });
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One headline, how the columns go, the problems, and the date order when the file left it ambiguous. */
function Verdict({
  check,
  choices,
  dateOrder,
  onDateOrder,
  busy,
}: {
  check: DatabaseImportCheck;
  choices: Record<string, HeaderChoice> | null;
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
  const headerProblem = check.errors.some((e) => e.row === 0);
  const detail = nothing
    ? check.rows_total === 0
      ? undefined
      : headerProblem
        ? t("database.import.headersMismatch")
        : t("database.import.everyRowBad")
    : allGood
      ? undefined
      : t("database.import.someBad", { count: check.rows_failed });
  const effectiveOrder = dateOrder ?? check.guessed_date_order ?? null;
  const counts = choices ? choiceCounts(choices) : null;
  // Said only when every column has somewhere to go, so it never sits under "None of the rows can be imported" for a header reason.
  const columnsLine =
    counts && !headerProblem
      ? counts.matched === 0
        ? t("database.import.columnsAllNew", counts)
        : t("database.import.columnsSummary", counts)
      : null;

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
