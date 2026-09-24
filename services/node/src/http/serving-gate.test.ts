import { describe, expect, it } from "vitest";
import { createServingGate } from "./serving-gate.js";

const ORIGIN = "http://localhost:8787";
const get = (path: string, accept = "*/*") => new Request(ORIGIN + path, { headers: { accept } });
const live = {
  handler: async () => new Response("live"),
  upgrade: async () => new Response("upgraded"),
};

describe("the serving gate", () => {
  it("says the node is starting until it opens: a page for a browser, 503 for readiness and everything else", async () => {
    const gate = createServingGate();
    expect(gate.state()).toBe("starting");

    const page = await gate.handler(get("/", "text/html,application/xhtml+xml"));
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(page.headers.get("retry-after")).toBe("5");
    const html = await page.text();
    expect(html).toContain("Stuga is starting.");
    expect(html).toContain('http-equiv="refresh"');

    const ready = await gate.handler(get("/ready", "text/html"));
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ok: false, status: "starting" });

    const api = await gate.handler(new Request(ORIGIN + "/api/docs", { method: "POST", headers: { accept: "text/html" } }));
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: "unavailable", status: "starting" });

    expect((await gate.upgrade(get("/ws/d1"))).status).toBe(503);
  });

  it("says what it is doing while it backs up or upgrades", async () => {
    const gate = createServingGate();
    gate.pause("backing_up");
    expect(await (await gate.handler(get("/", "text/html"))).text()).toContain("Stuga is backing up before an upgrade.");
    gate.pause("upgrading");
    expect(await (await gate.handler(get("/", "text/html"))).text()).toContain("Stuga is upgrading.");
  });

  it("serves through the live handlers once open, and stops again on a pause", async () => {
    const gate = createServingGate();
    gate.open(live);
    expect(gate.state()).toBeNull();
    expect(await (await gate.handler(get("/"))).text()).toBe("live");
    expect(await (await gate.upgrade(get("/ws/d1"))).text()).toBe("upgraded");

    gate.pause("maintenance");
    const paused = await gate.handler(get("/", "text/html"));
    expect(paused.status).toBe(503);
    expect(await paused.text()).toContain("Stuga is making a backup.");

    gate.open();
    expect(await (await gate.handler(get("/"))).text()).toBe("live");
  });

  it("cannot open with nothing to serve", () => {
    expect(() => createServingGate().open()).toThrow(/nothing to serve/);
  });

  it("drains: waits for the requests already being answered, and gives up after the time allowed", async () => {
    const gate = createServingGate();
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    gate.open({ handler: async () => (await slow, new Response("done")), upgrade: live.upgrade });

    expect(await gate.drain(10)).toBe(true);
    const answering = gate.handler(get("/api/slow"));
    gate.pause("maintenance");
    expect(await gate.drain(20)).toBe(false);
    const drained = gate.drain(1000);
    finish();
    expect(await (await answering).text()).toBe("done");
    expect(await drained).toBe(true);
  });
});
