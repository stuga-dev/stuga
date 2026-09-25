/**
 * Driving /mcp in a handler test. A test builds the Ctx one call should run
 * under; `callerFor` turns it into the caller that sends the request, and the
 * test mocks `workspaceContextFor` with `resolvingTo(ctx)` in place of the
 * membership gate, which handler-workspaces.test.ts exercises for real. For the
 * handler tests only.
 */
import type { AccountCtx, Ctx, McpCaller, workspaceContextFor } from "../../auth/context.js";
import { handleMcpRequest } from "../handler.js";

/** The caller behind `ctx`: its identity and access, with the workspace left to each call. */
export function callerFor(ctx: Ctx, over: Partial<McpCaller> = {}): McpCaller {
  const { workspaceId: _workspaceId, role: _role, principals: _principals, ...account } = ctx;
  return { account: account as AccountCtx, workspaces: null, readOnly: Boolean(ctx.scope?.readOnly), ...over };
}

/** The gate as a test wants it: `ctx`'s own workspace resolves to `ctx`, and any other is refused. */
export function resolvingTo(ctx: Ctx): typeof workspaceContextFor {
  return async (_caller, workspaceId) => (workspaceId === ctx.workspaceId ? ctx : null);
}

/** A call's arguments with the workspace filled in where the test left it out. */
export function inWorkspace(workspaceId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "search" || name === "retrieve") return { workspace_ids: [workspaceId], ...args };
  if (name === "workspaces" && args.action === "list") return args;
  return { workspace_id: workspaceId, ...args };
}

/** One JSON-RPC request to /mcp as `caller`, answered with its parsed payload. */
export async function mcpRequest(caller: McpCaller, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const req = new Request("https://api.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await (await handleMcpRequest(caller, req)).text();
  return JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? /data: (.*)/.exec(text)![1]! : text) as Record<string, unknown>;
}

/** One tools/call, answered with whether it failed and its text. */
export async function callToolAs(caller: McpCaller, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const payload = await mcpRequest(caller, "tools/call", { name, arguments: args });
  const result = (payload.result ?? {}) as { isError?: boolean; content?: Array<{ text?: string }> };
  return { isError: result.isError === true, text: String(result.content?.[0]?.text ?? "") };
}
