import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectorStatus } from "@stuga/protocol/api/remote-access";
import type { ConnectorHints } from "../config/env.js";
import {
  connectorBackoffMs,
  connectorSettled,
  createConnectorControl,
  readConnectorStatus,
  writeConnectorRequest,
  type ConnectorLine,
} from "./connector.js";

const MIN = 60_000;
const SHA = "3f".repeat(32);
const OTHER = "9c".repeat(32);
const ON: ConnectorLine = `on ${SHA}`;
const T0 = Date.parse("2026-10-02T12:00:00.000Z");

let work: string;
let hints: ConnectorHints;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "stuga-connector-"));
  mkdirSync(join(work, "requests"));
  mkdirSync(join(work, "status"));
  hints = { request: join(work, "requests", "remote"), status: join(work, "status", "remote.json") };
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

const report = (status: Partial<ConnectorStatus> & { state: ConnectorStatus["state"] }, at = T0) =>
  writeFileSync(hints.status, JSON.stringify({ message: "", at: new Date(at).toISOString(), connector_sha: null, config_sha: null, ...status }));

/** Every request written since the last look, taken off the disk so the next write is told apart. */
let lines: string[] = [];
function take(): void {
  if (!existsSync(hints.request)) return;
  lines.push(readFileSync(hints.request, "utf8"));
  unlinkSync(hints.request);
}
const request = () => {
  take();
  return lines.at(-1);
};

/** A control on a clock the test moves. */
function control() {
  let t = T0;
  const errors: unknown[] = [];
  const c = createConnectorControl({ hints, now: () => t, onError: (e) => errors.push(e) });
  lines = [];
  const wrote = () => {
    take();
    return lines.length;
  };
  return { c, errors, wrote, at: (ms: number) => (t = T0 + ms) };
}

describe("the request", () => {
  it("is one line, renamed in whole", async () => {
    await writeConnectorRequest(hints, ON);
    expect(readFileSync(hints.request, "utf8")).toBe(`${ON}\n`);
    await writeConnectorRequest(hints, "off");
    expect(readFileSync(hints.request, "utf8")).toBe("off\n");
    expect(readdirSync(join(work, "requests"))).toEqual(["remote"]);
    expect(statSync(hints.request).mode & 0o777).toBe(0o640);
  });

  it("is only ever on with a sha-256, or off", async () => {
    for (const bad of ["on", `on ${SHA.toUpperCase()}`, `on ${SHA}\noff`, "on abc", "stop"]) {
      await expect(writeConnectorRequest(hints, bad as ConnectorLine), bad).rejects.toThrow(/not a connector request/);
    }
    expect(readdirSync(join(work, "requests"))).toEqual([]);
  });
});

describe("the status", () => {
  it("reads what the packaging wrote", async () => {
    report({ state: "running", message: "Running.", connector_sha: OTHER, config_sha: SHA });
    expect(await readConnectorStatus(hints)).toEqual({
      state: "running",
      message: "Running.",
      at: new Date(T0).toISOString(),
      connector_sha: OTHER,
      config_sha: SHA,
    });
  });

  it("takes anything unreadable as nothing, and never throws", async () => {
    expect(await readConnectorStatus(hints)).toBeNull();
    for (const text of ["", "{", "null", "[]", '"running"', '{"state":"dancing"}', '{"message":"no state"}']) {
      writeFileSync(hints.status, text);
      expect(await readConnectorStatus(hints), text).toBeNull();
    }
    mkdirSync(join(work, "status", "dir.json"));
    expect(await readConnectorStatus({ ...hints, status: join(work, "status", "dir.json") })).toBeNull();
  });

  it("keeps a known state with what else it can read", async () => {
    writeFileSync(hints.status, JSON.stringify({ state: "failed", message: 7, config_sha: "not a sha", connector_sha: SHA, extra: true }));
    expect(await readConnectorStatus(hints)).toEqual({ state: "failed", message: "", at: "", connector_sha: SHA, config_sha: null });
  });
});

