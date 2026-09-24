/** The same create actions wherever the library offers a New entry point. */
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import type { LayerAlignment } from "@astryxdesign/core/Layer";
import { Database, FileText, FileUp, FolderPlus, Plus } from "lucide-react";

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
      button={{ label: "New", variant: "primary", size: "sm", icon: <Plus size={15} />, width: fill ? "100%" : undefined }}
      menuWidth={220}
      placement="below"
      alignment={alignment}
      presentation="adaptive"
      items={[
        { label: "New document", icon: <FileText size={15} />, onClick: onNewDoc },
        { label: "New database", icon: <Database size={15} />, onClick: onNewDatabase },
        { label: "New folder", icon: <FolderPlus size={15} />, onClick: onNewFolder },
        { type: "divider" },
        { label: "Import from Markdown", icon: <FileUp size={15} />, onClick: onImport },
      ]}
    />
  );
}
