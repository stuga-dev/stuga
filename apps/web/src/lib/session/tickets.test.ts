// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = 1_700_000_000_000;
let fetchMock: ReturnType<typeof vi.fn>;

/** The mint answer, with an expiry `ttl` seconds out. */
function ticketResponse(value: string, ttl: number, workspaceId = "ws1"): Response {
  return new Response(
    JSON.stringify({ ticket: value, expires_at: Math.floor(NOW / 1000) + ttl, workspace_id: workspaceId }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function load() {
  const { setSession } = await import("./tokens");
  setSession({ accessToken: "test-token", expiresIn: 3600 });
  const { setActiveWorkspace } = await import("./workspace-pointer");
  setActiveWorkspace("ws1");
  return import("./tickets");
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a held socket ticket", () => {
  it("is minted once and reused, so a reconnect spends no round trip", async () => {
    fetchMock.mockResolvedValue(ticketResponse("tk-1", 300));
    const { ensureSocketTicket, cachedSocketTicket } = await load();

    expect(await ensureSocketTicket("d1")).toBe("tk-1");
    expect(cachedSocketTicket("d1")).toBe("tk-1");
    expect(await ensureSocketTicket("d1")).toBe("tk-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for the document it is for", async () => {
    fetchMock.mockResolvedValue(ticketResponse("tk-1", 300));
    const { ensureSocketTicket } = await load();
    await ensureSocketTicket("d1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("doc=d1");
  });

  it("is retired before it expires, so a slow mint cannot leave a gap", async () => {
    fetchMock.mockResolvedValue(ticketResponse("tk-1", 10));
    const { ensureSocketTicket, cachedSocketTicket } = await load();
    await ensureSocketTicket("d1");
    expect(cachedSocketTicket("d1")).toBeNull();
  });

  it("is not reused in another workspace — a ticket names one tenant", async () => {
    fetchMock.mockResolvedValue(ticketResponse("tk-1", 300, "ws1"));
    const { ensureSocketTicket, cachedSocketTicket } = await load();
    await ensureSocketTicket("d1");
    const { setActiveWorkspace } = await import("./workspace-pointer");
    setActiveWorkspace("ws2");
    expect(cachedSocketTicket("d1")).toBeNull();
  });

  it("is per document", async () => {
    fetchMock.mockResolvedValueOnce(ticketResponse("tk-1", 300)).mockResolvedValueOnce(ticketResponse("tk-2", 300));
    const { ensureSocketTicket } = await load();
    expect(await ensureSocketTicket("d1")).toBe("tk-1");
    expect(await ensureSocketTicket("d2")).toBe("tk-2");
  });

  it("reports a refused mint as null rather than rejecting", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    const { ensureSocketTicket } = await load();
    await expect(ensureSocketTicket("d1")).resolves.toBeNull();
  });
});
describe("the media ticket", () => {
  function mediaResponse(ttl: number, workspaceId = "ws1"): Response {
    return new Response(JSON.stringify({ expires_at: Math.floor(NOW / 1000) + ttl, workspace_id: workspaceId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("is minted once with the session's workspace and reused while fresh", async () => {
    fetchMock.mockImplementation(async () => mediaResponse(3600));
    const { ensureMediaTicket } = await load();
    await ensureMediaTicket();
    await ensureMediaTicket();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/media/ticket");
    expect(new Headers((init as RequestInit).headers).get("x-stuga-workspace")).toBe("ws1");
  });

  it("is minted again for another workspace", async () => {
    fetchMock.mockImplementation(async () => mediaResponse(3600));
    const { ensureMediaTicket } = await load();
    await ensureMediaTicket();
    const { setActiveWorkspace } = await import("./workspace-pointer");
    setActiveWorkspace("ws2");
    await ensureMediaTicket();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is forgotten on sign-out and revoked at the server", async () => {
    fetchMock.mockImplementation(async () => mediaResponse(3600));
    const { ensureMediaTicket, clearMediaTicket } = await load();
    await ensureMediaTicket();
    clearMediaTicket();
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: "DELETE" });
    await ensureMediaTicket();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "DELETE")).toHaveLength(2);
  });
});