describe("whether the packaging did what was asked", () => {
  const status = (state: ConnectorStatus["state"], over: Partial<ConnectorStatus> = {}): ConnectorStatus => ({
    state,
    message: "",
    at: new Date(T0).toISOString(),
    connector_sha: OTHER,
    config_sha: SHA,
    ...over,
  });

  it("takes on as running these settings, or installing for them", () => {
    expect(connectorSettled(ON, status("running"), T0)).toBe(true);
    expect(connectorSettled(ON, status("running", { config_sha: OTHER }), T0)).toBe(false);
    expect(connectorSettled(ON, status("installing"), T0)).toBe(true);
    expect(connectorSettled(ON, status("installing", { config_sha: null }), T0)).toBe(true);
    expect(connectorSettled(ON, status("installing", { config_sha: OTHER }), T0)).toBe(false);
    for (const state of ["stopped", "refused", "failed", "unavailable"] as const) expect(connectorSettled(ON, status(state), T0), state).toBe(false);
    expect(connectorSettled(ON, null, T0)).toBe(false);
  });

  it("gives up on an install that has said nothing for 15 minutes", () => {
    expect(connectorSettled(ON, status("installing"), T0 + 15 * MIN)).toBe(true);
    expect(connectorSettled(ON, status("installing"), T0 + 15 * MIN + 1)).toBe(false);
  });

  it("takes off as stopped, or no connector to run", () => {
    expect(connectorSettled("off", status("stopped"), T0)).toBe(true);
    expect(connectorSettled("off", status("unavailable"), T0)).toBe(true);
    for (const state of ["running", "installing", "refused", "failed"] as const) expect(connectorSettled("off", status(state), T0), state).toBe(false);
    expect(connectorSettled("off", null, T0)).toBe(false);
  });

  it("asks again after 1, 5, 15, then every 60 minutes", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => connectorBackoffMs(n) / MIN)).toEqual([1, 5, 15, 60, 60, 60]);
  });
});

