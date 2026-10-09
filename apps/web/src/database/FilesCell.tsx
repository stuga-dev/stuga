/**
 * A files cell: its files as links that download them, each removable, and more added by picking
 * or dropping them. Each change saves at once, so there is no edit mode. A file is uploaded into
 * the database, which keeps it as long as the database.
 */
import { useRef, useState, type DragEvent } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { Paperclip, Plus, X } from "lucide-react";
import { fileLinks, filesCell } from "@stuga/protocol/databases/cells";
import type { RowValue } from "@stuga/protocol/databases/types";
import { Media } from "../api";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";

export function FilesCell({
  databaseId,
  label,
  value,
  readOnly,
  wrap = false,
  onChange,
}: {
  databaseId: string;
  /** The column's name, for the add button's label. */
  label: string;
  value: RowValue;
  readOnly: boolean;
  /** Wrap the files onto more lines, as the row panel has room to. */
  wrap?: boolean;
  onChange: (value: string | null) => void;
}) {
  const toast = useToast();
  const files = fileLinks(value);
  // An upload finishes after the cell may have changed; it adds to the cell as it is then.
  const current = useRef(value);
  current.current = value;
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);

  async function add(picked: File[]) {
    if (picked.length === 0) return;
    setUploading((n) => n + picked.length);
    const links: string[] = [];
    for (const file of picked) {
      try {
        links.push((await Media.uploadWithProgress(databaseId, file, () => {})).url);
      } catch (e) {
        toast({ body: errorMessage(e, t("database.files.uploadFailed", { name: file.name })), type: "error" });
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (links.length > 0) onChange(filesCell([...fileLinks(current.current).map((f) => f.link), ...links]));
  }

  const dropProps = readOnly
    ? {}
    : {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        },
        onDragLeave: () => setDropping(false),
        onDrop: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropping(false);
          void add([...e.dataTransfer.files]);
        },
      };

  return (
    <span className={`db-files${wrap ? " db-files--wrap" : ""}${dropping ? " db-files--drop" : ""}`} {...dropProps}>
      {files.map((file) => (
        <span key={file.link} className="db-file">
          <a className="db-file__link" href={file.link} download={file.name} title={t("database.files.download", { name: file.name })}>
            <Paperclip size={12} aria-hidden />
            <span className="db-file__name">{file.name}</span>
          </a>
          {!readOnly && (
            <button
              className="db-file__remove"
              aria-label={t("database.files.remove", { name: file.name })}
              title={t("common.remove")}
              onClick={() => onChange(filesCell(files.filter((f) => f.link !== file.link).map((f) => f.link)))}
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {uploading > 0 && <span className="db-files__busy">{t("database.files.uploading")}</span>}
      {!readOnly && (
        <>
          <button className="db-files__add" aria-label={t("database.files.addTo", { name: label })} title={t("database.files.add")} onClick={() => picker.current?.click()}>
            <Plus size={14} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </>
      )}
    </span>
  );
}
