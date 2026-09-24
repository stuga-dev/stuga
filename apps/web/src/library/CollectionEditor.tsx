/**
 * A collection's membership as a searchable checkbox tree. Checking a document
 * adds it; checking a folder adds the whole folder, including documents added to
 * it later, and locks everything under it as included. A folder with only some
 * descendants picked shows indeterminate. Save sends one add and one remove.
 */
import { useEffect, useMemo, useState } from "react";
import { LIBRARY_LIST_CAP } from "@stuga/protocol/domain/limits";
import { Collections, Docs, Folders, type CollectionItem, type DocSummary, type Folder } from "../api";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { ChevronRight, ChevronDown, Folder as FolderIcon, FileText, Search } from "lucide-react";

type Kind = "doc" | "folder";
const keyOf = (kind: Kind, id: string) => `${kind}:${id}`;

interface FolderNode {
  kind: "folder";
  id: string;
  title: string;
  folders: FolderNode[];
  docs: DocNode[];
}
interface DocNode {
  kind: "doc";
  id: string;
  title: string;
}

export function CollectionEditor({
  collectionId,
  collectionName,
  initialItems,
  onClose,
  onApplied,
  isInline = false,
}: {
  collectionId: string;
  collectionName: string;
  initialItems: CollectionItem[];
  onClose: () => void;
  onApplied: () => void;
  /** Page content with a save bar that stays put after saving, instead of a dialog. */
  isInline?: boolean;
}) {
  const [roots, setRoots] = useState<{ folders: FolderNode[]; docs: DocNode[] } | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  // The document listing is capped, so older documents may be missing from the tree.
  const [truncated, setTruncated] = useState(false);
  // Keyed "doc:<id>" or "folder:<id>"; Save diffs `selected` against `original`.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [applying, setApplying] = useState(false);
  const [saveErr, setSaveErr] = useState(false);

  useEffect(() => {
    const s = new Set<string>();
    for (const it of initialItems) s.add(keyOf(it.folder_id ? "folder" : "doc", (it.folder_id ?? it.doc_id)!));
    setSelected(new Set(s));
    setOriginal(new Set(s));
  }, [initialItems]);

  // Two calls fetch every folder and document; rows carry parent_id, so the tree is built here.
  useEffect(() => {
    let live = true;
    Promise.all([
      Folders.list(undefined).then((r) => r.folders).catch(() => null),
      Docs.list(false, undefined).then((r) => r.docs).catch(() => null),
    ]).then(([folders, docs]) => {
      if (!live) return;
      if (!folders || !docs) { setLoadErr(true); return; }
      setTruncated(docs.length >= LIBRARY_LIST_CAP);
      setRoots(buildTree(folders, docs));
    });
    return () => { live = false; };
  }, []);

  const toggle = (kind: Kind, id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(kind, id);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const setExpand = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id); else next.delete(id);
      return next;
    });

  const addKeys = [...selected].filter((k) => !original.has(k));
  const removeKeys = [...original].filter((k) => !selected.has(k));
  const dirty = addKeys.length > 0 || removeKeys.length > 0;

  const wholeFolders = [...selected].filter((k) => k.startsWith("folder:")).length;
  const individualDocs = [...selected].filter((k) => k.startsWith("doc:")).length;

  async function apply() {
    if (!dirty) { if (!isInline) onClose(); return; }
    setApplying(true);
    setSaveErr(false);
    try {
      const split = (keys: string[]) => {
        const docIds: string[] = [], folderIds: string[] = [];
        for (const k of keys) {
          const [kind, ...rest] = k.split(":");
          (kind === "folder" ? folderIds : docIds).push(rest.join(":"));
        }
        return { docIds, folderIds };
      };
      if (removeKeys.length) await Collections.removeItems(collectionId, split(removeKeys));
      if (addKeys.length) await Collections.addItems(collectionId, split(addKeys));
      onApplied();
      // Inline, onApplied's refetch re-seeds `original`, which settles the button to "Saved".
      if (!isInline) onClose();
    } catch {
      // The ticks stay dirty, and re-sending is safe: add and remove both skip what is already so.
      setSaveErr(true);
    } finally {
      setApplying(false);
    }
  }

  const q = filter.trim().toLowerCase();

  const body = (
            <div className={isInline ? "collection-tree" : "collection-tree collection-tree--dialog"}>
              <Banner
                status="info"
                container="section"
                title="Select documents or whole folders. Whole folders include future items."
              />
              {saveErr && (
                <Banner
                  status="error"
                  container="section"
                  title="Nothing was saved"
                  description="Your ticks are still here. Press Save to try again."
                />
              )}
              {truncated && (
                <Banner
                  status="warning"
                  container="section"
                  title={`Showing your ${LIBRARY_LIST_CAP} most-recently-updated documents`}
                  description="Some older documents aren’t listed. Select their whole folder instead."
                />
              )}
              <div className="collection-tree__search">
                <TextInput
                  label="Filter documents and folders"
                  isLabelHidden
                  value={filter}
                  onChange={setFilter}
                  placeholder="Filter documents and folders…"
                  startIcon={<Search size={16} />}
                  hasClear
                />
              </div>

              <div className="collection-tree__tree" role="tree" aria-label="Documents and folders">
                {!roots && !loadErr && <div className="collection-tree__center"><Spinner label="Loading" /></div>}
                {loadErr && <div className="collection-tree__center"><EmptyState isCompact title="Couldn’t load" description="Please try again." /></div>}
                {roots && (roots.folders.length === 0 && roots.docs.length === 0) && (
                  <div className="collection-tree__center"><EmptyState isCompact title="Nothing here yet" description="Create documents or folders first." icon={<FileText size={22} />} /></div>
                )}
                {roots && (roots.folders.length > 0 || roots.docs.length > 0) && (
                  <TreeLevel
                    folders={roots.folders}
                    docs={roots.docs}
                    depth={0}
                    ancestorWhole={false}
                    selected={selected}
                    expanded={expanded}
                    filter={q}
                    onToggle={toggle}
                    onExpand={setExpand}
                  />
                )}
              </div>

              <div className="collection-tree__summary">
                <Text type="supporting" color="secondary">
                  {selected.size === 0
                    ? "Nothing selected"
                    : `${individualDocs + wholeFolders} selected` +
                      (wholeFolders ? ` · ${wholeFolders} whole folder${wholeFolders > 1 ? "s" : ""}` : "")}
                </Text>
              </div>
            </div>
  );

  const saveLabel = dirty ? `Save (+${addKeys.length} / −${removeKeys.length})` : "Saved";

  if (isInline) {
    return (
      <div className="collection-tree-inline">
        {body}
        <div className="collection-tree-inline__actions">
          <HStack gap={2} justify="end" vAlign="center">
            {dirty && (
              <Button label="Discard changes" variant="ghost" onClick={onClose} />
            )}
            <Button
              label={saveLabel}
              variant="primary"
              isDisabled={!dirty}
              isLoading={applying}
              onClick={apply}
            />
          </HStack>
        </div>
      </div>
    );
  }

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title={`Edit “${collectionName}”`} onOpenChange={(o) => !o && onClose()} />}
        content={<LayoutContent padding={0}>{body}</LayoutContent>}
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
              <Button
                label={dirty ? `Save (+${addKeys.length} / −${removeKeys.length})` : "Done"}
                variant="primary"
                isLoading={applying}
                onClick={apply}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** Recursively render one level of folders (then docs) at `depth`. */
