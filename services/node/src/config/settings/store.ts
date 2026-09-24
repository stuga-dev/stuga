/**
 * An in-memory snapshot of one settings row, swapped whole when a save lands so
 * a change applies with no restart.
 *
 * `current()` is synchronous and returns a frozen value; callers read it once at
 * the top of an operation and hold it, so one turn or delivery never mixes two
 * configurations when a save lands mid-flight.
 */
export interface SettingsStore<T, S> {
  current(): T;
  /** What the settings page may know about stored credentials: never the values. */
  secrets(): S;
  /** Re-read the row and its secret files and swap the snapshot. */
  refresh(): Promise<void>;
}

export async function createSettingsStore<T, S>(load: () => Promise<{ value: T; secrets: S }>): Promise<SettingsStore<T, S>> {
  let snapshot = await load();
  Object.freeze(snapshot.value);
  return {
    current: () => snapshot.value,
    secrets: () => snapshot.secrets,
    refresh: async () => {
      const next = await load();
      Object.freeze(next.value);
      snapshot = next;
    },
  };
}
