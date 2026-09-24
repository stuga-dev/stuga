/**
 * The node's /mcp endpoint: a stateless Streamable-HTTP MCP server built per
 * request around the caller's authenticated Ctx. Every tool call resolves its
 * workspace, is refused if a read-only key tries to write, and writes one audit
 * row, reads and refusals included: at once for a call refused here, and once
 * the tool answers for a call that runs, denied if the backend refused it as read-only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isMutating, type ToolName } from "@stuga/agent-surface/catalog";
import { buildInstructions } from "@stuga/agent-surface/instructions";
import { registerAgentTools, type ToolCall } from "@stuga/agent-surface/register";
import { agentPrincipal } from "@stuga/auth";
import type { AuditStatus } from "@stuga/protocol/domain/audit";
import { MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";
import { getMemberRole, getWorkspace } from "@stuga/db";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { resolvePrincipals } from "../auth/principals.js";
import { READ_ONLY_MESSAGE } from "../authz/authz.js";
import { VERSION } from "../version.js";
import { nodeBackend } from "./backend.js";

/** Identical for unknown, revoked and not-a-member, so a credential cannot probe which ids exist. */
export const WORKSPACE_UNAVAILABLE_MESSAGE = "workspace is not available to this connector";

/**
 * The Ctx one call runs under: home when `workspace_id` is absent, that
 * workspace when the caller (for an agent, its human) is a member there now,
 * else null. Never a fallback to home, which would land a write in the wrong tenant.
 */
async function workspaceCtx(base: Ctx, requested: string | undefined): Promise<Ctx | null> {
  const wsId = requested?.trim();
  if (!wsId || wsId === base.workspaceId) return base;
  if (base.isAgent) {
    // A folder-scoped key's folders are in its home workspace; it has nothing anywhere else.
    if (base.scope?.folders) return null;
    const role = await getMemberRole(base.sql, wsId, base.onBehalfOf);
    if (!role) return null;
    const inherited = await resolvePrincipals(base.sql, base.onBehalfOf, wsId, role);
    // The agent keeps its own principal: documents it created are granted to agent:<id>.
    return { ...base, workspaceId: wsId, role, principals: [...new Set([agentPrincipal(base.alias), ...inherited])] };
  }
  const role = await getMemberRole(base.sql, wsId, base.alias);
  if (!role) return null;
  return { ...base, workspaceId: wsId, role, principals: await resolvePrincipals(base.sql, base.alias, wsId, role) };
}

/** Audit verbs for tools that take no `action`. */
const DEFAULT_ACTION: Record<ToolName, string> = {
  workspaces: "list",
  docs: "list",
  markdown: "read",
  media: "upload",
  comments: "list",
  folders: "list",
  events: "poll",
  collections: "list",
  retrieve: "retrieve",
  databases: "list",
  query: "select",
};

function auditTarget(args: Record<string, unknown>): { targetKind: string; targetId: string } | null {
  if (typeof args.doc_id === "string" && args.doc_id) return { targetKind: "doc", targetId: args.doc_id };
  if (typeof args.database_id === "string" && args.database_id) return { targetKind: "database", targetId: args.database_id };
  if (typeof args.collection_id === "string" && args.collection_id) return { targetKind: "collection", targetId: args.collection_id };
  return null;
}

function buildMcpServer(base: Ctx, conventions: string): McpServer {
  // One name for the product. Which node this is, and which workspaces it reaches, are in the
  // instructions and in `workspaces` action:list, where the model can act on them.
  const node = { name: base.env.settings.current().nodeLabel, origin: base.env.publicOrigin };
  const instructions = buildInstructions({ variant: "http", node, conventions, readOnly: Boolean(base.scope?.readOnly) });
  const server = new McpServer({ name: "stuga", title: MCP_SERVER_TITLE, version: VERSION }, { instructions, capabilities: { tools: {} } });
  registerAgentTools(
    server,
    async ({ tool, action, args }: ToolCall) => {
      const ctx = await workspaceCtx(base, typeof args.workspace_id === "string" ? args.workspace_id : undefined);
      // A refused call is the action it attempted, marked denied, so a filter on the tool finds refusals too.
      const audit = (status: AuditStatus) =>
        recordAudit({ ...base, workspaceId: ctx?.workspaceId }, { action: `mcp.${tool}.${action ?? DEFAULT_ACTION[tool]}`, ...auditTarget(args), status });
      if (!ctx) {
        audit("denied");
        return { error: WORKSPACE_UNAVAILABLE_MESSAGE };
      }
      if (ctx.scope?.readOnly && isMutating(tool, action)) {
        audit("denied");
        return { error: READ_ONLY_MESSAGE };
      }
      // A read can still end in the read-only refusal: open_page on a row whose page would have to be made.
      return { backend: nodeBackend(ctx, base.workspaceId), settled: (refusal) => audit(refusal === READ_ONLY_MESSAGE ? "denied" : "ok") };
    },
    "http",
  );
  return server;
}

/**
 * Streamable HTTP also lets a client open a standalone SSE stream with GET, for
 * messages the server starts. This server is stateless — a fresh transport per
 * request, with no session to hang a stream on — so it has none to offer, and
 * the spec's answer for that is 405. Saying so matters: the response below is
 * buffered before it is returned, and buffering a stream that never ends hangs
 * the request forever without sending so much as a header, which a client shows
 * as a connection that never finishes connecting.
 */
const MCP_METHODS = new Set(["POST", "DELETE"]);

/** One stateless MCP request: a fresh server and transport, the response fully buffered before cleanup. */
export async function handleMcpRequest(ctx: Ctx, req: Request): Promise<Response> {
  if (!MCP_METHODS.has(req.method)) {
    return new Response(null, { status: 405, headers: { allow: [...MCP_METHODS].join(", ") } });
  }
  const home = await getWorkspace(ctx.sql, ctx.workspaceId).catch(() => null);
  const server = buildMcpServer(ctx, home?.agent_instructions ?? "");
  // The listener already held the body to the node's ceiling. The SDK's own 4 MiB default sits
  // under an inline image at the `media` cap, and would refuse it before the tool could name its limit.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: ctx.env.settings.current().maxBodyBytes,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // Buffering drains the tool's database work before the transport closes.
    const body = res.body ? await new Response(res.body).text() : "";
    return new Response(body, { status: res.status, headers: new Headers(res.headers) });
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}
