/** The caller's starred documents, shared by every consumer on the screen. */
import { useCallback, useEffect } from "react";
import { Favorites, type DocSummary } from "../api";
import { createStore, useStore } from "../lib/store";

interface Snapshot {
  ids: ReadonlySet<string>;
  /** Hydrated and ACL-filtered; null until the first load lands. */
  docs: DocSummary[] | null;
}

const favorites = createStore<Snapshot>({ ids: new Set(), docs: null });
/** Bumped by every load and optimistic write; only the newest may land. */
let generation = 0;
/** The refreshKey the loaded snapshot answers, so N consumers make one request. */
let loadedFor = -1;

function load(): void {
  const gen = ++generation;
  Favorites.list().then(
    (r) => {
      if (gen === generation) favorites.set({ ids: new Set(r.favorites), docs: r.docs });
    },
    () => {
      // A failed refresh keeps the last snapshot; a failed first load still leaves "loading".
      if (gen === generation && favorites.get().docs === null) favorites.update((s) => ({ ...s, docs: [] }));
    },
  );
}

export function useFavorites(refreshKey = 0) {
  const snapshot = useStore(favorites);

  // A new refreshKey means the library changed under the snapshot.
  useEffect(() => {
    if (loadedFor === refreshKey) return;
    loadedFor = refreshKey;
    load();
  }, [refreshKey]);

  /** Optimistic, rolled back when the server refuses. */
  const toggle = useCallback(async (docId: string): Promise<boolean> => {
    const before = favorites.get();
    const on = before.ids.has(docId);
    const ids = new Set(before.ids);
    if (on) ids.delete(docId);
    else ids.add(docId);
    const docs = before.docs === null ? null : on ? before.docs.filter((d) => d.doc_id !== docId) : before.docs;
    generation++;
    favorites.set({ ids, docs });
    try {
      if (on) await Favorites.remove(docId);
      else await Favorites.add(docId);
      // Only the server can hand back the row a new star belongs in.
      if (!on) load();
      return true;
    } catch {
      generation++;
      favorites.set(before);
      return false;
    }
  }, []);

  return {
    ids: snapshot.ids,
    docs: snapshot.docs,
    /** Counts `docs`, not `ids`: a star whose doc was trashed or unshared stays in `ids` so it can be cleared. */
    count: snapshot.docs?.length ?? 0,
    isLoading: snapshot.docs === null,
    toggle,
    refresh: load,
  };
}
