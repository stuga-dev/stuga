/**
 * The node's /mcp endpoint: a stateless Streamable-HTTP MCP server built per
 * request around the caller. Every tool call names its workspace and is run in
 * it only if the credential reaches it and its person is a member there now. A
 * read-only credential is offered only the reading tools, so a write it names
 * anyway is an unknown tool; the read-only gate below still stands behind that.
 * Every call in a workspace writes one audit row there, reads and refusals
 * included: at once for a call refused here, and once the tool answers for a
 * call that runs. The routing table reads only the caller's own memberships.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isMutating, type ToolName } from "@stuga/agent-surface/catalog";
import { buildInstructions } from "@stuga/agent-surface/instructions";
import { registerAgentTools, type AgentSurface, type Reach, type ToolCall } from "@stuga/agent-surface/register";
import type { AuditStatus } from "@stuga/protocol/domain/audit";
import { MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";
import { getWorkspace, listWorkspacesForUser } from "@stuga/db";
import { recordAudit } from "../audit/record.js";
import { mcpPerson, workspaceContextFor, type McpCaller } from "../auth/context.js";
import { READ_ONLY_MESSAGE } from "../authz/authz.js";
import { VERSION } from "../version.js";
import { nodeBackend } from "./backend.js";

/** Identical for unknown, revoked, out-of-scope and not-a-member, so a credential cannot probe which ids exist. */
export const WORKSPACE_UNAVAILABLE_MESSAGE = "workspace is not available to this connector";

/** Audit verbs for tools that take no `action`. */
const DEFAULT_ACTION: Record<ToolName, string> = {
  workspaces: "list",
  docs: "list",
  search: "search",
  markdown: "read",
  comments: "list",
  folders: "list",
  events: "poll",
  collections: "list",
  retrieve: "retrieve",
  databases: "list",
  query: "select",
  docs_create: "create",
  markdown_append: "append",
  markdown_edit: "write",
  comments_add: "add",
  media_upload: "upload",
  collections_edit: "change",
  databases_add: "add",
  databases_change: "change",
};

function auditTarget(args: Record<string, unknown>): { targetKind: string; targetId: string } | null {
  if (typeof args.doc_id === "string" && args.doc_id) return { targetKind: "doc", targetId: args.doc_id };
  if (typeof args.database_id === "string" && args.database_id) return { targetKind: "database", targetId: args.database_id };
  if (typeof args.collection_id === "string" && args.collection_id) return { targetKind: "collection", targetId: args.collection_id };
  return null;
}

/**
 * Every workspace the credential reaches on this node: its person's memberships, narrowed to the ones it was
 * given, and for an agent never one where its person is only a guest (workspaceContextFor refuses those).
 */
async function reachOf(caller: McpCaller): Promise<Reach> {
  const { env } = caller.account;
  const node = { id: env.nodeId, name: env.settings.current().nodeLabel, origin: env.publicOrigin };
  const rows = await listWorkspacesForUser(caller.account.sql, mcpPerson(caller));
  const allowed = caller.workspaces ? new Set(caller.workspaces) : null;
  return {
    workspaces: rows
      .filter((w) => !allowed || allowed.has(w.workspace_id))
      .filter((w) => !caller.account.isAgent || w.role !== "guest")
      .map((w) => ({ workspace_id: w.workspace_id, name: w.name, role: w.role, access: caller.readOnly ? "read" : "propose", node })),
    unavailable: [],
  };
}

/** The tools' view of this node for one request: its routing table, and a backend per workspace a call names. */
export function nodeSurface(caller: McpCaller): AgentSurface {
  let reach: Promise<Reach> | null = null;
  return {
    reach: () => (reach ??= reachOf(caller)),
    async backendFor({ tool, action, workspaceId, args }: ToolCall) {
      const ctx = await workspaceContextFor(caller, workspaceId);
      // A refused call is the action it attempted, marked denied, so a filter on the tool finds refusals too.
      const audit = (status: AuditStatus) =>
        recordAudit({ ...caller.account, workspaceId: ctx?.workspaceId }, { action: `mcp.${tool}.${action ?? DEFAULT_ACTION[tool]}`, ...auditTarget(args), status });
      if (!ctx) {
        audit("denied");
        return { error: WORKSPACE_UNAVAILABLE_MESSAGE };
      }
      if (ctx.scope?.readOnly && isMutating(tool)) {
        audit("denied");
        return { error: READ_ONLY_MESSAGE };
      }
      // A backend that answers with the read-only refusal was a denied write, recorded as one.
      return { backend: nodeBackend(ctx), settled: (refusal: string | null) => audit(refusal === READ_ONLY_MESSAGE ? "denied" : "ok") };
    },
  };
}

async function buildMcpServer(caller: McpCaller, surface: AgentSurface): Promise<McpServer> {
  const { env, sql } = caller.account;
  const { workspaces } = await surface.reach();
  // One workspace's conventions travel with the connection; with several, each is read before writing there.
  const only = workspaces.length === 1 ? await getWorkspace(sql, workspaces[0]!.workspace_id).catch(() => null) : null;
  const instructions = buildInstructions({
    node: { name: env.settings.current().nodeLabel, origin: env.publicOrigin },
    workspaces,
    conventions: only?.agent_instructions ?? "",
    readOnly: caller.readOnly,
  });
  // One name for the product. Which node this is, and which workspaces it reaches, are in the instructions and in
  // `workspaces` action:list, where the model can act on them.
  const server = new McpServer({ name: "stuga", title: MCP_SERVER_TITLE, version: VERSION }, { instructions, capabilities: { tools: {} } });
  registerAgentTools(server, surface, { readOnly: caller.readOnly });
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
export async function handleMcpRequest(caller: McpCaller, req: Request): Promise<Response> {
  if (!MCP_METHODS.has(req.method)) {
    return new Response(null, { status: 405, headers: { allow: [...MCP_METHODS].join(", ") } });
  }
  const server = await buildMcpServer(caller, nodeSurface(caller));
  // The listener already held the body to the node's ceiling. The SDK's own 4 MiB default sits
  // under an inline image at the `media_upload` cap, and would refuse it before the tool could name its limit.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: caller.account.env.settings.current().maxBodyBytes,
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
