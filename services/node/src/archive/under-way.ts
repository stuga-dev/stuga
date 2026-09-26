/**
 * The workspace imports and exports under way on this node. Each can run for minutes and reads
 * or writes the stores a backup closes, so a backup waits while one is (ops/node-backups.ts), and
 * no new one starts while a backup waits: the ones under way end, and the backup starts.
 */
let count = 0;
let held = false;

/** Count an import or export as under way; the returned function ends it, once. */
export function archiveWorkBegins(): () => void {
  count += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    count -= 1;
  };
}

/** Whether a workspace import or export is under way. */
export function archiveWorkUnderWay(): boolean {
  return count > 0;
}

/** Keep new imports and exports from starting while a backup waits (true), or let them start again. */
export function holdArchiveWork(hold: boolean): void {
  held = hold;
}

/** Why a new import or export may not start now; null when it may. */
export function archiveWorkHeld(): string | null {
  return held ? "the node is waiting to back up; try again once it has" : null;
}
