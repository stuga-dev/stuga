/**
 * Measures the embedding model in force, in the background: never awaited by a save, a boot or the
 * maintenance tick, and one run at a time per configuration, so the search box's strictness levels
 * follow the model without anyone waiting on it. A failed run is tried again later, sooner at first;
 * a model that cannot tell related text from unrelated is not.
 */
import { type AiConfig, CalibrationError, calibrate, calibrationKey, embed } from "@stuga/ai";
import {
  type Sql,
  claimEmbedCalibration,
  failEmbedCalibration,
  finishEmbedCalibration,
  getEmbedCalibration,
  getNodeAiSettings,
  insertAiUsage,
  pruneEmbedCalibrations,
} from "@stuga/db";
import type { AiSettingsStore } from "../config/settings/ai.js";

export interface Calibrator {
  /** Starts measuring the configuration in force when it needs it. Awaits a read and a claim, never the run. */
  ensure(opts?: { alias?: string; force?: boolean }): Promise<void>;
  /** 0–100 while this process measures `key`, else null. */
  progress(key: string): number | null;
  /** Ends a run between batches and waits for it. */
  stop(): Promise<void>;
}

/** After the 1st, 2nd, 3rd and 4th failure in a row, then every 6 hours. */
const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

/** Tokens nobody triggered (a boot, the maintenance tick) are the node's own. */
export const SYSTEM_ALIAS = "system";

interface Log {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export function createCalibrator(deps: {
  sql: Sql;
  aiSettings: Pick<AiSettingsStore, "current" | "refresh">;
  processStartedAt: Date;
  embedFn?: typeof embed;
  now?: () => Date;
  log?: Log;
}): Calibrator {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? { info: (m, x) => console.log(`[calibrate] ${m}`, x ?? ""), warn: (m, x) => console.warn(`[calibrate] ${m}`, x ?? "") };
  const running = new Map<string, { progress: number; done: Promise<void> }>();
  let stopping = false;

  async function run(cfg: AiConfig, key: string, triggeredBy: string): Promise<void> {
    const entry = running.get(key)!;
    const model = cfg.embed.model;
    try {
      const result = await calibrate(cfg, { embedFn: deps.embedFn, shouldStop: () => stopping, onProgress: (p) => (entry.progress = p) });
      await finishEmbedCalibration(deps.sql, key, result);
      await insertAiUsage(deps.sql, { alias: triggeredBy, workspaceId: null, docId: null, kind: "embedding", model, inputTokens: result.tokens }).catch(() => {});
      log.info("measured", { model, balanced: result.levels.short.balanced, ms: result.ms });
    } catch (e) {
      // Tokens spent before a failure were spent all the same.
      if (e instanceof CalibrationError && e.tokens > 0) {
        await insertAiUsage(deps.sql, { alias: triggeredBy, workspaceId: null, docId: null, kind: "embedding", model, inputTokens: e.tokens }).catch(() => {});
      }
      // A run ended by shutdown stays `running`: the next process, started later, takes it over.
      if (e instanceof CalibrationError && e.kind === "stopped") return;
      const inseparable = e instanceof CalibrationError && e.kind === "inseparable";
      const attempts = (await getEmbedCalibration(deps.sql, key).catch(() => null))?.attempts ?? 1;
      const wait = RETRY_AFTER_MS[Math.min(attempts, RETRY_AFTER_MS.length) - 1]!;
      const message = e instanceof Error ? e.message : String(e);
      await failEmbedCalibration(deps.sql, key, {
        error: message,
        kind: inseparable ? "inseparable" : "endpoint",
        nextAttemptAt: inseparable ? null : new Date(now().getTime() + wait),
      }).catch(() => {});
      log.warn("could not measure", { model, error: message, inseparable });
    } finally {
      running.delete(key);
      await pruneEmbedCalibrations(deps.sql, key).catch(() => {});
      await deps.aiSettings.refresh().catch(() => {});
    }
  }

  return {
    async ensure(opts = {}) {
      if (stopping) return;
      const cfg = deps.aiSettings.current();
      if (!cfg.embed.enabled) return;
      const key = calibrationKey(cfg);
      if (running.has(key)) return;
      const row = await getEmbedCalibration(deps.sql, key);
      if (!opts.force && row) {
        if (row.state === "ready") return;
        if (row.state === "failed" && (row.error_kind === "inseparable" || (row.next_attempt_at && row.next_attempt_at > now()))) return;
      }
      const triggeredBy = opts.alias ?? (await getNodeAiSettings(deps.sql))?.updated_by ?? SYSTEM_ALIAS;
      // Taken again here: the reads above leave room for another caller.
      if (running.has(key)) return;
      const entry = { progress: 0, done: Promise.resolve() };
      running.set(key, entry);
      // A run this process started and no longer holds ended without saying so (its last write
      // failed); one node writes a database, so it is dead whatever its start time.
      const deadBefore = row?.state === "running" && row.started_at >= deps.processStartedAt ? now() : deps.processStartedAt;
      const claimed = await claimEmbedCalibration(deps.sql, { configKey: key, model: cfg.embed.model, triggeredBy, processStartedAt: deadBefore }).catch(() => false);
      if (!claimed) {
        running.delete(key);
        return;
      }
      entry.done = run(cfg, key, triggeredBy);
    },

    progress(key) {
      return running.get(key)?.progress ?? null;
    },

    async stop() {
      stopping = true;
      await Promise.all([...running.values()].map((r) => r.done));
    },
  };
}
