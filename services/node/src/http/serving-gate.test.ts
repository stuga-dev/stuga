import { describe, expect, it } from "vitest";
import { answeredUntil, createServingGate } from "./serving-gate.js";

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

  it("refuses for good once the node refused its database: a page that says why, readiness that says so, nothing to retry", async () => {
    const gate = createServingGate();
    gate.refuse({
      title: "Stuga 1.1.0 last served this data",
      body: "This is <b>Stuga</b> 1.0.0 & it changed nothing.",
      command: `sudo "/Library/Application Support/Stuga/current/bin/stuga" restore '2026-10-04T030000Z'`,
    });
    expect(gate.state()).toBe("refused");

    const ready = await gate.handler(get("/ready"));
    expect(ready.status).toBe(503);
    expect(ready.headers.get("retry-after")).toBeNull();
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(await ready.json()).toEqual({ ok: false, status: "refused" });

    const page = await gate.handler(get("/", "text/html"));
    expect(page.status).toBe(503);
    expect(page.headers.get("retry-after")).toBeNull();
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await page.text();
    expect(html).toContain("<strong>Stuga 1.1.0 last served this data</strong>");
    expect(html).toContain("This is &#60;b&#62;Stuga&#60;/b&#62; 1.0.0 &#38; it changed nothing.");
    expect(html).not.toContain("<b>");
    expect(html).toContain(
      "<pre><code>sudo &#34;/Library/Application Support/Stuga/current/bin/stuga&#34; restore &#39;2026-10-04T030000Z&#39;</code></pre>",
    );
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
    expect(html).toContain("This page reloads by itself.");

    const api = await gate.handler(new Request(ORIGIN + "/api/docs", { method: "POST" }));
    expect(api.status).toBe(503);
    expect(api.headers.get("retry-after")).toBeNull();
    expect(await api.json()).toEqual({ error: "refused", status: "refused", message: "Stuga 1.1.0 last served this data" });

    expect((await gate.upgrade(get("/ws/d1"))).status).toBe(503);
    expect(() => gate.open(live)).toThrow(/refused its database/);
    expect(() => gate.pause("maintenance")).toThrow(/refused its database/);
    expect(gate.state()).toBe("refused");
  });

  it("leaves the code block out of a refusal with no command to run", async () => {
    const gate = createServingGate();
    gate.refuse({ title: "A newer Stuga changed this data", body: "This build changed nothing.", command: null });
    const html = await (await gate.handler(get("/", "text/html"))).text();
    expect(html).toContain("<strong>A newer Stuga changed this data</strong>");
    expect(html).not.toContain("<pre>");
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

  it("counts a response whose body is written after its handler returns until that is done, however it ends", async () => {
    const gate = createServingGate();
    let written!: () => void;
    let broken!: (err: Error) => void;
    const done = [new Promise<void>((resolve) => (written = resolve)), new Promise<void>((_, reject) => (broken = reject))];
    gate.open({ handler: async () => answeredUntil(new Response("streaming"), done.shift()!), upgrade: live.upgrade });

    await gate.handler(get("/api/export"));
    gate.pause("maintenance");
    expect(await gate.drain(20)).toBe(false);
    const drained = gate.drain(1000);
    written();
    expect(await drained).toBe(true);

    gate.open();
    await gate.handler(get("/api/export"));
    expect(await gate.drain(20)).toBe(false);
    broken(new Error("the client went away"));
    expect(await gate.drain(1000)).toBe(true);
  });
});
