/** A webhook URL authorises by possession (the secret is usually its path), so the ledger holds only fingerprints of it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  insertWebhook: vi.fn(),
  updateWebhook: vi.fn(),
}));

const { insertWebhook, updateWebhook } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
const { fingerprintUrl } = await import("../../config/settings/node.js");
import type { Ctx } from "../../auth/context.js";

// Registration vets the resolved address, so the fictional host needs a public answer.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

const mockInsert = insertWebhook as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = updateWebhook as unknown as ReturnType<typeof vi.fn>;
const send = vi.fn(async (_message: unknown) => {});

/** The whole secret of this hook is its last path segment. */
const HOOK_URL = "https://hooks.slack.com/services/T0000/B0000/8Xk2QpLmv9RtZa";
const TOKEN = "8Xk2QpLmv9RtZa";

function ctxFor(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: { jobs: { send } },
    ...over,
  } as unknown as Ctx;
}

const hookRow = (url: string) => ({
  webhook_id: "whk_1",
  url,
  events: [],
  folder_id: null,
  active: true,
  created_by: "owner-1",
  created_at: new Date("2026-09-01T10:00:00.000Z"),
  last_delivery_at: null,
  last_status: null,
  failures: 0,
});

async function post(body: unknown): Promise<Response> {
  const url = new URL("https://node.test/api/webhooks");
  return routeWorkspaceRequest(ctxFor(), new Request(url, { method: "POST", body: JSON.stringify(body) }));
}

async function patch(body: unknown): Promise<Response> {
  const url = new URL("https://node.test/api/webhooks/whk_1");
  return routeWorkspaceRequest(ctxFor(), new Request(url, { method: "PATCH", body: JSON.stringify(body) }));
}

/** The one audit message this request enqueued. */
const row = () => send.mock.calls.map(([m]) => m as Record<string, unknown>)[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockImplementation(async (_sql: unknown, input: { url: string }) => hookRow(input.url));
  mockUpdate.mockResolvedValue(hookRow(HOOK_URL));
});

describe("webhook.create", () => {
  it("labels the row with a fingerprint, never the URL", async () => {
    expect((await post({ url: HOOK_URL })).status).toBe(201);
    const label = row().targetLabel as string;

    expect(label).not.toContain(TOKEN);
    expect(label).not.toContain("/services/");
    expect(label).toContain("hooks.slack.com");
    expect(label).toBe(fingerprintUrl(HOOK_URL));
  });

  it("tells two hooks on one host apart", async () => {
    await post({ url: HOOK_URL });
    const first = row().targetLabel;
    send.mockClear();
    await post({ url: "https://hooks.slack.com/services/T0000/B0000/differentToken" });
    expect(row().targetLabel).not.toBe(first);
  });

  it("records the events and folder in detail", async () => {
    await post({ url: HOOK_URL, events: ["doc.updated"] });
    expect(row().detail).toEqual({ events: ["doc.updated"], folder_id: null });
  });
});

describe("webhook.update", () => {
  it("labels the row with a fingerprint of the hook as it now stands", async () => {
    const moved = "https://example.test/hooks/aVeryPrivateToken";
    mockUpdate.mockResolvedValue(hookRow(moved));
    expect((await patch({ url: moved })).status).toBe(200);

    const label = row().targetLabel as string;
    expect(label).not.toContain("aVeryPrivateToken");
    expect(label).toBe(fingerprintUrl(moved));
  });

  it("fingerprints a URL the patch set in detail too", async () => {
    const moved = "https://example.test/hooks/aVeryPrivateToken";
    mockUpdate.mockResolvedValue(hookRow(moved));
    await patch({ url: moved, active: false });
    expect(JSON.stringify(row().detail)).not.toContain("aVeryPrivateToken");
    expect(row().detail).toEqual({ url: fingerprintUrl(moved), active: false });
  });

  it("records a patch without a URL as sent", async () => {
    await patch({ active: false });
    expect(row().detail).toEqual({ active: false });
  });
});
