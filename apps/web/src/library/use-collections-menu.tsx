import { useCallback, useState, type ReactNode } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { Library, Plus } from "lucide-react";
import { Collections } from "../api";
import { useCollections } from "../ai/use-collections";
import { PromptDialog } from "../ui/PromptDialog";
import type { LibraryItemRef } from "./move-items";
import { errorMessage } from "../lib/http/client";

interface MenuLeaf {
  label: string;
  icon?: ReactNode;
  isDisabled?: boolean;
  onClick: () => void;
}

/**
 * "Add to collection" for library items: the menu leaves (every collection,
 * then New collection…) and the prompt New collection opens. Leaves only,
 * since the row menu nests them in a section.
 */
export function useCollectionsMenu({ refreshKey, setBusy }: { refreshKey: number; setBusy: (busy: boolean) => void }): {
  menuItems: (items: LibraryItemRef[]) => MenuLeaf[];
  dialog: ReactNode;
} {
  const toast = useToast();
  const { collections, reload } = useCollections(refreshKey);
  const [newCollectionFor, setNewCollectionFor] = useState<LibraryItemRef[] | null>(null);

  /** The server skips items already in the collection, so the toast quotes its count. */
  const addTo = useCallback(
    async (collectionId: string, name: string, items: LibraryItemRef[]) => {
      setBusy(true);
      try {
        const { added } = await Collections.addItems(collectionId, {
          docIds: items.filter((i) => i.kind === "doc").map((i) => i.id),
          folderIds: items.filter((i) => i.kind === "folder").map((i) => i.id),
        });
        const skipped = items.length - added;
        toast({
          body:
            added === 0
              ? `Nothing added to “${name}” — those items are already in it.`
              : skipped > 0
                ? `Added ${added} to “${name}”; ${skipped} already there.`
                : `Added ${added} to “${name}”.`,
          type: "info",
        });
        reload();
      } catch (e) {
        toast({ body: errorMessage(e, "Couldn’t add to that collection."), type: "error" });
      } finally {
        setBusy(false);
      }
    },
    [toast, reload, setBusy],
  );

  async function createWith(name: string) {
    const items = newCollectionFor ?? [];
    setNewCollectionFor(null);
    if (items.length === 0) return;
    try {
      const created = await Collections.create(name);
      await addTo(created.collection_id, created.name, items);
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn’t create that collection."), type: "error" });
    }
  }

  function menuItems(items: LibraryItemRef[]): MenuLeaf[] {
    const placeholder =
      collections === null
        ? [{ label: "Loading…", onClick: () => {}, isDisabled: true }]
        : collections.length === 0
          ? [{ label: "No collections yet", onClick: () => {}, isDisabled: true }]
          : [];
    return [
      ...placeholder,
      ...(collections ?? []).map((c) => ({
        label: `${c.name} (${c.item_count})`,
        icon: <Library size={15} />,
        onClick: () => void addTo(c.collection_id, c.name, items),
      })),
      { label: "New collection…", icon: <Plus size={15} />, onClick: () => setNewCollectionFor(items) },
    ];
  }

  const dialog = (
    <PromptDialog
      isOpen={newCollectionFor !== null}
      title="New collection"
      label="Collection name"
      submitLabel="Create and add"
      onSubmit={createWith}
      onClose={() => setNewCollectionFor(null)}
    />
  );

  return { menuItems, dialog };
}
