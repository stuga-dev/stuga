/** `/api/me/nodes` through the front door: what a bookmark may be, whose it is, and that agent keys are refused. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildAccountContext = vi.fn();

vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  buildAccountContext,
}));
vi.mock("@stuga/db", () => ({
  listUserNodes: vi.fn(async () => []),
  addUserNode: vi.fn(),
  removeUserNode: vi.fn(async () => true),
}));

const db = await import("@stuga/db");
const { createApp } = await import("../http/dispatch.js");
import { MAX_OTHER_NODES } from "@stuga/protocol/api/other-nodes";
import type { NodeEnv } from "../env.js";

const mockList = vi.mocked(db.listUserNodes);
const mockAdd = vi.mocked(db.addUserNode);
const mockRemove = vi.mocked(db.removeUserNode);

const ORIGIN = "http://livs-air.local:8787";

const env = {
  publicOrigin: ORIGIN,
  extraOrigins: ["https://stuga.example.com"],
  rateLimit: { limit: async () => ({ success: true }) },
  jobs: { send: vi.fn(async () => {}) },
  settings: { current: () => ({ nodeLabel: "Liv’s Mac" }) },
} as unknown as NodeEnv;

const app = createApp(env);

const PERSON = { sql: {}, alias: "u_ada", displayName: "Ada", isAgent: false, surface: "web", env };
const AGENT = { sql: {}, alias: "agent-1", displayName: "Scout", isAgent: true, onBehalfOf: "u_ada", surface: "api-key", env };

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const add = (body: unknown) => call("POST", "/api/me/nodes", body);

beforeEach(() => {
  vi.clearAllMocks();
  buildAccountContext.mockResolvedValue(PERSON);
  mockAdd.mockImplementation(async (_sql, input) => ({ ok: true, node: { id: input.id, label: input.label, origin: input.origin } }));
});

describe("GET /api/me/nodes", () => {
  it("names this node and lists the caller's bookmarks in the stored order", async () => {
    mockList.mockResolvedValue([
      { id: "nb_2", label: "Studio", origin: "https://studio.example" },
      { id: "nb_1", label: "nas.local", origin: "http://nas.local:8787" },
    ]);
    const res = await call("GET", "/api/me/nodes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      current: { name: "Liv’s Mac", origin: ORIGIN },
      nodes: [
        { id: "nb_2", label: "Studio", origin: "https://studio.example" },
        { id: "nb_1", label: "nas.local", origin: "http://nas.local:8787" },
      ],
    });
    expect(mockList).toHaveBeenCalledWith(PERSON.sql, "u_ada");
  });
});

describe("POST /api/me/nodes", () => {
  it("keeps only the URL's origin and appends it under the caller, capped", async () => {
    const res = await add({ label: "  Studio  ", url: " https://user:pw@Studio.Example:8443/doc/1?x=1#y " });
    expect(res.status).toBe(201);
    const { node } = (await res.json()) as { node: { id: string; label: string; origin: string } };
    expect(node).toMatchObject({ label: "Studio", origin: "https://studio.example:8443" });
    const [, input, max] = mockAdd.mock.calls[0]!;
    expect(input).toMatchObject({ alias: "u_ada", label: "Studio", origin: "https://studio.example:8443" });
    expect(input.id).toBe(node.id);
    expect(max).toBe(MAX_OTHER_NODES);
  });

  it("labels a bookmark with its host when no label is given", async () => {
    for (const label of [undefined, null, "", "   "]) {
      const res = await add({ label, url: "http://nas.local:8787/" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { node: { label: string } }).node.label).toBe("nas.local:8787");
    }
  });

  it.each([
    ["nothing", undefined],
    ["a number", 42],
    ["a relative path", "/doc/1"],
    ["a bare host", "nas.local:8787"],
    ["another scheme", "ftp://nas.local"],
    ["a script", "javascript:alert(1)"],
    ["an overlong URL", `https://nas.local/${"a".repeat(2048)}`],
  ])("refuses %s as the URL", async (_what, url) => {
    const res = await add({ url });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_url" });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("refuses this node's own origins, the public one and the extra ones", async () => {
    for (const url of [`${ORIGIN}/doc/1`, "https://stuga.example.com"]) {
      const res = await add({ url });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "own_node" });
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("refuses a label that is not text, longer than 80 characters, or has control characters", async () => {
    for (const label of [7, "x".repeat(81), "Stu\u0000dio", "Stu\ndio", "Stu\u202edio"]) {
      const res = await add({ label, url: "https://studio.example" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_label" });
    }
    expect((await add({ label: "x".repeat(80), url: "https://studio.example" })).status).toBe(201);
  });

  it("refuses a label with a line or paragraph separator, or with nothing visible in it", async () => {
    for (const label of ["Stu\u2028dio", "Stu\u2029dio", "\u200b", "\u3164\u200d", "\u2800"]) {
      const res = await add({ label, url: "https://studio.example" });
      expect(res.status, JSON.stringify(label)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_label" });
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("takes a label with the format characters ordinary names use", async () => {
    for (const label of ["🏳️\u200d🌈 Home", "می\u200cخواهم", "Co\u00adop"]) {
      const res = await add({ label, url: "https://studio.example" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { node: { label: string } }).node.label).toBe(label);
    }
  });

  it("answers a duplicate and a full list with their own codes", async () => {
    mockAdd.mockResolvedValueOnce({ ok: false, reason: "already_added" });
    const duplicate = await add({ url: "https://studio.example" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "already_added" });

    mockAdd.mockResolvedValueOnce({ ok: false, reason: "limit_reached" });
    const full = await add({ url: "https://studio.example" });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "limit_reached" });
  });
});

describe("DELETE /api/me/nodes/:id", () => {
  it("removes the caller's own bookmark", async () => {
    const res = await call("DELETE", "/api/me/nodes/nb_1");
    expect(res.status).toBe(204);
    expect(mockRemove).toHaveBeenCalledWith(PERSON.sql, "u_ada", "nb_1");
  });

  it("answers someone else's bookmark as not found", async () => {
    mockRemove.mockResolvedValue(false);
    expect((await call("DELETE", "/api/me/nodes/nb_theirs")).status).toBe(404);
  });

  it("names a method the group does not answer", async () => {
    expect((await call("PUT", "/api/me/nodes")).status).toBe(405);
    expect((await call("PATCH", "/api/me/nodes/nb_1")).status).toBe(405);
  });
});

describe("an agent key", () => {
  it("is refused on every route before it reads or writes anything", async () => {
    buildAccountContext.mockResolvedValue(AGENT);
    for (const [method, path] of [
      ["GET", "/api/me/nodes"],
      ["POST", "/api/me/nodes"],
      ["DELETE", "/api/me/nodes/nb_1"],
    ] as const) {
      const res = await call(method, path, method === "POST" ? { url: "https://studio.example" } : undefined);
      expect(res.status).toBe(403);
    }
    expect(mockList).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
