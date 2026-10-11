/**
 * Taking a document out of Stuga: download it as Markdown, print it (which also saves a PDF),
 * or make a copy beside it. The ⋯ menu on an open document and a library row's actions share
 * these; Print is the open page's only, since it prints what is on screen.
 */
import { useNavigate } from "react-router-dom";
import { useToast } from "../ui/use-toast";
import { Button } from "@astryxdesign/core/Button";
import { CopyPlus, FileDown, Printer } from "lucide-react";
import { Docs, type DocSummary } from "../api";
import { saveBlob } from "../lib/download";
import { errorMessage, type ApiError } from "../lib/http/client";
import { t } from "../i18n/i18n";
import { useWorkspaceRole } from "../state/workspace-role";

/** Characters a file name cannot hold on one of the systems a download may land on, control characters included. */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]+/g;

/** A file name for the document: its title made safe, or Untitled. */
export function markdownFileName(title: string): string {
  const safe = title.replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${safe || t("common.untitled")}.md`;
}

/**
 * The node's refusals of the original's folder as the copy's: one the caller may only read, and one they
 * cannot see (a document shared with them on its own), which the node answers as not found.
 */
const FOLDER_UNUSABLE: ReadonlySet<string> = new Set([
  "view-only access to the parent folder", // i18n-exempt: the node's error code, never shown
  "parent folder not found", // i18n-exempt: the node's error code, never shown
]);

interface FileAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

/** With `openCopy` a copy opens at once, as the open page wants; otherwise its toast offers Open. */
export function useDocFileActions(opts: { openCopy?: boolean; onCopied?: () => void } = {}) {
  const nav = useNavigate();
  const toast = useToast();
  // A guest cannot create documents, so a copy is not theirs to make.
  const canCopy = useWorkspaceRole() !== "guest";

  async function downloadMarkdown(doc: DocSummary) {
    try {
      const { markdown } = await Docs.markdown(doc.doc_id);
      saveBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), markdownFileName(doc.title));
    } catch (e) {
      toast({ body: errorMessage(e, t("library.file.downloadFailed")), type: "error" });
    }
  }

  /** The copy sits in the same folder, named for the original; at the top of the library when that folder is view-only or out of sight. */
  async function makeCopy(doc: DocSummary) {
    const title = t("library.file.copyTitle", { title: doc.title || t("common.untitled") });
    try {
      const named = await Docs.copy(doc.doc_id, title, doc.parent_id).catch((e: unknown) => {
        if (doc.parent_id && FOLDER_UNUSABLE.has((e as ApiError).code ?? "")) return Docs.copy(doc.doc_id, title, null);
        throw e;
      });
      toast({
        body: t("library.file.copied", { title }),
        type: "info",
        endContent: opts.openCopy ? undefined : <Button label={t("common.open")} variant="ghost" size="sm" onClick={() => nav(`/doc/${named.doc_id}`)} />,
      });
      opts.onCopied?.();
      if (opts.openCopy) nav(`/doc/${named.doc_id}`);
    } catch (e) {
      toast({ body: errorMessage(e, t("library.file.copyFailed")), type: "error" });
    }
  }

  /** The actions for a prose document; none for a database. `print` adds Print, for the open page. */
  function items(doc: DocSummary | null, { print = false }: { print?: boolean } = {}): FileAction[] {
    if (!doc || doc.doc_type === "database") return [];
    return [
      { label: t("library.file.downloadMarkdown"), icon: <FileDown size={15} />, onClick: () => void downloadMarkdown(doc) },
      ...(print ? [{ label: t("library.file.print"), icon: <Printer size={15} />, onClick: () => window.print() }] : []),
      ...(canCopy ? [{ label: t("library.file.makeCopy"), icon: <CopyPlus size={15} />, onClick: () => void makeCopy(doc) }] : []),
    ];
  }

  return { items };
}
