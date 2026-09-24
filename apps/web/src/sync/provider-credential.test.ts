// @vitest-environment jsdom
/** A socket URL reaches proxy logs and history, so it carries a short-lived ticket, never the access token. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState: number = FakeSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  dropped(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.useFakeTimers();
  sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ ticket: "tk-1", expires_at: Math.floor(Date.now() / 1000) + 300, workspace_id: "ws1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function newProvider() {
  const { setSession } = await import("../lib/session/tokens");
  setSession({ accessToken: "test-token", expiresIn: 3600 });
  const { setActiveWorkspace } = await import("../lib/session/workspace-pointer");
  setActiveWorkspace("ws1");
  const { StugaProvider } = await import("./stuga-provider");
  const provider = new StugaProvider("d1", "alice");
  await vi.advanceTimersByTimeAsync(0);
  return provider;
}

describe("the sync socket URL", () => {
  it("carries a socket ticket and no access token", async () => {
    const provider = await newProvider();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toContain("ticket=tk-1");
    expect(sockets[0]!.url).not.toContain("access_token");
    expect(sockets[0]!.url).not.toContain("test-token");
    provider.destroy();
  });

  it("names no workspace: the tenant is a signed field of the ticket", async () => {
    const provider = await newProvider();
    expect(sockets[0]!.url).not.toContain("ws=");
    provider.destroy();
  });

  it("reconnects after a drop without a second mint", async () => {
    const provider = await newProvider();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sockets[0]!.dropped();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain("ticket=tk-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    provider.destroy();
  });
});