function TreeLevel({
  folders,
  docs,
  depth,
  ancestorWhole,
  selected,
  expanded,
  filter,
  onToggle,
  onExpand,
}: {
  folders: FolderNode[];
  docs: DocNode[];
  depth: number;
  /** An enclosing folder is checked whole, so this level is included and locked. */
  ancestorWhole: boolean;
  selected: Set<string>;
  expanded: Set<string>;
  filter: string;
  onToggle: (kind: Kind, id: string) => void;
  onExpand: (id: string, open: boolean) => void;
}) {
  return (
    <>
      {folders.map((f) => (
        <FolderRow
          key={f.id}
          node={f}
          depth={depth}
          ancestorWhole={ancestorWhole}
          selected={selected}
          expanded={expanded}
          filter={filter}
          onToggle={onToggle}
          onExpand={onExpand}
        />
      ))}
      {docs
        .filter((d) => matches(d, filter))
        .map((d) => {
          const included = ancestorWhole;
          const checked = included || selected.has(keyOf("doc", d.id));
          return (
            <div
              key={d.id}
              className={`collection-tree-row${included ? " collection-tree-row--locked" : ""}`}
              style={{ paddingLeft: indent(depth) }}
              role="treeitem"
              aria-selected={checked}
            >
              <span className="collection-tree-row__caret" />
              <CheckboxInput
                value={checked}
                isDisabled={included}
                isLabelHidden
                onChange={() => onToggle("doc", d.id)}
                label={d.title || "Untitled"}
              />
              <FileText size={15} className="collection-tree-row__ico" />
              <span className="collection-tree-row__label">{d.title || "Untitled"}</span>
              {included && <span className="collection-tree-row__hint">included</span>}
            </div>
          );
        })}
    </>
  );
}

