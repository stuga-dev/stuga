import { describe, expect, it } from "vitest";
import { runShutdown, SHUTDOWN_DEADLINE_MS } from "./shutdown.js";

describe("runShutdown", () => {
  it("runs every step in order", async () => {
    const ran: string[] = [];
    const step = (name: string) => ({ name, run: async () => void ran.push(name) });
    expect(await runShutdown([step("listener"), step("actors"), step("pool")], 1000)).toEqual({ outcome: "done" });
    expect(ran).toEqual(["listener", "actors", "pool"]);
  });

  it("stops at the first step that throws, and names it", async () => {
    const ran: string[] = [];
    const outcome = await runShutdown(
      [
        { name: "listener", run: () => void ran.push("listener") },
        { name: "actors", run: () => Promise.reject(new Error("store is locked")) },
        { name: "pool", run: () => void ran.push("pool") },
      ],
      1000,
    );
    expect(outcome).toMatchObject({ outcome: "failed", step: "actors" });
    expect(String((outcome as { error: unknown }).error)).toContain("store is locked");
    expect(ran).toEqual(["listener"]);
  });

  it("gives up at the deadline and names the step it was still waiting on", async () => {
    const started = Date.now();
    const outcome = await runShutdown(
      [
        { name: "listener", run: async () => {} },
        { name: "document actors", run: () => new Promise(() => {}) },
        { name: "pool", run: async () => {} },
      ],
      100,
    );
    expect(outcome).toEqual({ outcome: "deadline", step: "document actors" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(95);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up inside the 30 s a supervisor must allow after SIGTERM", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(30_000);
  });
});
