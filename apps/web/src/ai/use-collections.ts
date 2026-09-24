import { useCallback, useEffect, useState } from "react";
import { Collections, type CollectionSummary } from "../api";

/**
 * The workspace's Collections: null until the first answer, and empty when the
 * fetch fails. Fetched again whenever `refreshKey` changes.
 */
export function useCollections(refreshKey = 0): { collections: CollectionSummary[] | null; reload: () => void } {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const reload = useCallback(() => {
    Collections.list()
      .then((r) => setCollections(r.collections))
      .catch(() => setCollections([]));
  }, []);
  useEffect(reload, [reload, refreshKey]);
  return { collections, reload };
}