describe("the desired state", () => {
  it("is written when it changes, and not again for the same", async () => {
    const { c, wrote } = control();
    expect(c.line()).toBeNull();
    await c.want("off");
    expect(request()).toBe("off\n");
    expect(wrote()).toBe(1);
    await c.want("off");
    expect(wrote()).toBe(1);
    await c.want(ON);
    expect(request()).toBe(`${ON}\n`);
    expect(wrote()).toBe(2);
    expect(c.line()).toBe(ON);
    await c.want(ON, { force: true });
    expect(wrote()).toBe(3);
    // After a reset, the first want writes whatever was asked before.
    c.reset();
    await c.want(ON);
    expect(wrote()).toBe(4);
  });

  it("is written again, backing off, while the packaging has not done it", async () => {
    const { c, wrote, at } = control();
    await c.want(ON);
    expect(wrote()).toBe(1);
    const tick = async (ms: number) => {
      at(ms);
      await c.reconcile();
      return wrote();
    };
    expect(await tick(59_000)).toBe(1);
    expect(await tick(MIN)).toBe(2);
    expect(await tick(MIN + 5 * MIN - 1)).toBe(2);
    expect(await tick(6 * MIN)).toBe(3);
    expect(await tick(21 * MIN)).toBe(4);
    expect(await tick(81 * MIN)).toBe(5);
    expect(await tick(141 * MIN)).toBe(6);
    expect(request()).toBe(`${ON}\n`);

    // Done: the count starts over from the last time it was seen done.
    report({ state: "running", config_sha: SHA }, T0 + 142 * MIN);
    expect(await tick(142 * MIN)).toBe(6);
    expect(await tick(299 * MIN)).toBe(6);
    report({ state: "failed", message: "curl: (6) Could not resolve host", config_sha: SHA }, T0 + 300 * MIN);
    expect(await tick(299 * MIN + 59_000)).toBe(6);
    expect(await tick(300 * MIN)).toBe(7);
    expect(await tick(305 * MIN - 1)).toBe(7);
    expect(await tick(305 * MIN)).toBe(8);
  });

  it("asks for off again too, until the packaging has stopped it", async () => {
    const { c, wrote, at } = control();
    await c.want("off");
    expect(wrote()).toBe(1);
    report({ state: "running", config_sha: SHA });
    at(MIN);
    await c.reconcile();
    expect(wrote()).toBe(2);
    report({ state: "stopped" }, T0 + MIN);
    at(10 * MIN);
    await c.reconcile();
    expect(wrote()).toBe(2);
  });

  it("leaves a refusal to an administrator, or to a different line", async () => {
    const { c, wrote, at } = control();
    await c.want(ON);
    report({ state: "refused", message: "the connector's signature is not Stuga's" }, T0 + 1_000);
    at(3 * 60 * MIN);
    await c.reconcile();
    expect(wrote()).toBe(1);
    expect(await c.report()).toMatchObject({ status: { state: "refused" }, stale: false, retryAt: null });

    // Retry: a refusal from before it is no answer to it.
    at(3 * 60 * MIN + 500);
    await c.want(ON, { force: true });
    expect(wrote()).toBe(2);
    expect(await c.report()).toMatchObject({ status: { state: "refused" }, stale: true });
    at(3 * 60 * MIN + 2 * MIN);
    await c.reconcile();
    expect(wrote()).toBe(3);

    report({ state: "refused" }, T0 + 3 * 60 * MIN + 3 * MIN);
    at(10 * 60 * MIN);
    await c.reconcile();
    expect(wrote()).toBe(3);
    await c.want("off");
    expect(wrote()).toBe(4);
  });

  it("counts a status written in the same second as the request as its answer", async () => {
    const { c, at } = control();
    at(700);
    await c.want(ON);
    report({ state: "refused" }, T0);
    expect((await c.report()).stale).toBe(false);
  });

  it("reports when it asks again while the packaging has not done it", async () => {
    const { c, at } = control();
    await c.want(ON);
    report({ state: "failed", message: "no network" });
    expect(await c.report()).toMatchObject({ stale: false, retryAt: new Date(T0 + MIN) });
    at(MIN);
    await c.reconcile();
    expect((await c.report()).retryAt).toEqual(new Date(T0 + 6 * MIN));
    report({ state: "running", config_sha: SHA }, T0 + 2 * MIN);
    expect((await c.report()).retryAt).toBeNull();
  });

  it("knows whether the connector runs the settings asked for", async () => {
    const { c } = control();
    await c.want(ON);
    expect(c.running(SHA)).toBe(false);
    report({ state: "running", config_sha: OTHER });
    await c.read();
    expect(c.running(SHA)).toBe(false);
    report({ state: "running", config_sha: SHA });
    await c.read();
    expect(c.running(SHA)).toBe(true);
    expect(c.running(null)).toBe(false);
  });

  it("says once why it can't write, and writes once it can", async () => {
    rmSync(join(work, "requests"), { recursive: true });
    const { c, errors, at } = control();
    await c.want(ON);
    await c.want(ON);
    expect(c.line()).toBeNull();
    expect(errors).toHaveLength(1);
    mkdirSync(join(work, "requests"));
    at(1_000);
    await c.want(ON);
    expect(request()).toBe(`${ON}\n`);
    expect(c.line()).toBe(ON);
  });

  it("does not touch a request it never made", async () => {
    writeFileSync(hints.request, "off\n");
    const past = new Date(T0 - 60 * MIN);
    utimesSync(hints.request, past, past);
    const { c, at } = control();
    at(3 * 60 * MIN);
    await c.reconcile();
    expect(statSync(hints.request).mtimeMs).toBe(past.getTime());
  });
});
