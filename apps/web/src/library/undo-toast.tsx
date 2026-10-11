/** A library change's toast with Undo: a move or a trip to the Trash, put back in one click. */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import type { ToastOptions } from "@astryxdesign/core/Toast";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";

/** Long enough to read the toast and reach its button. */
const UNDO_TOAST_MS = 8_000;

let nextId = 0;

/**
 * Shows `body` with Undo. `undo` reverses the change and resolves to what then
 * replaces the toast, so Undo cannot be pressed twice. `toast` must be the
 * caller's: a toast renders in its own React root, where no provider is.
 */
export function showUndoToast(toast: (options: ToastOptions) => void, body: string, undo: () => Promise<string>): void {
  const uniqueID = `library-undo:${++nextId}`;
  toast({
    body,
    type: "info",
    uniqueID,
    autoHideDuration: UNDO_TOAST_MS,
    endContent: (
      <UndoButton
        onUndo={() =>
          undo().then(
            (done) => toast({ body: done, type: "info", uniqueID }),
            (e: unknown) => toast({ body: errorMessage(e, t("library.undo.failed")), type: "error", uniqueID }),
          )
        }
      />
    ),
  });
}

function UndoButton({ onUndo }: { onUndo: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label={t("library.undo.action")}
      variant="ghost"
      size="sm"
      isDisabled={busy}
      onClick={() => {
        setBusy(true);
        void onUndo().finally(() => setBusy(false));
      }}
    />
  );
}
