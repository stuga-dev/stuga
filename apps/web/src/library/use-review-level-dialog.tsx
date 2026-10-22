import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { ReviewLevelDialog, type ReviewLevelTarget } from "./ReviewLevelDialog";
import { useManages } from "./use-manages";
import { Folders } from "../api";
import { t } from "../i18n/i18n";

/**
 * "Who reviews AI edits…" for any menu: `item` is the menu entry for one document, database or folder
 * and `dialog` is rendered once beside the menu. The last target is kept after closing so the
 * dialog does not go blank while it animates out.
 */
export function useReviewLevelDialog(): {
  item: (target: ReviewLevelTarget) => { label: string; icon: ReactNode; onClick: () => void };
  dialog: ReactNode;
} {
  const manages = useManages();
  const [target, setTarget] = useState<ReviewLevelTarget | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  /** Whether the caller owns a folder above the target, who may set its level too; null while asking. */
  const [ownsAbove, setOwnsAbove] = useState<boolean | null>(false);

  const item = useCallback(
    (next: ReviewLevelTarget) => ({
      label: t("library.review.menuItem"),
      icon: <ShieldCheck size={15} />,
      onClick: () => {
        setTarget(next);
        setIsOpen(true);
      },
    }),
    [],
  );

  // In a folder, the owner of a folder above may set the item's level too, whoever owns the item:
  // asked for when the dialog opens. The server decides which levels each may choose.
  const owned = target && (target.kind === "folder" ? target.folder : target.doc);
  const managed = owned !== null && manages(owned.owner);
  const parentId = owned?.parent_id ?? null;
  useEffect(() => {
    if (!isOpen || managed || parentId === null) {
      setOwnsAbove(false);
      return;
    }
    let live = true;
    setOwnsAbove(null);
    Folders.ancestors(parentId)
      .then((r) => live && setOwnsAbove(r.ancestors.some((f) => f.owner !== null && manages(f.owner))))
      .catch(() => live && setOwnsAbove(false));
    return () => {
      live = false;
    };
  }, [isOpen, managed, parentId, manages]);
  const canEdit = owned !== null && (managed || ownsAbove === true);
  const dialog = target && (
    <ReviewLevelDialog isOpen={isOpen} target={target} canEdit={canEdit} canEditGroup={managed} onClose={() => setIsOpen(false)} />
  );

  return { item, dialog };
}
