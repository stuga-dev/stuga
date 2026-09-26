/**
 * The languages keyword search answers for, and the online rebuild of its BM25
 * indexes when an administrator changes them.
 *
 * pg_search reads only the newest valid bm25 index on a table, and a query that
 * names a field that index lacks fails. So a change goes in four steps: queries
 * name only the languages the old and the new set share; a table's new index is
 * built concurrently, while writes go on and queries keep reading the old one;
 * the table's old indexes are dropped, concurrently, so the new one is all that
 * is left whatever its OID; and once every table is done, queries name the new
 * set. One rebuild runs at a time, and a request for other languages stops it.
 * A restart in the middle is finished by the boot reconcile, which drops what is
 * not wanted and rebuilds what a stopped build left invalid.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  createSearchIndex,
  dropSearchIndex,
  getSearchLanguages,
  indexedSearchLanguages,
  isPlainIndexName,
  listSearchIndexes,
  saveSearchLanguages,
  searchIndexShapes,
  type SearchLanguage,
  type Sql,
} from "@stuga/db";
import { legacySearchLanguages, type Env } from "../config/env.js";

export interface SearchLanguagesStatus {
  /** The languages chosen last. */
  languages: SearchLanguage[];
  /** Whether the indexes are still being rebuilt for them. */
  rebuilding: boolean;
  /** Why the last rebuild gave up, until the next one starts; meanwhile search uses the languages both sets share. */
  error: string | null;
}

export interface SearchLanguages {
  /** The languages a query may name now; during a rebuild, only those the old and the new indexes share. */
  current(): readonly SearchLanguage[];
  status(): SearchLanguagesStatus;
  /**
   * Rebuild the indexes for `languages`, online. A request for other languages
   * stops the rebuild under way, whose half-built index the next one drops.
   * Settles when the indexes match the newest request, or the rebuild gave up;
   * never rejects.
   */
  rebuild(languages: readonly SearchLanguage[]): Promise<void>;
  /**
   * Save `languages` as the node's setting, then rebuild for them. Saves take
   * turns, so the rebuild goes to the one that committed last. Settles once
   * saved, while the rebuild goes on; rejects when the save fails.
   */
  save(languages: readonly SearchLanguage[], updatedBy: string | null): Promise<void>;
  /** Cancel a rebuild in progress, for shutdown; the next boot finishes it. */
  stop(): Promise<void>;
}

/**
 * Between the tries of a failed rebuild: a build can fail under concurrent
 * writes, or wait out a statement timeout. Once they are spent, the rebuild
 * waits for the next change or start.
 */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];

const sameSet = (a: readonly SearchLanguage[], b: readonly SearchLanguage[]) =>
  a.length === b.length && a.every((l) => b.includes(l));

