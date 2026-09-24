/** The origin gate, and the diagnosis it logs when it refuses a browser. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createApp } from "./dispatch.js";
import type { NodeEnv } from "../env.js";

const PUBLIC_ORIGIN = "http://localhost:8787";

const env = { publicOrigin: PUBLIC_ORIGIN, extraOrigins: [] } as unknown as NodeEnv;

const app = createApp(env);

const get = (origin: string | null) =>
  app.handle(new Request(`${PUBLIC_ORIGIN}/api/docs`, origin === null ? {} : { headers: { origin } }));

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/** The reported-origin set is module state, so every test needs a fresh origin. */
let n = 0;
const freshOrigin = () => `http://10.0.0.${++n}:8787`;

describe("a refused origin", () => {
  it("is a 403 whose log line names both origins", async () => {
    const origin = freshOrigin();
    const res = await get(origin);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin not allowed" });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(origin);
    expect(message).toContain(PUBLIC_ORIGIN);
    expect(message).toContain("PUBLIC_ORIGIN");
  });

  it("quotes the untrusted origin in the log line", async () => {
    const origin = freshOrigin();
    await get(origin);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`"${origin}"`);
  });

  it("is reported ONCE, however many requests that origin sends", async () => {
    const origin = freshOrigin();
    await get(origin);
    await get(origin);
    await get(origin);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("an origin that is allowed", () => {
  it("passes the gate and is not reported", async () => {
    // Past the gate this env lacks what the route needs, so the request fails later.
    await get(PUBLIC_ORIGIN).catch(() => {});
    expect(warn).not.toHaveBeenCalled();
  });

  it("lets a request with no Origin header through", async () => {
    await get(null).catch(() => {});
    expect(warn).not.toHaveBeenCalled();
  });
});

// LAST: this exhausts the module-level cap for the whole file.
describe("the report cap", () => {
  it("stops reporting rather than let a scanner write the log", async () => {
    for (let i = 0; i < 40; i++) await get(freshOrigin());

    const messages = warn.mock.calls.map((c) => String(c[0]));
    const notices = messages.filter((m) => m.includes("too many distinct refused origins"));
    expect(notices).toHaveLength(1);
    expect(messages.at(-1)).toBe(notices[0]);
    expect(messages.length).toBeLessThan(40);
  });
});
