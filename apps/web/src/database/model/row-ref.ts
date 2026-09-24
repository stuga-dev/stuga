/**
 * A row's identity outside its grid: its title, and the reference a row's page
 * carries back to it. The database page names a row as `?table=<t>&row=<r>`;
 * the page's document as `?row=<database>.<table>.<row>`. Ids never contain a
 * dot, so the dot separates.
 */
import { useEffect, useState } from "react";
import { Docs } from "../../api";
import type { ColumnSpec, RowRecord } from "@stuga/protocol/databases/types";

interface RowRef {
  database_id: string;
  table_id: string;
  row_id: string;
}

export const UNTITLED_ROW = "Untitled row";

/** Where a row's page stands, from the listing's `_doc_id` and `_doc_trashed`. A trashed page is offered back, not opened. */
type PageState = { kind: "none" } | { kind: "live"; doc_id: string } | { kind: "trashed"; doc_id: string };

export function pageStateOf(row: Pick<RowRecord, "_doc_id" | "_doc_trashed"> | null): PageState {
  const id = row?._doc_id;
  if (typeof id !== "string" || id === "") return { kind: "none" };
  return row?._doc_trashed === true ? { kind: "trashed", doc_id: id } : { kind: "live", doc_id: id };
}

/** The row's first non-empty text column by position, else a placeholder; the node titles a new page by the same rule. */
export function rowTitle(columns: ColumnSpec[], row: RowRecord | null): string {
  if (!row) return UNTITLED_ROW;
  for (const col of [...columns].sort((a, b) => a.position - b.position)) {
    if (col.type !== "text") continue;
    const v = row[col.column_id];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return UNTITLED_ROW;
}

export function formatRowRef(ref: RowRef): string {
  return `${ref.database_id}.${ref.table_id}.${ref.row_id}`;
}

/** A `?row=` value as a page carries it, or null for anything malformed. */
export function parseRowRef(raw: string | null | undefined): RowRef | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  return { database_id: parts[0]!, table_id: parts[1]!, row_id: parts[2]! };
}

/** The row a document is the page of, from its `page_of` and `page_row`; null when either is missing or malformed. */
export function pageRefOf(doc: { page_of?: string | null; page_row?: string | null } | null | undefined): RowRef | null {
  if (!doc?.page_of || !doc.page_row) return null;
  const parts = doc.page_row.split(".");
  if (parts.length !== 2 || parts.some((p) => p === "")) return null;
  return { database_id: doc.page_of, table_id: parts[0]!, row_id: parts[1]! };
}

// Database titles for lists that show pages: fetched once per database and
// never cleared, since a stale title is only a label. A database the reader
// cannot open is cached as an empty title, so it is not asked for again.

const parentTitles = new Map<string, string>();
const parentInflight = new Map<string, Promise<void>>();
const parentListeners = new Set<() => void>();

function fetchParentTitle(id: string): Promise<void> {
  const pending = parentInflight.get(id);
  if (pending) return pending;
  const p = Docs.get(id)
    .then((d) => void parentTitles.set(id, d.title))
    .catch(() => void parentTitles.set(id, ""))
    .then(() => {
      parentInflight.delete(id);
      parentListeners.forEach((fn) => fn());
    });
  parentInflight.set(id, p);
  return p;
}

/** The label a page's database is known by in a list: its title, or the generic word. */
export function pageParentLabel(id: string | null | undefined): string {
  const title = id ? parentTitles.get(id) : undefined;
  return title ? title : "Database";
}

/** Fetch the titles `pageParentLabel` needs; the returned counter changes as they arrive, re-rendering the caller. */
export function usePageParents(ids: Array<string | null | undefined>): number {
  const [version, setVersion] = useState(0);
  const key = [...new Set(ids.filter((id): id is string => !!id))].sort().join(",");
  useEffect(() => {
    const fn = () => setVersion((v) => v + 1);
    parentListeners.add(fn);
    for (const id of key ? key.split(",") : []) if (!parentTitles.has(id)) void fetchParentTitle(id);
    return () => void parentListeners.delete(fn);
  }, [key]);
  return version;
}

/** The page's URL, carrying the way back to its row. */
export function pageHref(docId: string, ref: RowRef): string {
  return `/doc/${encodeURIComponent(docId)}?row=${encodeURIComponent(formatRowRef(ref))}`;
}

/** The database page with this row open in the dock. */
export function rowHref(ref: RowRef): string {
  return `/doc/${encodeURIComponent(ref.database_id)}?table=${encodeURIComponent(ref.table_id)}&row=${encodeURIComponent(ref.row_id)}`;
}
