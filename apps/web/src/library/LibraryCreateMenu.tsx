/** The same create actions wherever the library offers a New entry point. */
import { useRef } from "react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import type { LayerAlignment } from "@astryxdesign/core/Layer";
import { Database, FileSpreadsheet, FileText, FileUp, FolderPlus, Plus } from "lucide-react";
import { t } from "../i18n/i18n";
import { IMPORT_FILE_ACCEPT } from "../database/handed-import";

export interface LibraryCreateActions {
  onNewDoc: () => void;
  onNewDatabase: () => void;
  /** A database made from the chosen spreadsheet file: its columns and rows. */
  onNewDatabaseFromFile: (file: File) => void;
  onNewFolder: () => void;
  onImport: () => void;
}

interface LibraryCreateMenuProps extends LibraryCreateActions {
  fill?: boolean;
  /** A plus with no word, for the collapsed side nav; the label names it for screen readers and the tooltip. */
  isIconOnly?: boolean;
  /** "end" where the button sits at the right edge, or the menu opens off the window. */
  alignment?: LayerAlignment;
}

export function LibraryCreateMenu({
  onNewDoc,
  onNewDatabase,
  onNewDatabaseFromFile,
  onNewFolder,
  onImport,
  fill = false,
  isIconOnly = false,
  alignment,
}: LibraryCreateMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <DropdownMenu
        button={{
          label: t("library.create.new"),
          variant: "primary",
          size: "sm",
          icon: <Plus size={15} />,
          width: fill ? "100%" : undefined,
          isIconOnly,
        }}
        menuWidth={220}
        placement="below"
        alignment={alignment}
        presentation="adaptive"
        items={[
          { label: t("library.create.newDocument"), icon: <FileText size={15} />, onClick: onNewDoc },
          { label: t("library.create.newDatabase"), icon: <Database size={15} />, onClick: onNewDatabase },
          { label: t("library.create.newDatabaseFromCsv"), icon: <FileSpreadsheet size={15} />, onClick: () => fileRef.current?.click() },
          { label: t("library.create.newFolder"), icon: <FolderPlus size={15} />, onClick: onNewFolder },
          { type: "divider" },
          { label: t("library.create.importMarkdown"), icon: <FileUp size={15} />, onClick: onImport },
        ]}
      />
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_FILE_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared, so choosing the same file again still counts.
          e.target.value = "";
          if (file) onNewDatabaseFromFile(file);
        }}
      />
    </>
  );
}
