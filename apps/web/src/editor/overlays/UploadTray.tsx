/** Image uploads in flight or failed, pinned to the viewport; outside the document, so progress never reaches the CRDT. */
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ImageIcon, AlertTriangle, X } from "lucide-react";
import type { Uploader } from "../use-upload";
import { t } from "../../i18n/i18n";

export function UploadTray({ uploader }: { uploader: Uploader }) {
  const { items, dismiss } = uploader;
  if (items.length === 0) return null;

  return (
    <div className="upload-tray" role="status" aria-live="polite">
      {items.map((it) => (
        <div key={it.id} className={`upload-row${it.status === "error" ? " error" : ""}`}>
          <span className="upload-row__name" title={it.name}>
            {it.status === "error" ? <AlertTriangle size={14} /> : <ImageIcon size={14} />}
            {" "}{it.name}
          </span>
          {it.status === "uploading" ? (
            <>
              <div className="upload-bar">
                <ProgressBar
                  label={t("editor.upload.uploading", { name: it.name })}
                  isLabelHidden
                  hasValueLabel
                  value={Math.round(it.progress * 100)}
                  max={100}
                />
              </div>
              <IconButton label={t("editor.upload.cancel")} variant="ghost" size="sm" icon={<X size={14} />} onClick={it.cancel} />
            </>
          ) : (
            <>
              <span className="upload-row__err" title={it.error}>{it.error ?? t("editor.upload.failed")}</span>
              <IconButton label={t("common.dismiss")} variant="ghost" size="sm" icon={<X size={14} />} onClick={() => dismiss(it.id)} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
