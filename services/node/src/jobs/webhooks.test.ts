import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { WEBHOOK_MAX_FAILURES, signWebhookBody } from "../governance/webhooks/sign.js";
import type { JobsDb } from "./db.js";
import { isTerminal, type JobDeps, type JobsEnv } from "./deps.js";
import { handleEvent, handleWebhookDeliver } from "./webhooks.js";
import { handleRunIndex } from "./worker.js";

// Delivery vets the resolved address, so the fictional host needs a public answer.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

function deps(overrides: Partial<JobsDb> = {}, fetchImpl?: typeof fetch): JobDeps & { db: JobsDb } {
  const db = {
    upsertAgentRun: vi.fn(async () => {}),
    insertWorkspaceEvent: vi.fn(async (e: { workspaceId: string; type: string; docId: string | null; actor: string; actorKind: string; payload: unknown }) => ({
      id: 42,
      workspace_id: e.workspaceId,
      at: "2026-09-01T00:00:00Z",
      type: e.type,
      doc_id: e.docId,
      actor: e.actor,
      actor_kind: e.actorKind,
      payload: e.payload,
    })),
    docFolderAncestry: vi.fn(async () => ["root", "leaf"]),
    matchingWebhooks: vi.fn(async () => []),
    getWebhook: vi.fn(async () => null),
    getWorkspaceEvent: vi.fn(async () => null),
    recordWebhookDelivery: vi.fn(async () => {}),
    updateWebhook: vi.fn(async () => null),
    ...overrides,
  } as unknown as JobsDb;
  return {
    db,
    embed: vi.fn(async () => ({ embeddings: [], inputTokens: 0 })) as unknown as JobDeps["embed"],
    deliver: vi.fn(async () => {}),
    fetch: fetchImpl ?? (vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function env(): JobsEnv & { sent: IndexMessage[] } {
  const sent: IndexMessage[] = [];
  return { sent, jobs: { send: async (m: IndexMessage) => void sent.push(m) } } as unknown as JobsEnv & { sent: IndexMessage[] };
}

const RUN = {
  runId: "run_1",
  workspaceId: "ws1",
  docId: "d1",
  docKind: "prose" as const,
  docTitle: "T",
  source: "stdio",
  agent: "bot",
  agentAlias: "agent-1",
  client: null,
  model: null,
  reviewer: "alice",
  status: "open",
  reviewMode: "review" as const,
  autoApplied: false,
  reverted: false,
  acknowledged: false,
  pending: 1,
  accepted: 0,
  rejected: 0,
  conflicts: 0,
  applied: 0,
  createdAt: 1,
  updatedAt: 2,
};

describe("run_index", () => {
  it("upserts the mirror row", async () => {
    const d = deps();
    await handleRunIndex(d, { kind: "run_index", run: RUN });
    expect(d.db.upsertAgentRun).toHaveBeenCalledWith(RUN);
  });
});

describe("event", () => {
  it("stores the row, resolves the document's ancestry, and queues one delivery per matching hook", async () => {
    const d = deps({
      matchingWebhooks: vi.fn(async () => [{ webhook_id: "whk_a" }, { webhook_id: "whk_b" }]) as unknown as JobsDb["matchingWebhooks"],
    });
    const e = env();
    await handleEvent(e, d, { kind: "event", workspaceId: "ws1", type: "run.decided", docId: "d1", actor: "user:alice", actorKind: "human", payload: { x: 1 } });
    expect(d.db.insertWorkspaceEvent).toHaveBeenCalledWith({
      workspaceId: "ws1",
      type: "run.decided",
      docId: "d1",
      actor: "user:alice",
      actorKind: "human",
      payload: { x: 1 },
    });
    expect(d.db.docFolderAncestry).toHaveBeenCalledWith("d1");
    expect(d.db.matchingWebhooks).toHaveBeenCalledWith("ws1", "run.decided", ["root", "leaf"]);
    expect(e.sent).toEqual([
      { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 },
      { kind: "webhook_deliver", webhookId: "whk_b", eventId: 42 },
    ]);
  });
  it("an event with no document matches only workspace-wide hooks", async () => {
    const d = deps();
    await handleEvent(env(), d, { kind: "event", workspaceId: "ws1", type: "doc.created", actor: "user:alice", actorKind: "human" });
    expect(d.db.docFolderAncestry).not.toHaveBeenCalled();
    expect(d.db.matchingWebhooks).toHaveBeenCalledWith("ws1", "doc.created", []);
  });
});

const HOOK = { webhook_id: "whk_a", workspace_id: "ws1", url: "https://hooks.example/stuga", secret: "s3cret", active: true, failures: 0 };
const EVENT = { id: 42, at: "2026-09-01T00:00:00Z", workspace_id: "ws1", type: "run.decided", doc_id: "d1", actor: "user:alice", actor_kind: "human", payload: { x: 1 } };

describe("webhook_deliver", () => {
  it("POSTs the event, signed over the exact body, and records the success", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const d = deps({ getWebhook: vi.fn(async () => HOOK), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    await handleWebhookDeliver(d, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 });
    expect(seen).not.toBeNull();
    const { url, init } = seen!;
    expect(url).toBe(HOOK.url);
    const body = String(init.body);
    const headers = init.headers as Record<string, string>;
    expect(JSON.parse(body)).toMatchObject({ id: "42", type: "run.decided", doc_id: "d1", payload: { x: 1 } });
    expect(headers["x-stuga-signature"]).toBe(`sha256=${createHmac("sha256", HOOK.secret).update(body).digest("hex")}`);
    expect(headers["x-stuga-event"]).toBe("run.decided");
    expect(d.db.recordWebhookDelivery).toHaveBeenCalledWith("whk_a", 204, true);
    expect(d.db.updateWebhook).not.toHaveBeenCalled();
  });

  it("refuses to deliver to a hook that now resolves to a private address, and disables it", async () => {
    const { lookup } = await import("node:dns/promises");
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as never);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const d = deps({ getWebhook: vi.fn(async () => HOOK), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    await expect(
      handleWebhookDeliver(d, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 }),
    ).rejects.toThrow(/refused address/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.db.updateWebhook).toHaveBeenCalledWith("ws1", "whk_a", { active: false });
  });

  it("a 5xx records the failure and throws so the queue retries", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const d = deps({ getWebhook: vi.fn(async () => HOOK), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    await expect(handleWebhookDeliver(d, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 })).rejects.toThrow(/503/);
    expect(d.db.recordWebhookDelivery).toHaveBeenCalledWith("whk_a", 503, false);
  });

  it("a 4xx is terminal: recorded, thrown, and not worth retrying", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 410 })) as unknown as typeof fetch;
    const d = deps({ getWebhook: vi.fn(async () => HOOK), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    let thrown: unknown;
    try {
      await handleWebhookDeliver(d, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(isTerminal(thrown)).toBe(true);
  });

  it("a network failure records a null status and throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const d = deps({ getWebhook: vi.fn(async () => HOOK), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    await expect(handleWebhookDeliver(d, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 })).rejects.toThrow(/unreachable/);
    expect(d.db.recordWebhookDelivery).toHaveBeenCalledWith("whk_a", null, false);
  });

  it("switches a hook off once it has failed WEBHOOK_MAX_FAILURES times in a row", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const dark = { ...HOOK, failures: WEBHOOK_MAX_FAILURES - 1 };
    const d = deps({ getWebhook: vi.fn(async () => dark), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    await expect(handleWebhookDeliver(d, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 })).rejects.toThrow();
    expect(d.db.updateWebhook).toHaveBeenCalledWith("ws1", "whk_a", { active: false });
  });

  it("a paused or deleted hook, or a missing event, is a quiet no-op", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const paused = deps({ getWebhook: vi.fn(async () => ({ ...HOOK, active: false })), getWorkspaceEvent: vi.fn(async () => EVENT) } as unknown as Partial<JobsDb>, fetchImpl);
    await handleWebhookDeliver(paused, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 });
    const gone = deps({ getWebhook: vi.fn(async () => HOOK), getWorkspaceEvent: vi.fn(async () => null) } as unknown as Partial<JobsDb>, fetchImpl);
    await handleWebhookDeliver(gone, { kind: "webhook_deliver", webhookId: "whk_a", eventId: 42 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("signWebhookBody is HMAC-SHA256 over the body, hex, prefixed", () => {
    expect(signWebhookBody("k", "body")).toBe(`sha256=${createHmac("sha256", "k").update("body").digest("hex")}`);
  });
});