function FolderRow({
  node,
  depth,
  ancestorWhole,
  selected,
  expanded,
  filter,
  onToggle,
  onExpand,
}: {
  node: FolderNode;
  depth: number;
  ancestorWhole: boolean;
  selected: Set<string>;
  expanded: Set<string>;
  filter: string;
  onToggle: (kind: Kind, id: string) => void;
  onExpand: (id: string, open: boolean) => void;
}) {
  const isWhole = selected.has(keyOf("folder", node.id));
  const whole = ancestorWhole || isWhole;
  const selfMatch = matches(node, filter);
  const descMatch = useMemo(() => subtreeMatches(node, filter), [node, filter]);
  if (filter && !selfMatch && !descMatch) return null;

  const indeterminate = !whole && anyDescendantSelected(node, selected);
  const open = expanded.has(node.id) || (!!filter && descMatch);

  return (
    <>
      <div
        className={`collection-tree-row collection-tree-row--folder${whole && !isWhole ? " collection-tree-row--locked" : ""}`}
        style={{ paddingLeft: indent(depth) }}
        role="treeitem"
        aria-expanded={open}
        aria-selected={whole}
      >
        <button
          className="collection-tree-row__caret collection-tree-row__caret--btn"
          onClick={() => onExpand(node.id, !open)}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <CheckboxInput
          value={whole ? true : indeterminate ? "indeterminate" : false}
          isDisabled={ancestorWhole}
          isLabelHidden
          onChange={() => onToggle("folder", node.id)}
          label={`${node.title || "Untitled folder"} (whole folder)`}
        />
        <FolderIcon size={15} className="collection-tree-row__ico collection-tree-row__ico--folder" />
        <span className="collection-tree-row__label">{node.title || "Untitled folder"}</span>
        {isWhole && <span className="collection-tree-row__tag">whole folder</span>}
        {ancestorWhole && <span className="collection-tree-row__hint">included</span>}
      </div>
      {open && (
        <TreeLevel
          folders={node.folders}
          docs={node.docs}
          depth={depth + 1}
          ancestorWhole={whole}
          selected={selected}
          expanded={expanded}
          filter={filter}
          onToggle={onToggle}
          onExpand={onExpand}
        />
      )}
    </>
  );
}

const indent = (depth: number) => `${depth * 1.1 + 0.25}rem`;

function matches(n: { title: string }, filter: string): boolean {
  if (!filter) return true;
  return (n.title || "Untitled").toLowerCase().includes(filter);
}

function subtreeMatches(f: FolderNode, filter: string): boolean {
  if (!filter) return true;
  if (matches(f, filter)) return true;
  return f.docs.some((d) => matches(d, filter)) || f.folders.some((c) => subtreeMatches(c, filter));
}

function anyDescendantSelected(f: FolderNode, selected: Set<string>): boolean {
  for (const d of f.docs) if (selected.has(keyOf("doc", d.id))) return true;
  for (const c of f.folders) {
    if (selected.has(keyOf("folder", c.id))) return true;
    if (anyDescendantSelected(c, selected)) return true;
  }
  return false;
}

function buildTree(folders: Folder[], docs: DocSummary[]): { folders: FolderNode[]; docs: DocNode[] } {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f.folder_id, { kind: "folder", id: f.folder_id, title: f.title, folders: [], docs: [] });
  const rootFolders: FolderNode[] = [];
  for (const f of folders) {
    const node = byId.get(f.folder_id)!;
    const parent = f.parent_id ? byId.get(f.parent_id) : null;
    (parent ? parent.folders : rootFolders).push(node);
  }
  const rootDocs: DocNode[] = [];
  for (const d of docs) {
    const node: DocNode = { kind: "doc", id: d.doc_id, title: d.title };
    const parent = d.parent_id ? byId.get(d.parent_id) : null;
    (parent ? parent.docs : rootDocs).push(node);
  }
  const byTitle = (a: { title: string }, b: { title: string }) => (a.title || "").localeCompare(b.title || "");
  const sortRec = (fs: FolderNode[]) => { fs.sort(byTitle); for (const f of fs) { f.docs.sort(byTitle); sortRec(f.folders); } };
  sortRec(rootFolders); rootDocs.sort(byTitle);
  return { folders: rootFolders, docs: rootDocs };
}
