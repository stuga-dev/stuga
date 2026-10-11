/**
 * The user's trashed documents as a flat list: a trashed document's folder may
 * be gone too, so there is no hierarchy to browse. Each row shows where it was
 * and how long until it is deleted for good.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { useToast } from "../ui/use-toast";
import { Undo2, Trash, Trash2 } from "lucide-react";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { Docs, Folders, type DocSummary, type Folder } from "../api";
import { errorMessage } from "../lib/http/client";
import { LoadFailed } from "../ui/LoadFailed";
import { DocTable, docRow, type LibraryRow, type LibrarySort } from "./DocTable";
import { pageParentLabel, usePageParents } from "../database/model/row-ref";
import { formatLocale, t } from "../i18n/i18n";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until the purge, never below 0. A trashed row always carries `trashed_at`. */
function daysLeft(trashedAt: string | null): number {
  const purgeAt = new Date(trashedAt ?? Date.now()).getTime() + TRASH_RETENTION_DAYS * DAY_MS;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / DAY_MS));
}

/** `refreshKey` changes when the list should be read again; the rows on screen stay while it is. */
export function TrashList({ refreshKey }: { refreshKey: number }) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [folders, setFolders] = useState<Map<string, Folder>>(new Map());
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [confirming, setConfirming] = useState<DocSummary | null>(null);
  const toast = useToast();

  /** A quiet load keeps what is shown, and keeps it when the read fails. */
  const load = useCallback((quiet = false) => {
    if (!quiet) setState("loading");
    // Either failure is the error state: the folders are what name each row's location.
    Promise.all([Docs.list(true), Folders.list()])
      .then(([{ docs: d }, { folders: f }]) => {
        setDocs(d);
        setFolders(new Map(f.map((x) => [x.folder_id, x])));
        setState("ok");
      })
      .catch(() => {
        if (!quiet) setState("error");
      });
  }, []);

  const loaded = useRef(false);
  useEffect(() => {
    load(loaded.current);
    loaded.current = true;
  }, [load, refreshKey]);

  // "Projects / Q3", or "Top level"; the walk stops at an ancestor that no longer exists.
  const pathOf = useCallback(
    (parentId: string | null | undefined): string => {
      if (!parentId) return t("library.table.topLevel");
      const names: string[] = [];
      let cur: string | null | undefined = parentId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const folder = folders.get(cur);
        if (!folder) break;
        names.unshift(folder.title || t("common.untitledFolder"));
        cur = folder.parent_id;
      }
      return names.length ? names.join(" / ") : t("library.table.topLevel");
    },
    [folders],
  );

  /** The row leaves at once; a refusal says why and reloads, so the row comes back. */
  async function removeRow(doc: DocSummary, request: () => Promise<unknown>, fallback: string) {
    setDocs((cur) => cur?.filter((d) => d.doc_id !== doc.doc_id) ?? cur);
    try {
      await request();
    } catch (e) {
      toast({ body: errorMessage(e, fallback), type: "error" });
      load();
    }
  }

  function restore(doc: DocSummary) {
    const title = doc.title || t("common.untitled");
    return removeRow(
      doc,
      async () => {
        await Docs.trash(doc.doc_id, false);
        toast({ body: t("library.trash.restoredNamed", { title }), type: "info" });
      },
      t("library.trash.restoreFailed", { title }),
    );
  }

  function deleteForever(doc: DocSummary) {
    setConfirming(null);
    return removeRow(doc, () => Docs.remove(doc.doc_id), t("library.explorer.deleteFailed", { title: doc.title || t("common.untitled") }));
  }

  const [sort, setSort] = useState<LibrarySort>({ key: "updated_at", direction: "descending" });
  // A row's page is restored to its database, so the database is its location.
  const parentsVersion = usePageParents((docs ?? []).map((d) => d.page_of));
  const rows = useMemo<LibraryRow[]>(() => {
    const dir = sort.direction === "ascending" ? 1 : -1;
    return (docs ?? [])
      .map(
        (d): LibraryRow => ({
          ...docRow(d),
          location: d.page_of ? pageParentLabel(d.page_of) : pathOf(d.parent_id),
          expiresInDays: daysLeft(d.trashed_at),
        }),
      )
      // The Trash listing is complete, so it can be sorted here.
      .sort((a, b) => {
        const byKey =
          sort.key === "title"
            ? a.title.localeCompare(b.title, formatLocale(), { sensitivity: "base" })
            : a.updated_at < b.updated_at
              ? -1
              : a.updated_at > b.updated_at
                ? 1
                : 0;
        // Ids are no text a person reads, so they tie-break in code-point order.
        return byKey !== 0 ? byKey * dir : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [docs, pathOf, sort.key, sort.direction, parentsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="explorer-shell">
      {state === "loading" && (
        <div className="explorer-center"><Spinner label={t("library.trash.loading")} /></div>
      )}
      {state === "error" && (
        <div className="explorer-center">
          <LoadFailed title={t("library.trash.loadFailed")} icon={<Trash size={28} />} onRetry={() => load()} />
        </div>
      )}
      {state === "ok" && (
        <div className="flat-table">
          <DocTable
            rows={rows}
            columns={["name", "location", "expires", "buttons"]}
            sort={sort}
            onSortChange={setSort}
            // Two actions, so they show on every row rather than behind a menu.
            rowButtons={(r) => [
              { label: t("library.trash.restore"), icon: <Undo2 size={15} />, onClick: () => r.doc && void restore(r.doc) },
              {
                label: t("library.trash.deleteForever"),
                icon: <Trash2 size={15} />,
                variant: "destructive",
                onClick: () => r.doc && setConfirming(r.doc),
              },
            ]}
            emptyState={
              <EmptyState
                title={t("library.trash.empty")}
                description={t("library.trash.emptyBody", { days: TRASH_RETENTION_DAYS })}
                icon={<Trash size={26} />}
              />
            }
          />
        </div>
      )}

      <Dialog isOpen={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)} purpose="required" width={420}>
        <Layout
          header={<DialogHeader title={t("library.trash.confirmTitle")} onOpenChange={(o) => !o && setConfirming(null)} />}
          content={
            <LayoutContent>
              <VStack gap={2}>
                <Text>{t("library.trash.confirmBody", { title: confirming?.title || t("common.untitled") })}</Text>
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} justify="end">
                <Button label={t("common.cancel")} variant="ghost" onClick={() => setConfirming(null)} />
                <Button label={t("library.trash.deleteForever")} variant="destructive" onClick={() => confirming && deleteForever(confirming)} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </div>
  );
}
