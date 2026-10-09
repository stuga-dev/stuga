/**
 * Create documents from .md files or pasted Markdown. There is no title field:
 * the server derives the title from the document's first heading. The size
 * check here only fails fast; the server enforces it.
 */
import { useEffect, useRef, useState } from "react";
import { Docs, type DocSummary } from "../api";
import { MAX_IMPORT_MARKDOWN_BYTES, MAX_IMPORT_FILES, markdownByteLength } from "@stuga/protocol/text/markdown-import";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { FileInput } from "@astryxdesign/core/FileInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Check, AlertTriangle } from "lucide-react";
import { t } from "../i18n/i18n";

const ACCEPT = ".md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain";

type Mode = "upload" | "paste";
interface Row {
  name: string;
  status: "pending" | "done" | "error";
  error?: string;
}

interface ImportMarkdownDialogProps {
  isOpen: boolean;
  /** The folder new documents land in. */
  parentId: string | null;
  /** `complete` is false when some files failed and the dialog stays open to list them; do not navigate away then. */
  onImported: (docs: DocSummary[], complete: boolean) => void;
  onClose: () => void;
}

export function ImportMarkdownDialog({ isOpen, parentId, onImported, onClose }: ImportMarkdownDialogProps) {
  const [mode, setMode] = useState<Mode>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The run that failed still created some documents.
  const [partial, setPartial] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  // Closing mid-run stops the import at the next file.
  const cancelled = useRef(false);
  // Created by a run that also had failures; reported on dismissal, since the caller may navigate away.
  const unreported = useRef<DocSummary[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    setMode("upload");
    setFiles([]);
    setPasted("");
    setBusy(false);
    setError(null);
    setPartial(false);
    setRows([]);
    cancelled.current = false;
    unreported.current = [];
  }, [isOpen]);

  const canSubmit = busy ? false : mode === "upload" ? files.length > 0 : pasted.trim() !== "";

  /** Stops a running import at the next file and reports what a partial run created. */
  function requestClose() {
    cancelled.current = true;
    const pending = unreported.current;
    unreported.current = [];
    if (pending.length > 0) onImported(pending, false);
    onClose();
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);

    if (mode === "paste") {
      if (markdownByteLength(pasted) > MAX_IMPORT_MARKDOWN_BYTES) {
        setError(t("library.import.pastedTooLarge", { kb: LIMIT_KB }));
        setBusy(false);
        return;
      }
      try {
        const doc = await Docs.createFromMarkdown(pasted, undefined, parentId);
        onImported([doc], true);
        onClose();
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    // One file at a time: each import starts a document actor.
    const queue = files;
    setRows(queue.map((f) => ({ name: f.name, status: "pending" })));
    const created: DocSummary[] = [];
    const failed: File[] = [];
    for (const [i, file] of queue.entries()) {
      if (cancelled.current) break;
      const finish = (status: Row["status"], err?: string) =>
        setRows((rs) => rs.map((r, j) => (j === i ? { ...r, status, error: err } : r)));
      try {
        if (file.size > MAX_IMPORT_MARKDOWN_BYTES) {
          failed.push(file);
          finish("error", t("library.import.fileTooLarge", { kb: LIMIT_KB }));
          continue;
        }
        const text = await file.text();
        const doc = await Docs.createFromMarkdown(text, file.name, parentId);
        created.push(doc);
        finish("done");
      } catch (e) {
        failed.push(file);
        finish("error", messageOf(e));
      }
    }

    if (cancelled.current) {
      // requestClose reported what existed then; report what finished since.
      const late = created.filter((d) => !unreported.current.includes(d));
      if (late.length > 0) onImported(late, false);
      return;
    }
    setBusy(false);

    if (failed.length === 0) {
      onImported(created, true);
      onClose();
      return;
    }
    // Keep only the failed files, so Import retries them without duplicating the successes.
    unreported.current = created;
    setFiles(failed);
    setPartial(created.length > 0);
    if (created.length === 0) setError(t("library.import.nothing"));
    else setError(t("library.import.partial", { done: created.length, total: queue.length }));
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && requestClose()} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title={t("library.create.importMarkdown")} onOpenChange={(o) => !o && requestClose()} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <SegmentedControl label={t("library.import.source")} value={mode} onChange={(v) => setMode(v as Mode)} isDisabled={busy}>
                <SegmentedControlItem value="upload" label={t("library.import.upload")} />
                <SegmentedControlItem value="paste" label={t("library.import.paste")} />
              </SegmentedControl>

              {mode === "upload" ? (
                <FileInput
                  label={t("library.import.filesLabel")}
                  description={t("library.import.filesHint")}
                  mode="dropzone"
                  accept={ACCEPT}
                  isMultiple
                  maxSize={MAX_IMPORT_MARKDOWN_BYTES}
                  maxFiles={MAX_IMPORT_FILES}
                  isDisabled={busy}
                  value={files}
                  onChange={(f) => setFiles(f === null ? [] : Array.isArray(f) ? f : [f])}
                />
              ) : (
                <TextArea
                  label={t("library.import.markdownLabel")}
                  description={t("library.import.pasteHint")}
                  placeholder={t("library.import.pastePlaceholder")}
                  rows={12}
                  hasAutoFocus
                  isDisabled={busy}
                  value={pasted}
                  onChange={setPasted}
                />
              )}

              {rows.length > 0 && (
                <VStack gap={1}>
                  {rows.map((r) => (
                    <HStack key={r.name} gap={2} vAlign="center">
                      {r.status === "done" && <Check size={14} />}
                      {r.status === "error" && <AlertTriangle size={14} />}
                      <Text type="supporting" color={r.status === "error" ? "primary" : "secondary"}>
                        {r.status === "error"
                          ? r.error
                            ? t("library.import.rowFailed", { name: r.name, error: r.error })
                            : t("library.import.rowFailedPlain", { name: r.name })
                          : r.status === "pending"
                            ? t("library.import.rowImporting", { name: r.name })
                            : r.name}
                      </Text>
                    </HStack>
                  ))}
                </VStack>
              )}

              {error && (
                <Banner
                  status={partial ? "warning" : "error"}
                  title={partial ? t("library.import.someFailed") : t("library.import.failed")}
                  description={error}
                />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={busy ? t("common.stop") : t("common.cancel")} variant="ghost" onClick={requestClose} />
              <Button
                label={busy ? t("library.import.importing") : t("common.import")}
                variant="primary"
                onClick={submit}
                isDisabled={!canSubmit}
                isLoading={busy}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

const LIMIT_KB = Math.floor(MAX_IMPORT_MARKDOWN_BYTES / 1024);

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : t("library.import.failedRetry");
}
