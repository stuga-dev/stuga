/**
 * The Collections view: the collections on the left, and the selected one's
 * membership picker on the right. A failed load has its own state, so an outage
 * never reads as an empty collection someone might "refill" and save.
 */
import { useCallback, useEffect, useState } from "react";
import { Collections, type CollectionSummary, type CollectionItem } from "../api";
import { errorMessage } from "../lib/http/client";
import { CollectionEditor } from "./CollectionEditor";
import { PromptDialog } from "../ui/PromptDialog";
import { LoadFailed } from "../ui/LoadFailed";
import { List, ListItem } from "@astryxdesign/core/List";
import { Button } from "@astryxdesign/core/Button";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Section } from "@astryxdesign/core/Section";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Text, Heading } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Badge } from "@astryxdesign/core/Badge";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useToast } from "@astryxdesign/core/Toast";
import { Pencil, Trash2, Plus, Library } from "lucide-react";

interface CollectionsPaneProps {
  /** From the URL, so the selection is linkable. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function CollectionsPane({ selectedId, onSelect }: CollectionsPaneProps) {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [itemsFailed, setItemsFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const toast = useToast();

  const reloadList = useCallback(() => {
    setListFailed(false);
    Collections.list()
      .then((r) => {
        setCollections(r.collections);
        setListFailed(false);
      })
      .catch(() => setListFailed(true));
  }, []);
  useEffect(() => reloadList(), [reloadList]);

  // Keeps `items` during the refetch: the picker must stay mounted after Save or Discard, re-seeded in place.
  const reloadItems = useCallback((id: string) => {
    setItemsFailed(false);
    Collections.get(id)
      .then((r) => setItems(r.items))
      .catch(() => setItemsFailed(true));
  }, []);
  useEffect(() => {
    // Another collection's membership must never tick this one's boxes.
    setItemsFailed(false);
    setItems(null);
    if (selectedId) reloadItems(selectedId);
    else setItems([]);
  }, [selectedId, reloadItems]);

  const failed = (fallback: string) => (e: unknown) => {
    toast({ body: errorMessage(e, fallback), type: "error" });
    return null;
  };

  async function createCollection(name: string) {
    const c = await Collections.create(name).catch(failed("Couldn’t create that collection."));
    reloadList();
    if (c) onSelect(c.collection_id);
  }

  async function doRename(name: string) {
    if (!renaming) return;
    await Collections.rename(renaming, name).catch(failed("Couldn’t rename that collection."));
    reloadList();
  }

  async function doDelete() {
    const id = deleting;
    setDeleting(null);
    if (!id) return;
    const removed = await Collections.remove(id).catch(failed("Couldn’t delete that collection."));
    if (removed && selectedId === id) onSelect(null);
    reloadList();
  }

  const selected = collections?.find((c) => c.collection_id === selectedId) ?? null;
  const renamingName = collections?.find((c) => c.collection_id === renaming)?.name ?? "";
  const deletingName = collections?.find((c) => c.collection_id === deleting)?.name ?? "";

  return (
    <div className="collections-page">
      <Section
        width={280}
        padding={2}
        variant="transparent"
        dividers={["end"]}
        className="collections-page__master"
        style={{ flexShrink: 0 }}
      >
        <div className="collections-page__master-inner">
          <div className="collections-page__new">
            <Button
              label="New collection"
              variant="secondary"
              size="sm"
              icon={<Plus size={15} />}
              width="100%"
              onClick={() => setCreating(true)}
            />
          </div>
          <div className="collections-page__list">
            {listFailed ? (
              <div className="collections-page__center">
                <LoadFailed
                  isCompact
                  title="Couldn’t load collections"
                  description="Your collections are still there — this list didn’t load."
                  icon={<Library size={22} />}
                  onRetry={reloadList}
                />
              </div>
            ) : collections === null ? (
              <div className="collections-page__center">
                <Spinner label="Loading" />
              </div>
            ) : collections.length === 0 ? (
              <div className="collections-page__center">
                <EmptyState
                  isCompact
                  title="No collections"
                  description="Group documents into a scope the AI can search."
                  icon={<Library size={22} />}
                />
              </div>
            ) : (
              <List density="compact" hasDividers={false}>
                {collections.map((c) => (
                  <ListItem
                    key={c.collection_id}
                    className="list-row"
                    label={c.name}
                    isSelected={c.collection_id === selectedId}
                    startContent={<Library size={16} />}
                    onClick={() => onSelect(c.collection_id)}
                    endContent={
                      <span className="list-row__end" onClick={(e) => e.stopPropagation()}>
                        <span className="list-row__more">
                          <MoreMenu
                            label={`Actions for ${c.name}`}
                            variant="ghost"
                            size="sm"
                            alignment="end"
                            items={[
                              { label: "Rename…", icon: <Pencil size={15} />, onClick: () => setRenaming(c.collection_id) },
                              { label: "Delete…", icon: <Trash2 size={15} />, onClick: () => setDeleting(c.collection_id) },
                            ]}
                          />
                        </span>
                      </span>
                    }
                  />
                ))}
              </List>
            )}
          </div>
        </div>
      </Section>

      <div className="collections-page__detail">
        {!selected ? (
          // Both messages depend on how many collections exist, so nothing shows before the list arrives.
          collections === null || listFailed ? null : (
            <div className="collections-page__center">
              <EmptyState
                title={collections.length ? "Select a collection" : "Create your first collection"}
                description={
                  collections.length
                    ? "Pick a collection to choose which documents and folders the AI may draw on."
                    : "A collection is a named set of documents you can point the AI at when you ask a question."
                }
                icon={<Library size={28} />}
                actions={
                  collections.length ? undefined : (
                    <Button label="New collection" variant="primary" size="sm" onClick={() => setCreating(true)} />
                  )
                }
              />
            </div>
          )
        ) : (
          // Not a VStack, whose layout swallows the picker's `flex: 1`.
          <div className="collections-page__body">
            <div className="collections-page__head">
              <HStack gap={2} vAlign="center">
                <Heading level={3}>{selected.name}</Heading>
                {items && (
                  <Badge
                    variant="neutral"
                    label={`${items.length} item${items.length === 1 ? "" : "s"}`}
                  />
                )}
              </HStack>
              <Text type="supporting" color="secondary">
                Choose what the AI may draw on when you scope a question to this collection.
              </Text>
            </div>
            {itemsFailed ? (
              // No picker without the membership: saving from an empty seed would remove real items.
              <div className="collections-page__center">
                <LoadFailed
                  title="Couldn’t load what’s in this collection"
                  description="Nothing has changed — retry to see and edit its documents."
                  icon={<Library size={28} />}
                  onRetry={() => reloadItems(selected.collection_id)}
                />
              </div>
            ) : items === null ? (
              <div className="collections-page__center">
                <Spinner label="Loading" />
              </div>
            ) : (
              <CollectionEditor
                key={selected.collection_id}
                isInline
                collectionId={selected.collection_id}
                collectionName={selected.name}
                initialItems={items}
                onClose={() => reloadItems(selected.collection_id)}
                onApplied={() => {
                  reloadItems(selected.collection_id);
                  reloadList();
                }}
              />
            )}
          </div>
        )}
      </div>

      <PromptDialog
        isOpen={creating}
        title="New collection"
        label="Collection name"
        onSubmit={createCollection}
        onClose={() => setCreating(false)}
      />
      <PromptDialog
        isOpen={renaming !== null}
        title="Rename collection"
        label="Collection name"
        initialValue={renamingName}
        submitLabel="Rename"
        onSubmit={doRename}
        onClose={() => setRenaming(null)}
      />
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deletingName || "collection"}”?`}
        description="The documents themselves are not deleted — only this scope."
        actionLabel="Delete"
        actionVariant="destructive"
        onAction={doDelete}
      />
    </div>
  );
}
