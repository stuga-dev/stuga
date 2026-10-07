/**
 * The background measurement: one run per configuration, never awaited by its callers, retried
 * later after an endpoint failure, never after a model that cannot tell related text from
 * unrelated, and a result kept in force while the same model is measured again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig, CalibrationResult } from "@stuga/ai";
import type { EmbedCalibrationRow } from "@stuga/db";

const table = new Map<string, EmbedCalibrationRow>();
const usage: Array<{ alias: string; inputTokens?: number }> = [];
let updatedBy: string | null = null;

vi.mock("@stuga/db", () => ({
  getEmbedCalibration: vi.fn(async (_sql: unknown, key: string) => (table.has(key) ? { ...table.get(key)! } : null)),
  getNodeAiSettings: vi.fn(async () => (updatedBy ? { updated_by: updatedBy } : null)),
  claimEmbedCalibration: vi.fn(async (_sql: unknown, i: { configKey: string; model: string; triggeredBy: string; processStartedAt: Date }) => {
    const row = table.get(i.configKey);
    if (row && row.state === "running" && row.started_at >= i.processStartedAt) return false;
    table.set(i.configKey, {
      config_key: i.configKey,
      model: i.model,
      state: "running",
      result: row?.result ?? null,
      error: null,
      error_kind: null,
      attempts: (row?.attempts ?? 0) + 1,
      next_attempt_at: row?.next_attempt_at ?? null,
      triggered_by: i.triggeredBy,
      started_at: new Date(),
      finished_at: row?.finished_at ?? null,
    });
    return true;
  }),
  finishEmbedCalibration: vi.fn(async (_sql: unknown, key: string, result: object) => {
    Object.assign(table.get(key)!, { state: "ready", result, attempts: 0, next_attempt_at: null, finished_at: new Date() });
  }),
  failEmbedCalibration: vi.fn(async (_sql: unknown, key: string, i: { error: string; kind: "endpoint" | "inseparable"; nextAttemptAt: Date | null }) => {
    const row = table.get(key)!;
    Object.assign(row, { state: "failed", error: i.error, error_kind: i.kind, next_attempt_at: i.nextAttemptAt, result: i.kind === "inseparable" ? null : row.result });
  }),
  pruneEmbedCalibrations: vi.fn(async () => {}),
  insertAiUsage: vi.fn(async (_sql: unknown, u: { alias: string; inputTokens?: number }) => void usage.push(u)),
}));

const calibrateMock = vi.fn();
vi.mock("@stuga/ai", async (orig) => ({ ...(await orig<typeof import("@stuga/ai")>()), calibrate: (...a: unknown[]) => calibrateMock(...a) }));

const { CalibrationError, calibrationKey } = await import("@stuga/ai");
const { createCalibrator } = await import("./calibrator.js");

const CFG: AiConfig = {
  enabled: true,
  chat: { enabled: false, defaultModel: "", endpoints: [] },
  embed: { enabled: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "embeddinggemma-2:270m", dims: 1024, searchCutoff: null },
  rerank: { enabled: false, baseUrl: "", model: "" },
};
const KEY = calibrationKey(CFG);
const RESULT = { levels: { short: { strict: 0.27, balanced: 0.34, loose: 0.39 }, question: { strict: 0.25, balanced: 0.31, loose: 0.36 } }, tokens: 1234, ms: 5 } as unknown as CalibrationResult;

const silent = { info: () => {}, warn: () => {} };
let clock = new Date("2026-10-07T12:00:00Z");
const refresh = vi.fn(async () => {});

function calibrator(cfg: AiConfig = CFG, processStartedAt = new Date(clock.getTime() - 60_000)) {
  return createCalibrator({ sql: {} as never, aiSettings: { current: () => cfg, refresh }, processStartedAt, now: () => clock, log: silent });
}

/** Lets a started run finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  table.clear();
  usage.length = 0;
  updatedBy = null;
  clock = new Date("2026-10-07T12:00:00Z");
  calibrateMock.mockReset();
  refresh.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("createCalibrator", () => {
  it("measures once, records the result and the tokens, and refreshes the settings in force", async () => {
    calibrateMock.mockResolvedValue(RESULT);
    const c = calibrator();
    await c.ensure({ alias: "admin-1" });
    await settle();
    expect(table.get(KEY)).toMatchObject({ state: "ready", result: RESULT, triggered_by: "admin-1" });
    expect(usage).toEqual([expect.objectContaining({ alias: "admin-1", inputTokens: 1234 })]);
    expect(refresh).toHaveBeenCalled();

    await c.ensure();
    expect(calibrateMock).toHaveBeenCalledTimes(1);
  });

  it("returns before the run ends, and runs one measurement per configuration at a time", async () => {
    let finish!: (r: CalibrationResult) => void;
    calibrateMock.mockReturnValue(new Promise<CalibrationResult>((r) => (finish = r)));
    const c = calibrator();
    await Promise.all([c.ensure(), c.ensure(), c.ensure()]);
    expect(calibrateMock).toHaveBeenCalledTimes(1);
    expect(c.progress(KEY)).toBe(0);
    finish(RESULT);
    await settle();
    expect(c.progress(KEY)).toBeNull();
  });

  it("does nothing while semantic search is off", async () => {
    await calibrator({ ...CFG, embed: { ...CFG.embed, enabled: false } }).ensure();
    expect(calibrateMock).not.toHaveBeenCalled();
  });

  it("takes over a run left by a process that stopped, or one this process lost", async () => {
    calibrateMock.mockResolvedValue(RESULT);
    table.set(KEY, { ...({} as EmbedCalibrationRow), config_key: KEY, model: "m", state: "running", result: null, attempts: 1, started_at: new Date(clock.getTime() - 3_600_000) });
    // This process started after that run did: the run's process is gone.
    await calibrator(CFG, new Date(clock.getTime() - 60_000)).ensure();
    await settle();
    expect(table.get(KEY)?.state).toBe("ready");

    // Started by this process, which no longer holds it: its last write never landed.
    table.set(KEY, { ...table.get(KEY)!, state: "running", started_at: new Date(clock.getTime() - 1_000) });
    calibrateMock.mockClear();
    await calibrator(CFG, new Date(clock.getTime() - 60_000)).ensure({ force: true });
    await settle();
    expect(calibrateMock).toHaveBeenCalledTimes(1);
    expect(table.get(KEY)?.state).toBe("ready");
  });

  it("tries again after 1, 5 and 30 minutes, 2 hours, then every 6 hours, keeping the last result in force", async () => {
    table.set(KEY, { ...({} as EmbedCalibrationRow), config_key: KEY, model: "m", state: "ready", result: RESULT as never, attempts: 0, started_at: clock });
    calibrateMock.mockRejectedValue(new CalibrationError("endpoint", "embeddings 503"));
    const c = calibrator();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await c.ensure({ force: i === 0 });
      await settle();
      const row = table.get(KEY)!;
      expect(row).toMatchObject({ state: "failed", error_kind: "endpoint", result: RESULT });
      waits.push((row.next_attempt_at!.getTime() - clock.getTime()) / 60_000);
      // Not due yet: nothing runs.
      calibrateMock.mockClear();
      await c.ensure();
      expect(calibrateMock).not.toHaveBeenCalled();
      calibrateMock.mockRejectedValue(new CalibrationError("endpoint", "embeddings 503"));
      clock = new Date(row.next_attempt_at!.getTime() + 1);
    }
    expect(waits).toEqual([1, 5, 30, 120, 360, 360]);
  });

  it("does not try again a model that cannot tell related text from unrelated, until asked", async () => {
    calibrateMock.mockRejectedValue(new CalibrationError("inseparable", "alike"));
    const c = calibrator();
    await c.ensure();
    await settle();
    expect(table.get(KEY)).toMatchObject({ state: "failed", error_kind: "inseparable", result: null, next_attempt_at: null });
    calibrateMock.mockClear();
    clock = new Date(clock.getTime() + 86_400_000);
    await c.ensure();
    expect(calibrateMock).not.toHaveBeenCalled();
    await c.ensure({ force: true });
    expect(calibrateMock).toHaveBeenCalledTimes(1);
  });

  it("attributes tokens to whoever asked, else the admin who last saved, else the node", async () => {
    calibrateMock.mockResolvedValue(RESULT);
    updatedBy = "admin-2";
    await calibrator().ensure();
    await settle();
    expect(usage.at(-1)?.alias).toBe("admin-2");

    table.clear();
    updatedBy = null;
    await calibrator().ensure();
    await settle();
    expect(usage.at(-1)?.alias).toBe("system");
  });

  it("ends a run at shutdown without marking it failed, so the next process takes it over", async () => {
    calibrateMock.mockImplementation(async (_cfg: unknown, opts: { shouldStop: () => boolean }) => {
      while (!opts.shouldStop()) await new Promise((r) => setTimeout(r, 1));
      throw new CalibrationError("stopped", "stopped");
    });
    const c = calibrator();
    await c.ensure();
    await c.stop();
    expect(table.get(KEY)?.state).toBe("running");
    calibrateMock.mockClear();
    await c.ensure();
    expect(calibrateMock).not.toHaveBeenCalled();
  });
});
