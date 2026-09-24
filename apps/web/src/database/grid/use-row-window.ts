/** The server-side window of rows the grid shows: the first page on every re-window, then offset pages. */
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { DATABASE_ROWS_PAGE_MAX } from "@stuga/protocol/databases/limits";
import type { RowGroup, RowRecord, RowValue } from "@stuga/protocol/databases/types";
import { Databases } from "../../api";
import type { ViewShape } from "../model/view-shape";
import { errorMessage } from "../../lib/http/client";

interface RowWindow {
  rows: RowRecord[];
  total: number;
  groups: RowGroup[] | null;
  groupsTruncated: boolean;
  loading: boolean;
  loadingMore: boolean;
  loadError: boolean;
  /** Changes whenever the window is replaced, so dependent state can reset. */
  windowKey: string;
  refetch: () => void;
  loadMore: () => Promise<void>;
  patchCell: (rowId: string, columnId: string, value: RowValue) => void;
  appendRow: (rowId: string) => void;
  /** Drop rows that sat inside the window after `deleted` of them were removed on the server. */
  removeRows: (ids: ReadonlySet<string>, deleted: number) => void;
}

export function useRowWindow(docId: string, tableId: string, shape: ViewShape, rowsKey: number): RowWindow {
  const toast = useToast();
  const [rows, setRows] = useState<RowRecord[]>([]);
  const [total, setTotal] = useState(0);
  // The next page's offset. Not rows.length: an optimistic append would skip a server row.
  const [fetchedCount, setFetchedCount] = useState(0);
  const [groups, setGroups] = useState<RowGroup[] | null>(null);
  const [groupsTruncated, setGroupsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const query = { sort: shape.sorts, filter: shape.filter, group_by: shape.group_by };
  const queryKey = JSON.stringify(query);
  const windowKey = `${docId}\n${tableId}\n${queryKey}\n${rowsKey}\n${reloadKey}`;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(false);
    Databases.listRows(docId, tableId, { limit: DATABASE_ROWS_PAGE_MAX, offset: 0, ...query })
      .then((r) => {
        if (!live) return;
        setRows(r.rows);
        setTotal(r.total);
        setFetchedCount(r.rows.length);
        setGroups(r.groups ?? null);
        setGroupsTruncated(r.groups_truncated === true);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setLoading(false);
        setLoadError(true);
        toast({ body: errorMessage(e, "Couldn't load rows."), type: "error" });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- windowKey stands for every input
  }, [windowKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await Databases.listRows(docId, tableId, { limit: DATABASE_ROWS_PAGE_MAX, offset: fetchedCount, ...query });
      // An appended row can come back in a later page, and concurrent inserts shift the window.
      setRows((rs) => {
        const seen = new Set(rs.map((row) => row._id));
        return [...rs, ...r.rows.filter((row) => !seen.has(row._id))];
      });
      setTotal(r.total);
      setFetchedCount((c) => c + r.rows.length);
      if (r.groups) setGroups(r.groups);
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't load more rows."), type: "error" });
    } finally {
      setLoadingMore(false);
    }
  };

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  const patchCell = useCallback((rowId: string, columnId: string, value: RowValue) => {
    setRows((rs) => rs.map((r) => (r._id === rowId ? { ...r, [columnId]: value } : r)));
  }, []);

  const appendRow = useCallback((rowId: string) => {
    const now = Date.now();
    setRows((rs) => [...rs, { _id: rowId, _created_at: now, _updated_at: now } as RowRecord]);
    setTotal((t) => t + 1);
  }, []);

  const removeRows = useCallback((ids: ReadonlySet<string>, deleted: number) => {
    setRows((rs) => rs.filter((row) => !ids.has(row._id)));
    setTotal((t) => Math.max(0, t - deleted));
    // The rows beyond the window shifted down by the same count.
    setFetchedCount((c) => Math.max(0, c - deleted));
  }, []);

  return { rows, total, groups, groupsTruncated, loading, loadingMore, loadError, windowKey, refetch, loadMore, patchCell, appendRow, removeRows };
}
