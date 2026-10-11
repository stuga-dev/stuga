/** Pick a destination folder, or the top level, for a move. Each level loads when it is expanded. */
import { useCallback, useEffect, useState } from "react";
import { Folders, type Folder } from "../api";
import { t } from "../i18n/i18n";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { Item } from "@astryxdesign/core/Item";
import { HStack } from "@astryxdesign/core/HStack";
import { ChevronRight, ChevronDown, Folder as FolderIcon, Files } from "lucide-react";
import { useFocusReturn } from "./use-focus-return";

interface Props {
  /** Folders being moved: a folder cannot move into its own subtree, so these are not offered. */
  excludeSubtreeOf?: ReadonlySet<string>;
  /** null is the top level; `title` is the destination as people read it, for saying where something went. */
  onPick: (folderId: string | null, title: string) => void;
  onClose: () => void;
}

export function FolderPicker({ excludeSubtreeOf, onPick, onClose }: Props) {
  useFocusReturn();
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTitle, setSelectedTitle] = useState(t("common.allDocuments"));
  const select = (id: string | null, title: string) => {
    setSelected(id);
    setSelectedTitle(title);
  };
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={t("ui.folderPicker.title")} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <div className="folder-picker-tree">
              <Item
                as="div"
                density="compact"
                label={t("common.allDocuments")}
                startContent={<Files size={15} />}
                isSelected={selected === null}
                onClick={() => select(null, t("common.allDocuments"))}
              />
              <PickerLevel
                parentId={null}
                depth={0}
                selected={selected}
                exclude={excludeSubtreeOf}
                onSelect={select}
              />
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" onClick={onClose} />
              <Button label={t("ui.folderPicker.moveHere")} variant="primary" onClick={() => onPick(selected, selectedTitle)} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function PickerLevel({
  parentId,
  depth,
  selected,
  exclude,
  onSelect,
}: {
  parentId: string | null;
  depth: number;
  selected: string | null;
  /** Omitting a folder hides its subtree too, since a subtree is only reached by expanding it. */
  exclude?: ReadonlySet<string>;
  onSelect: (id: string | null, title: string) => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    Folders.list(parentId)
      .then((r) => setFolders(exclude ? r.folders.filter((f) => !exclude.has(f.folder_id)) : r.folders))
      .catch(() => setFolders([]));
  }, [parentId, exclude]);
  useEffect(() => load(), [load]);

  if (folders.length === 0) return null;
  return (
    <ul className="folder-level">
      {folders.map((f) => {
        const open = expanded.has(f.folder_id);
        const toggle = (e: React.MouseEvent) => {
          e.stopPropagation();
          setExpanded((s) => {
            const n = new Set(s);
            if (n.has(f.folder_id)) n.delete(f.folder_id);
            else n.add(f.folder_id);
            return n;
          });
        };
        return (
          <li key={f.folder_id}>
            <div style={{ paddingLeft: `${depth * 0.9}rem` }}>
              <Item
                as="div"
                density="compact"
                label={f.title}
                labelLines={1}
                isSelected={selected === f.folder_id}
                onClick={() => onSelect(f.folder_id, f.title || t("common.untitledFolder"))}
                marker={
                  <button className="folder-caret" onClick={toggle} title={open ? t("ui.folderPicker.collapse") : t("ui.folderPicker.expand")}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                }
                startContent={<FolderIcon size={15} />}
              />
            </div>
            {open && (
              <PickerLevel
                parentId={f.folder_id}
                depth={depth + 1}
                selected={selected}
                exclude={exclude}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
