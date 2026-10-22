/**
 * The languages keyword search stems words in, and the background pass that
 * writes the keyword index again for them: when an administrator changes them,
 * and at boot when rows were written in another format (a newer spelling of the
 * text, or another Node's ICU). Queries and writes use the newest languages at
 * once; a row not yet written again still matches each word by its English stem,
 * so search keeps answering. One pass runs at a time, a request for other
 * languages stops it, and a restart in the middle is finished by the next boot's.
 */
import { setTimeout as delay } from "node:timers/promises";
import { listDocsToReindex, reindexDocVectors, saveSearchLanguages, type SearchLanguage, type Sql } from "@stuga/db";

export interface SearchLanguagesStatus {
  /** The languages chosen last. */
  languages: SearchLanguage[];
  /** Whether the index is still being written for them. */
  rebuilding: boolean;
  /** Why the last pass gave up, until the next one starts; meanwhile rows it did not reach match by their English stems. */
  error: string | null;
}

export interface SearchLanguages {
  /** The languages queries and writes stem words in: the newest chosen. */
  current(): readonly SearchLanguage[];
  status(): SearchLanguagesStatus;
  /**
   * Write every row not yet in `languages`' format again, in the background. A
   * request for other languages stops the pass under way. Settles when the index
   * matches the newest request, or the pass gave up; never rejects.
   */
  rebuild(languages: readonly SearchLanguage[]): Promise<void>;
  /**
   * Save `languages` as the node's setting, then rebuild for them. Saves take
   * turns, so the rebuild goes to the one that committed last. Settles once
   * saved, while the rebuild goes on; rejects when the save fails.
   */
  save(languages: readonly SearchLanguage[], updatedBy: string | null): Promise<void>;
  /** Stop a pass in progress, for shutdown; the next boot finishes it. */
  stop(): Promise<void>;
}

/** Documents one query of the pass lists, each then written in a transaction of its own. */
const PAGE = 100;

/**
 * Between the tries of a pass that could not write every document: one can
 * wait out a lock or a statement timeout. Once they are spent, the pass waits
 * for the next change or start.
 */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];

const sameSet = (a: readonly SearchLanguage[], b: readonly SearchLanguage[]) =>
  a.length === b.length && a.every((l) => b.includes(l));

const named = (languages: readonly SearchLanguage[]) => (languages.length ? `English, ${languages.join(", ")}` : "English");

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createSearchLanguages(deps: {
  sql: Sql;
  /** The languages the node's settings hold. */
  languages: readonly SearchLanguage[];
  retryDelaysMs?: readonly number[];
  /** Resolves after `ms`; rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Writes one document's index again; tests replace it to fail one. */
  reindex?: (sql: Sql, docId: string, languages: readonly SearchLanguage[]) => Promise<void>;
}): SearchLanguages {
  const { sql } = deps;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const reindex = deps.reindex ?? reindexDocVectors;
  const stopping = new AbortController();

  /** The newest request, which queries and writes use. */
  let wanted: readonly SearchLanguage[] = [...deps.languages];
  /** Set before a drain starts and cleared by it, even when it has nothing to do and ends at once. */
  let draining = false;
  let running: Promise<void> = Promise.resolve();
  /** The pass under way, which a request for other languages stops. */
  let attempting: { to: readonly SearchLanguage[]; replaced: AbortController } | null = null;
  let error: string | null = null;
  /** The save under way, which the next one waits for. */
  let saving: Promise<unknown> = Promise.resolve();

  /**
   * Write every document not in `to`'s format again, a page at a time in
   * doc_id order, and sweep again until a sweep writes nothing: a write that
   * read the languages before they changed may land behind the sweep. One that
   * fails is passed over, so the rest are written, and the pass then throws.
   * Returns how many were written.
   */
  async function pass(to: readonly SearchLanguage[], signal: AbortSignal): Promise<number> {
    let written = 0;
    for (;;) {
      const failed: string[] = [];
      let swept = 0;
      let after: string | null = null;
      for (;;) {
        signal.throwIfAborted();
        const page: string[] = await listDocsToReindex(sql, to, PAGE, after);
        if (page.length === 0) break;
        for (const docId of page) {
          signal.throwIfAborted();
          try {
            await reindex(sql, docId, to);
            swept++;
          } catch (err) {
            failed.push(`${docId}: ${messageOf(err)}`);
          }
        }
        after = page[page.length - 1]!;
      }
      written += swept;
      if (failed.length > 0) {
        throw new Error(`${failed.length} document${failed.length === 1 ? "" : "s"} could not be indexed, first ${failed[0]}`);
      }
      if (swept === 0) return written;
    }
  }

  /**
   * Run the pass for `to`, trying again after each delay. "gave up" once the
   * delays are spent; "stopped" when the node stops, or a request for other
   * languages replaced it.
   */
  async function attempt(to: readonly SearchLanguage[]): Promise<"done" | "gave up" | "stopped"> {
    const replaced = new AbortController();
    const signal = AbortSignal.any([stopping.signal, replaced.signal]);
    attempting = { to, replaced };
    error = null;
    const started = Date.now();
    try {
      for (let tries = 0; ; tries++) {
        try {
          const written = await pass(to, signal);
          if (written > 0) {
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            console.info(`[search] keyword index written for ${named(to)}: ${written} documents in ${seconds}s`);
          }
          return "done";
        } catch (err) {
          if (signal.aborted) return "stopped";
          const wait = retryDelays[tries];
          if (wait === undefined) {
            error = messageOf(err);
            console.error(
              `[search] gave up writing the keyword index for ${named(to)} after ${tries + 1} tries: ${error}. ` +
                `The documents it did not reach match by their English stems until the languages are saved again or the node restarts.`,
            );
            return "gave up";
          }
          console.warn(`[search] writing the keyword index for ${named(to)} failed, trying again in ${wait / 1000}s: ${messageOf(err)}`);
          try {
            await sleep(wait, signal);
          } catch {
            return "stopped";
          }
        }
      }
    } finally {
      attempting = null;
    }
  }

  async function drain(): Promise<void> {
    try {
      while (!stopping.signal.aborted) {
        const to = wanted;
        const outcome = await attempt(to);
        // Done, or given up with nothing newer asked for: the next request or start tries again.
        if (outcome !== "stopped" && sameSet(wanted, to)) return;
      }
    } finally {
      // In the same turn as the last check, so a request made after it starts a new drain.
      draining = false;
    }
  }

  function rebuild(languages: readonly SearchLanguage[]): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    wanted = [...languages];
    // What it writes is of no use to these: stop it, and the drain goes on to them.
    if (attempting && !sameSet(attempting.to, wanted)) attempting.replaced.abort();
    if (!draining) {
      draining = true;
      running = drain();
    }
    return running;
  }

  return {
    current: () => wanted,
    status: () => ({ languages: [...wanted], rebuilding: draining, error }),
    rebuild,
    save(languages, updatedBy) {
      // The rebuild is asked for before the next save is sent, so two saves at once rebuild in the order they committed.
      const saved = saving.then(async () => {
        await saveSearchLanguages(sql, languages, updatedBy);
        void rebuild(languages);
      });
      saving = saved.catch(() => {});
      return saved;
    },
    async stop() {
      stopping.abort();
      await running;
    },
  };
}
