/**
 * The person's waiting co-author hunks that were staged by a turn whose context held only this
 * document. A comment is public, while waiting text shows only in its reviewer's overlay, so a turn
 * may post a question or a thread answer only while every waiting hunk in front of it is one of
 * these. A hunk staged by a turn that could read other documents, or proposed here by another
 * document's turn, never is.
 */
import type { ActorStorage } from "@stuga/runtime";

/** A hunk's id is unique only within its run. */
export function cleanHunkId(runId: string, hunkId: string): string {
  return `${runId}/${hunkId}`;
}

function cleanHunksKey(alias: string): string {
  return `coauthor-clean:${alias}`;
}

/** The clean hunks per person, under `coauthor-clean:<alias>`, as `cleanHunkId`s. */
export class CleanHunks {
  constructor(private readonly storage: ActorStorage) {}

  /** Null when they could not be read, which the caller counts as not clean. */
  async read(alias: string): Promise<Set<string> | null> {
    try {
      return new Set((await this.storage.get<string[]>(cleanHunksKey(alias))) ?? []);
    } catch (e) {
      console.warn("co-author clean hunks not read", { alias, err: String(e) });
      return null;
    }
  }

  /** Never fails the turn: a lost write only holds back comments until those hunks are decided. */
  async write(alias: string, ids: string[]): Promise<void> {
    try {
      if (ids.length === 0) await this.storage.delete(cleanHunksKey(alias));
      else await this.storage.put(cleanHunksKey(alias), ids);
    } catch (e) {
      console.warn("co-author clean hunks not recorded", { alias, err: String(e) });
    }
  }
}
