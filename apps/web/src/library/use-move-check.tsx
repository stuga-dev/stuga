/**
 * The check before a move that would let more people in. Inheritance only adds, so moving an item
 * into a folder gives it the folder's access as well as its own: the person is told who gains what
 * and confirms. A move that lets nobody new in, or one whose sharing cannot be read, goes ahead.
 */
import { useCallback, useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Folders } from "../api";
import { listOf } from "../lib/format";
import { principalLabel, useUserNames } from "../state/identity";
import { t } from "../i18n/i18n";
import { moveAccessGains, type AccessGain, type LibraryItemRef } from "./move-items";

interface Pending {
  gains: AccessGain[];
  folder: string | null;
  count: number;
  resolve: (go: boolean) => void;
}

/** A gainer as the sentence names them; the workspace is "Everyone in this workspace". */
function gainerName(principal: string): string {
  return principal.startsWith("org:") ? t("library.share.everyoneInThis") : principalLabel(principal);
}

export function useMoveCheck(): {
  /** Resolves to whether the move should go ahead. */
  confirmMove: (items: readonly LibraryItemRef[], destId: string | null) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirmMove = useCallback(async (items: readonly LibraryItemRef[], destId: string | null) => {
    if (destId === null || items.length === 0) return true;
    const [gains, folder] = await Promise.all([
      moveAccessGains(items, destId).catch(() => []),
      Folders.ancestors(destId)
        .then((r) => r.ancestors.at(-1)?.title ?? null)
        .catch(() => null),
    ]);
    if (gains.length === 0) return true;
    return new Promise<boolean>((resolve) => setPending({ gains, folder, count: items.length, resolve }));
  }, []);

  useUserNames(pending?.gains.map((g) => g.principal) ?? []);

  function finish(go: boolean) {
    pending?.resolve(go);
    setPending(null);
  }

  let dialog: ReactNode = null;
  if (pending) {
    const editors = pending.gains.filter((g) => g.role === "editor").map((g) => gainerName(g.principal));
    const viewers = pending.gains.filter((g) => g.role === "viewer").map((g) => gainerName(g.principal));
    const sentences = [
      ...(editors.length ? [t("library.move.widenEdit", { people: listOf(editors), count: pending.count })] : []),
      ...(viewers.length ? [t("library.move.widenView", { people: listOf(viewers), count: pending.count })] : []),
    ];
    dialog = (
      <AlertDialog
        isOpen
        onOpenChange={(open) => !open && finish(false)}
        title={pending.folder ? t("library.move.widenTitle", { folder: pending.folder }) : t("library.move.widenTitleUnnamed")}
        description={sentences.join(" ")}
        actionLabel={t("library.move.widenAction")}
        actionVariant="primary"
        onAction={() => finish(true)}
      />
    );
  }
  return { confirmMove, dialog };
}
