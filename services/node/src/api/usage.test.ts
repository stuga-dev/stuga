/**
 * /api/usage is owner/admin only and closed to agents; a reopened ask thread carries no per-turn
 * model or token counts. Keys are checked over the whole body, at any depth.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getMemberRole: vi.fn(),
  usageRollup: vi.fn(),
  getAskThread: vi.fn(),
  listAskTurns: vi.fn(),
}));

const { getMemberRole, usageRollup, getAskThread, listAskTurns } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function ctxFor(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: { publicOrigin: "https://stuga.test", aiSettings: { current: () => ({ enabled: true }) } },
    ...overrides,
  } as unknown as Ctx;
}

async function route(ctx: Ctx, method: string, path: string): Promise<Response> {
  const r = new Request(`https://node.test${path}`, { method });
  return routeWorkspaceRequest(ctx, r);
}

/** Every key in a JSON value, at any depth. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === "object") {
    for (const [k, child] of Object.entries(value)) {
      into.add(k);
      keysOf(child, into);
    }
  }
  return into;
}

const EMBED_ROW = {
  model: "embed-large",
  kind: "embedding",
  calls: 2,
  input_tokens: 2342,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

const COAUTHOR_ROW = {
  model: "claude-sonnet-4-6",
  kind: "coauthor",
  calls: 4,
  input_tokens: 88_100,
  output_tokens: 9_400,
  cache_read_tokens: 1_200,
  cache_write_tokens: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mock(getMemberRole).mockResolvedValue("owner");
  mock(usageRollup).mockResolvedValue({
    byModel: [EMBED_ROW, COAUTHOR_ROW],
    byAlias: [{ alias: "user:xin", ...EMBED_ROW }],
    byDay: [{ day: "2026-08-19", input_tokens: 2342, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }],
  });
});

describe("GET /api/usage", () => {
  it("serves raw token counts per model and per principal", async () => {
    const res = await route(ctxFor(), "GET", "/api/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: Record<string, number>;
      by_model: Array<Record<string, unknown>>;
      by_principal: Array<Record<string, unknown>>;
    };
    expect(body.totals).toEqual({ input_tokens: 90_442, output_tokens: 9_400 });
    expect(body.by_model[0]).toMatchObject({ model: "embed-large", input_tokens: 2342 });
    expect(body.by_principal[0]).toMatchObject({ alias: "user:xin", model: "embed-large", calls: 2 });
  });

  it("splits a principal's use by model, keeping their rows together, heaviest principal first", async () => {
    const row = (alias: string, model: string, input_tokens: number) => ({
      alias,
      model,
      calls: 1,
      input_tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    // As the query orders them: by tokens, so Ada's two models arrive apart.
    mock(usageRollup).mockResolvedValue({
      byModel: [],
      byAlias: [row("ada", "gpt-4.1", 900), row("liv", "gpt-4.1", 700), row("ada", "kimi-k3", 100)],
      byDay: [],
    });
    const res = await route(ctxFor(), "GET", "/api/usage");
    const body = (await res.json()) as { by_principal: Array<{ alias: string; model: string; input_tokens: number }> };
    expect(body.by_principal.map((r) => [r.alias, r.model, r.input_tokens])).toEqual([
      ["ada", "gpt-4.1", 900],
      ["ada", "kimi-k3", 100],
      ["liv", "gpt-4.1", 700],
    ]);
  });

  it("refuses a member", async () => {
    mock(getMemberRole).mockResolvedValue("member");
    const res = await route(ctxFor(), "GET", "/api/usage");
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: "only a workspace owner or admin can view usage",
    });
    expect(mock(usageRollup)).not.toHaveBeenCalled();
  });

  it("refuses agents, whatever role their principal holds", async () => {
    mock(getMemberRole).mockResolvedValue("owner");
    const res = await route(ctxFor({ isAgent: true } as Partial<Ctx>), "GET", "/api/usage");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/ask/threads/:id", () => {
  it("returns the thread without the per-turn model or token counts", async () => {
    mock(getAskThread).mockResolvedValue({ thread_id: "ask_1", workspace_id: "ws1", owner: "owner-1", title: "T" });
    mock(listAskTurns).mockResolvedValue([
      {
        thread_id: "ask_1",
        seq: 1,
        question: "what changed?",
        answer: "The projection did not.",
        citations: [{ n: 1, doc_id: "d1" }],
        steps: [{ kind: "searching" }],
        model: "claude-sonnet-4-6",
        rounds: 2,
        stop_reason: "answered",
        input_tokens: 12_004,
        output_tokens: 811,
        created_at: "2026-08-20T00:00:00.000Z",
      },
    ]);

    const res = await route(ctxFor(), "GET", "/api/ask/threads/ask_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turns: Array<Record<string, unknown>> };
    const keys = [...keysOf(body.turns)];

    expect(keys.filter((k) => /token/i.test(k))).toEqual([]);
    expect(keys).not.toContain("model");
    for (const k of ["question", "answer", "citations", "steps"]) expect(keys).toContain(k);
  });
});
