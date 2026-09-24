/**
 * The ⋯ menu beside Share on an open document or database: what changes the
 * item for everyone or where it lives. Rename, move and trash are refused for a
 * viewer and on a locked item, so they are disabled on the page's read-only flag;
 * Copy link, the state toggles and the instructions for agents stay live.
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { useToast } from "@astryxdesign/core/Toast";
import { FolderInput, Link as LinkIcon, Pencil, Trash2 } from "lucide-react";
import { Docs, type DocSummary } from "../api";
import { useDocStateMenu } from "./doc-state";
import { useInstructionsDialog } from "./use-instructions-dialog";
import { FolderPicker } from "../ui/FolderPicker";

/** A page-specific entry in the item section, such as a database's Import. */
interface ItemMenuExtra {
  label: string;
  icon?: ReactNode;
  isDisabled?: boolean;
  onClick: () => void;
}

export function ItemOptionsMenu({
  doc,
  readOnly,
  onRename,
  onStateChanged,
  extras = [],
  afterTrash = "/",
}: {
  /** The item with its live state; null until fetched. */
  doc: DocSummary | null;
  readOnly: boolean;
  onRename: () => void;
  /** Called optimistically and again with the server's answer. */
  onStateChanged: (next: DocSummary) => void;
  extras?: ItemMenuExtra[];
  /** Where to go once the item is in the Trash: the library, or a row's page back to its row. */
  afterTrash?: string;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const stateMenu = useDocStateMenu();
  const instructions = useInstructionsDialog();
  const [showMove, setShowMove] = useState(false);
  const noun = doc?.doc_type === "database" ? "database" : "document";
  const nounTitle = noun === "database" ? "Database" : "Document";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ body: "Link copied. Only people with access can open it.", type: "info" });
    } catch {
      toast({ body: "Couldn’t copy the link.", type: "error" });
    }
  }

  async function moveTo(parentId: string | null) {
    setShowMove(false);
    if (!doc) return;
    try {
      await Docs.move(doc.doc_id, parentId);
      onStateChanged({ ...doc, parent_id: parentId });
      toast({ body: parentId ? "Moved to that folder." : "Moved to the top level.", type: "info" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast({
        body: status === 403 ? `You don’t have permission to move this ${noun}.` : `Couldn’t move this ${noun}. Please try again.`,
        type: "error",
      });
    }
  }

  // Trash can be undone from the library, so there is no confirmation.
  async function moveToTrash() {
    if (!doc) return;
    try {
      await Docs.trash(doc.doc_id, true);
      toast({ body: `Moved “${doc.title || "Untitled"}” to Trash.`, type: "info" });
      nav(afterTrash);
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast({
        body:
          status === 403
            ? `You don’t have permission to move this ${noun} to Trash.`
            : `Couldn’t move this ${noun} to Trash. Please try again.`,
        type: "error",
      });
    }
  }

  return (
    <>
      <MoreMenu
        label={`${nounTitle} options`}
        variant="ghost"
        size="sm"
        alignment="end"
        isDisabled={!doc}
        items={[
          {
            type: "section",
            title: nounTitle,
            items: [
              { label: "Rename…", icon: <Pencil size={15} />, isDisabled: readOnly, onClick: onRename },
              { label: "Copy link", icon: <LinkIcon size={15} />, onClick: () => void copyLink() },
              { label: "Move to folder…", icon: <FolderInput size={15} />, isDisabled: readOnly, onClick: () => setShowMove(true) },
              ...extras.map((x) => ({ label: x.label, icon: x.icon, isDisabled: x.isDisabled ?? false, onClick: x.onClick })),
            ],
          },
          {
            type: "section",
            title: "Access",
            items: doc
              ? [...stateMenu(doc, onStateChanged), instructions.item({ kind: noun, id: doc.doc_id, title: doc.title })]
              : [],
          },
          { type: "divider" },
          { label: "Move to Trash", icon: <Trash2 size={15} />, variant: "destructive", isDisabled: readOnly, onClick: () => void moveToTrash() },
        ]}
      />
      {showMove && <FolderPicker onPick={(id) => void moveTo(id)} onClose={() => setShowMove(false)} />}
      {instructions.dialog}
    </>
  );
}
