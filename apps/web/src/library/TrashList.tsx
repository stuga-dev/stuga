/**
 * The user's trashed documents as a flat list: a trashed document's folder may
 * be gone too, so there is no hierarchy to browse. Each row shows where it was
 * and how long until it is deleted for good.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { useToast } from "@astryxdesign/core/Toast";
import { Undo2, Trash, Trash2 } from "lucide-react";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { Docs, Folders, type DocSummary, type Folder } from "../api";
import { errorMessage } from "../lib/http/client";
import { LoadFailed } from "../ui/LoadFailed";
import { DocTable, docRow, type LibraryRow, type LibrarySort } from "./DocTable";
import { pageParentLabel, usePageParents } from "../database/model/row-ref";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until the purge, never below 0. A trashed row always carries `trashed_at`. */
function daysLeft(trashedAt: string | null): number {
  const purgeAt = new Date(trashedAt ?? Date.now()).getTime() + TRASH_RETENTION_DAYS * DAY_MS;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / DAY_MS));
}

export function TrashList() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [folders, setFolders] = useState<Map<string, Folder>>(new Map());
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [confirming, setConfirming] = useState<DocSummary | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    setState("loading");
    // Either failure is the error state: the folders are what name each row's location.
    Promise.all([Docs.list(true), Folders.list()])
      .then(([{ docs: d }, { folders: f }]) => {
        setDocs(d);
        setFolders(new Map(f.map((x) => [x.folder_id, x])));
        setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(() => load(), [load]);

  // "Projects / Q3", or "Top level"; the walk stops at an ancestor that no longer exists.
  const pathOf = useCallback(
    (parentId: string | null | undefined): string => {
      if (!parentId) return "Top level";
      const names: string[] = [];
      let cur: string | null | undefined = parentId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const folder = folders.get(cur);
        if (!folder) break;
        names.unshift(folder.title || "Untitled folder");
        cur = folder.parent_id;
      }
      return names.length ? names.join(" / ") : "Top level";
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
    return removeRow(doc, () => Docs.trash(doc.doc_id, false), `Couldn’t restore “${doc.title || "Untitled"}”.`);
  }

  function deleteForever(doc: DocSummary) {
    setConfirming(null);
    return removeRow(doc, () => Docs.remove(doc.doc_id), `Couldn’t delete “${doc.title || "Untitled"}”.`);
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
        const va = sort.key === "title" ? a.title.toLowerCase() : a.updated_at;
        const vb = sort.key === "title" ? b.title.toLowerCase() : b.updated_at;
        return va < vb ? -dir : va > vb ? dir : a.id.localeCompare(b.id);
      });
  }, [docs, pathOf, sort.key, sort.direction, parentsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="explorer-shell">
      {state === "loading" && (
        <div className="explorer-center"><Spinner label="Loading Trash" /></div>
      )}
      {state === "error" && (
        <div className="explorer-center">
          <LoadFailed title="Couldn’t load Trash" icon={<Trash size={28} />} onRetry={load} />
        </div>
      )}
      {state === "ok" && (
        <div className="flat-table">
          <DocTable
            rows={rows}
            columns={["name", "location", "expires", "actions"]}
            sort={sort}
            onSortChange={setSort}
            rowActions={(r) => [
              { label: "Restore", icon: <Undo2 size={15} />, onClick: () => r.doc && restore(r.doc) },
              { label: "Delete forever", icon: <Trash2 size={15} />, onClick: () => r.doc && setConfirming(r.doc) },
            ]}
            emptyState={
              <EmptyState
                title="Trash is empty"
                description={`Documents you move to Trash appear here for ${TRASH_RETENTION_DAYS} days.`}
                icon={<Trash size={26} />}
              />
            }
          />
        </div>
      )}

      <Dialog isOpen={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)} purpose="required" width={420}>
        <Layout
          header={<DialogHeader title="Delete forever?" onOpenChange={(o) => !o && setConfirming(null)} />}
          content={
            <LayoutContent>
              <VStack gap={2}>
                <Text>
                  “{confirming?.title || "Untitled"}” will be permanently deleted. This can’t be undone.
                </Text>
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} justify="end">
                <Button label="Cancel" variant="ghost" onClick={() => setConfirming(null)} />
                <Button label="Delete forever" variant="destructive" onClick={() => confirming && deleteForever(confirming)} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </div>
  );
}
