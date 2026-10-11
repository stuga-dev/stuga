/**
 * New folder: just its name. Instructions for agents are added afterwards from
 * the folder's ⋯ menu, which also shows what the folder inherits.
 */
import { PromptDialog } from "../ui/PromptDialog";
import { t } from "../i18n/i18n";

interface NewFolderDialogProps {
  isOpen: boolean;
  /** The trimmed name. */
  onSubmit: (title: string) => void;
  onClose: () => void;
}

export function NewFolderDialog({ isOpen, onSubmit, onClose }: NewFolderDialogProps) {
  return (
    <PromptDialog
      isOpen={isOpen}
      title={t("library.create.newFolder")}
      label={t("library.explorer.folderName")}
      submitLabel={t("common.create")}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
