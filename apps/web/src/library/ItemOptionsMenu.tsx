/**
 * The ⋯ menu beside Share on an open document or database: what changes the
 * item for everyone or where it lives. Rename, move and trash are refused for a
 * viewer and on a locked item, so they are disabled on the page's read-only flag;
 * the state toggles are disabled for anyone but the owner or an admin; Copy link
 * and the instructions for agents stay live. A move that lets more people in asks first.
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { FittedMoreMenu } from "../ui/FittedMoreMenu";
import { useToast } from "../ui/use-toast";
import { FolderInput, Link as LinkIcon, Pencil, Trash2 } from "lucide-react";
import { Docs, type DocSummary } from "../api";
import { nodeLink } from "../lib/session/auth-config";
import { useDocStateMenu } from "./doc-state";
import { useInstructionsDialog } from "./use-instructions-dialog";
import { useMoveCheck } from "./use-move-check";
import { FolderPicker } from "../ui/FolderPicker";
import { showUndoToast } from "./undo-toast";
import { t } from "../i18n/i18n";

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
  const moveCheck = useMoveCheck();
  const [showMove, setShowMove] = useState(false);
  const noun = doc?.doc_type === "database" ? "database" : "document";
  const nounTitle = noun === "database" ? t("common.database") : t("common.document");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(nodeLink(location.pathname + location.search + location.hash));
      toast({ body: t("library.options.linkCopied"), type: "info" });
    } catch {
      toast({ body: t("library.options.copyFailed"), type: "error" });
    }
  }

  async function moveTo(parentId: string | null, place: string) {
    setShowMove(false);
    if (!doc) return;
    if (!(await moveCheck.confirmMove([{ kind: "doc", id: doc.doc_id }], parentId))) return;
    const from = doc.parent_id;
    try {
      await Docs.move(doc.doc_id, parentId);
      onStateChanged({ ...doc, parent_id: parentId });
      showUndoToast(toast, t("library.move.movedTo", { count: 1, place }), async () => {
        await Docs.move(doc.doc_id, from);
        onStateChanged({ ...doc, parent_id: from });
        return t("library.move.movedBack", { count: 1 });
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast({
        body: status === 403 ? t("library.options.moveDenied", { noun }) : t("library.options.moveFailed", { noun }),
        type: "error",
      });
    }
  }

  // Trash can be undone, from the toast or the Trash, so there is no confirmation.
  async function moveToTrash() {
    if (!doc) return;
    try {
      // The answer carries the title as it is now; this page's copy may predate a rename.
      const trashed = await Docs.trash(doc.doc_id, true);
      const title = trashed.title || t("common.untitled");
      const back = location.pathname + location.search;
      nav(afterTrash);
      showUndoToast(toast, t("library.options.trashed", { title }), async () => {
        await Docs.trash(doc.doc_id, false);
        nav(back);
        return t("library.trash.restoredNamed", { title });
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      toast({
        body:
          status === 403 ? t("library.options.trashDenied", { noun }) : t("library.options.trashFailed", { noun }),
        type: "error",
      });
    }
  }

  return (
    <>
      <FittedMoreMenu
        label={t("library.options.menuLabel", { noun })}
        isDisabled={!doc}
        items={[
          {
            type: "section",
            title: nounTitle,
            items: [
              { label: t("common.renameEllipsis"), icon: <Pencil size={15} />, isDisabled: readOnly, onClick: onRename },
              { label: t("library.options.copyLink"), icon: <LinkIcon size={15} />, onClick: () => void copyLink() },
              { label: t("library.item.moveToFolder"), icon: <FolderInput size={15} />, isDisabled: readOnly, onClick: () => setShowMove(true) },
              ...extras.map((x) => ({ label: x.label, icon: x.icon, isDisabled: x.isDisabled ?? false, onClick: x.onClick })),
            ],
          },
          {
            type: "section",
            title: t("common.access"),
            items: doc
              ? [...stateMenu.items(doc, onStateChanged), instructions.item({ kind: noun, id: doc.doc_id, title: doc.title })]
              : [],
          },
          { type: "divider" },
          { label: t("library.item.moveToTrash"), icon: <Trash2 size={15} />, variant: "destructive", isDisabled: readOnly, onClick: () => void moveToTrash() },
        ]}
      />
      {showMove && <FolderPicker onPick={(id, place) => void moveTo(id, place)} onClose={() => setShowMove(false)} />}
      {instructions.dialog}
      {moveCheck.dialog}
      {stateMenu.dialog}
    </>
  );
}
