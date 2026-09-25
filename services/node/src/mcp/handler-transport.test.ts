/**
 * What `/mcp` answers for the methods that are not a JSON-RPC POST. The
 * standalone SSE stream is the one that bites: the handler buffers its response
 * before returning it, so a stream that never ends hangs the request forever
 * and the client shows a connection that never finishes connecting.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(async () => null),
  listWorkspacesForUser: vi.fn(async () => []),
}));

const { listWorkspacesForUser } = await import("@stuga/db");
const { handleMcpRequest } = await import("./handler.js");
import type { McpCaller } from "../auth/context.js";

// Enough to build a server, so a method that wrongly builds one is caught by the lookup it makes, not a crash.
const caller = {
  account: {
    sql: {},
    alias: "human-1",
    isAgent: false,
    env: {
      publicOrigin: "https://stuga.test",
      nodeId: "ktbbpahhzxoldakw",
      settings: { current: () => ({ nodeLabel: "Studio", maxBodyBytes: 1_000_000 }) },
    },
  },
  workspaces: null,
  readOnly: false,
} as unknown as McpCaller;

/** Fails the assertion rather than the suite's timeout, so a hang reads as a hang. */
function within(ms: number, work: Promise<Response>): Promise<Response | "hung"> {
  return Promise.race([work, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);
}

describe("/mcp transport methods", () => {
  it("refuses the standalone SSE stream instead of hanging on it", async () => {
    const res = await within(
      2000,
      handleMcpRequest(caller, new Request("https://stuga.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } })),
    );
    expect(res).not.toBe("hung");
    expect((res as Response).status).toBe(405);
    expect((res as Response).headers.get("allow")).toContain("POST");
  });

  it("answers every other stray method the same way, rather than building a server for it", async () => {
    for (const method of ["HEAD", "PUT", "PATCH"] as const) {
      const res = await within(2000, handleMcpRequest(caller, new Request("https://stuga.test/mcp", { method })));
      expect(res).not.toBe("hung");
      expect((res as Response).status).toBe(405);
    }
    // The SDK would answer these with 405 too; only the lookup a server makes shows one was built.
    expect(listWorkspacesForUser).not.toHaveBeenCalled();
  });
});
