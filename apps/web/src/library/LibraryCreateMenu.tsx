/** The same create actions wherever the library offers a New entry point. */
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import type { LayerAlignment } from "@astryxdesign/core/Layer";
import { Database, FileText, FileUp, FolderPlus, Plus } from "lucide-react";
import { t } from "../i18n/i18n";

interface LibraryCreateMenuProps {
  onNewDoc: () => void;
  onNewDatabase: () => void;
  onNewFolder: () => void;
  onImport: () => void;
  fill?: boolean;
  /** "end" where the button sits at the right edge, or the menu opens off the window. */
  alignment?: LayerAlignment;
}

export function LibraryCreateMenu({ onNewDoc, onNewDatabase, onNewFolder, onImport, fill = false, alignment }: LibraryCreateMenuProps) {
  return (
    <DropdownMenu
      button={{ label: t("library.create.new"), variant: "primary", size: "sm", icon: <Plus size={15} />, width: fill ? "100%" : undefined }}
      menuWidth={220}
      placement="below"
      alignment={alignment}
      presentation="adaptive"
      items={[
        { label: t("library.create.newDocument"), icon: <FileText size={15} />, onClick: onNewDoc },
        { label: t("library.create.newDatabase"), icon: <Database size={15} />, onClick: onNewDatabase },
        { label: t("library.create.newFolder"), icon: <FolderPlus size={15} />, onClick: onNewFolder },
        { type: "divider" },
        { label: t("library.create.importMarkdown"), icon: <FileUp size={15} />, onClick: onImport },
      ]}
    />
  );
}