const named = (languages: readonly SearchLanguage[]) => (languages.length ? languages.join(", ") : "no extra languages");

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createSearchLanguages(deps: {
  sql: Sql;
  /** What the boot reconciled the indexes to. */
  languages: readonly SearchLanguage[];
  retryDelaysMs?: readonly number[];
  /** Resolves after `ms`; rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): SearchLanguages {
  const { sql } = deps;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const stopping = new AbortController();

  /** What queries may name. */
  let queryable: readonly SearchLanguage[] = [...deps.languages];
  /** What the indexes are built for, or null while a rebuild is unfinished. */
  let built: readonly SearchLanguage[] | null = [...deps.languages];
  /** The newest request. */
  let wanted: readonly SearchLanguage[] = [...deps.languages];
  /** Set before a drain starts and cleared by it, even when it has nothing to do and ends at once. */
  let draining = false;
  let running: Promise<void> = Promise.resolve();
  /** The attempt under way, which a request for other languages stops. */
  let attempting: { to: readonly SearchLanguage[]; replaced: AbortController } | null = null;
  let error: string | null = null;
  /** The save under way, which the next one waits for. */
  let saving: Promise<unknown> = Promise.resolve();

  /**
   * One pass of the four steps, a table at a time: a table's old indexes go as
   * soon as its new one is valid, so it keeps two, each updated on every write,
   * no longer than it must. Returns the indexes built (`+name`) and dropped
   * (`-name`).
   */
  async function swap(to: readonly SearchLanguage[], signal: AbortSignal): Promise<string[]> {
    queryable = queryable.filter((l) => to.includes(l));
    built = null;
    const present = await listSearchIndexes(sql);
    const changes: string[] = [];
    for (const index of searchIndexShapes(to)) {
      const have = present.find((p) => p.name === index.name);
      if (!have?.valid) {
        // A build that failed or was stopped leaves an invalid index under the name it would have had.
        if (have) await dropSearchIndex(sql, index.name, { concurrently: true, signal });
        await createSearchIndex(sql, index, { concurrently: true, signal });
        changes.push(`+${index.name}`);
      }
      for (const { name, table } of present) {
        if (table !== index.table || name === index.name || !isPlainIndexName(name)) continue;
        await dropSearchIndex(sql, name, { concurrently: true, signal });
        changes.push(`-${name}`);
      }
    }
    queryable = to;
    built = to;
    return changes;
  }

  /**
   * Swap to `to`, trying again after each delay. "gave up" once the delays are
   * spent; "stopped" when the node stops, or a request for other languages
   * replaced it.
   */
  async function attempt(to: readonly SearchLanguage[]): Promise<"done" | "gave up" | "stopped"> {
    const replaced = new AbortController();
    const signal = AbortSignal.any([stopping.signal, replaced.signal]);
    attempting = { to, replaced };
    error = null;
    const started = Date.now();
    const meanwhile = queryable.filter((l) => to.includes(l));
    console.info(`[search] rebuilding the keyword indexes for ${named(to)}; meanwhile search uses ${named(meanwhile)}`);
    try {
      for (let tries = 0; ; tries++) {
        try {
          const changes = await swap(to, signal);
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          console.info(`[search] keyword indexes ready for ${named(to)} after ${seconds}s: ${changes.join(", ") || "nothing to change"}`);
          return "done";
        } catch (err) {
          if (signal.aborted) return "stopped";
          const wait = retryDelays[tries];
          if (wait === undefined) {
            error = messageOf(err);
            console.error(
              `[search] gave up rebuilding the keyword indexes for ${named(to)} after ${tries + 1} tries: ${error}. ` +
                `Search uses ${named(queryable)} until the languages are saved again or the node restarts, which finishes the rebuild.`,
            );
            return "gave up";
          }
          console.warn(`[search] rebuilding the keyword indexes for ${named(to)} failed, trying again in ${wait / 1000}s: ${messageOf(err)}`);
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
        if (built && sameSet(built, to)) return;
        // Given up with nothing newer asked for: the next request or start tries again.
        if ((await attempt(to)) === "gave up" && sameSet(wanted, to)) return;
      }
    } finally {
      // In the same turn as the last check, so a request made after it starts a new drain.
      draining = false;
    }
  }

  function rebuild(languages: readonly SearchLanguage[]): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    wanted = [...languages];
    // What it builds is of no use to these: stop it, and the drain goes on to them.
    if (attempting && !sameSet(attempting.to, wanted)) attempting.replaced.abort();
    if (!draining) {
      draining = true;
      running = drain();
    }
    return running;
  }

  return {
    current: () => queryable,
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

/**
 * The languages the boot reconciles the indexes to: the node's setting. A node
 * that has never chosen takes one: SEARCH_LANGUAGES from its environment, or
 * else the languages its search indexes are built for, which on a database from
 * before the setting are the only record of them. From then on the variable is
 * ignored. Indexes built for no extra language record nothing, so such a node
 * reads the variable again at its next start.
 */
export async function bootSearchLanguages(sql: Sql, env: Env): Promise<SearchLanguage[]> {
  const stored = await getSearchLanguages(sql);
  if (stored !== null) {
    if (env.SEARCH_LANGUAGES?.trim()) {
      console.warn("[node] SEARCH_LANGUAGES is ignored: the search languages are set in Settings → This node → Search");
    }
    return stored;
  }
  const legacy = legacySearchLanguages(env);
  if (legacy !== null) {
    await saveSearchLanguages(sql, legacy, null);
    console.info(
      `[node] SEARCH_LANGUAGES=${legacy.join(",")} is now the node's search languages setting; ` +
        "the variable is ignored from here on, and the setting is in Settings → This node → Search",
    );
    return legacy;
  }
  // None is left unrecorded, as it is on a new node, whose setup then offers the browser's languages.
  const indexed = await indexedSearchLanguages(sql);
  if (!indexed?.length) return [];
  await saveSearchLanguages(sql, indexed, null);
  console.info(
    `[node] the search indexes are built for ${indexed.join(",")}, which is now the node's search languages setting, ` +
      "in Settings → This node → Search",
  );
  return indexed;
}
