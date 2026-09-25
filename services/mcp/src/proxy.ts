/**
 * The stdio server a desktop client launches: a proxy to the node's /mcp, so the
 * tools, their wording and every gate are the node's own, whatever its version.
 * It adds the one thing only a process on the person's machine can do: an import
 * from a file on that machine.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { renderHandOff } from "@stuga/agent-surface/render/databases";
import { DATABASE_IMPORT_FORMATS, type DatabaseImportFormat } from "@stuga/protocol/databases/types";
import { MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";
import type { ResolvedConfig } from "./config.js";
import type { NodeIdentity } from "./node.js";
import type { Upstream, UpstreamClient } from "./upstream.js";

/** A client gives up on a request after about a minute; answer before it does. */
export const CLIENT_PATIENCE_MS = 50_000;

const FILE_PARAM = {
  type: "string",
  maxLength: 4096,
  description:
    "With action:import — a CSV/JSONL path on the USER'S machine, where this server runs; it uploads the file for you. " +
    "A path in your own sandbox is not visible here: pass the file's text in `content` instead.",
};

const FILE_NOTE =
  " This server runs on the user's machine: action:import also takes `file`, a CSV/JSONL path there, and uploads it " +
  "whole — prefer it to `content` for a file on that machine.";

export interface ProxyDeps {
  config: ResolvedConfig;
  node: NodeIdentity;
  upstream: Pick<Upstream, "ready" | "reset" | "state">;
  /** Instructions from the node, when it answered before the client asked. */
  instructions?: string;
  fetch?: typeof globalThis.fetch;
  readFile?: (path: string) => Promise<Uint8Array>;
  patienceMs?: number;
}

/** What the client reads while this server has not reached the node yet. */
export function waitingInstructions(node: NodeIdentity): string {
  return (
    "ROUTING: If the user mentions Stuga or asks for a document, note, folder, database, collection, or workspace " +
    "knowledge, use this connection's tools before saying you lack access.\n\n" +
    `This connection is to the Stuga node ${JSON.stringify(node.name)} at ${node.origin}. It is still connecting: if ` +
    "no Stuga tools are listed, the person may need to approve the sign-in page that opened in their browser; the " +
    "tools appear once they do. `workspaces` action:list names every workspace you can reach once connected."
  );
}

/** The import format a file path implies, unless the caller named one. */
export function formatForFile(path: string, explicit: unknown): DatabaseImportFormat | { error: string } {
  if (typeof explicit === "string" && (DATABASE_IMPORT_FORMATS as readonly string[]).includes(explicit)) return explicit as DatabaseImportFormat;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === "jsonl" || ext === "ndjson" || ext === "json") return "jsonl";
  if (ext === "csv" || ext === "tsv" || ext === "txt" || ext === undefined) return "csv";
  return { error: `cannot tell the format of "${path}" — pass format: ${DATABASE_IMPORT_FORMATS.join(" | ")}` };
}

/** The node's tools, with `file` offered on the import that can use it. */
export function withLocalFiles(tools: Tool[]): Tool[] {
  return tools.map((tool) =>
    tool.name === "databases_add"
      ? {
          ...tool,
          description: `${tool.description ?? ""}${FILE_NOTE}`,
          inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, file: FILE_PARAM } },
        }
      : tool,
  );
}

const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text: `error: ${text}` }], isError: true });

const firstText = (result: CallToolResult): string => {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
};

/** Resolve within `ms`, or null. */
export async function within<T>(pending: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  try {
    return await Promise.race([pending, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildProxy({
  config,
  node,
  upstream,
  instructions,
  fetch = globalThis.fetch,
  readFile = (p) => fsReadFile(p),
  patienceMs = CLIENT_PATIENCE_MS,
}: ProxyDeps): Server {
  const server = new Server(
    { name: "stuga", title: MCP_SERVER_TITLE, version: config.version },
    { capabilities: { tools: { listChanged: true } }, instructions: instructions ?? waitingInstructions(node) },
  );

  /** The node, or why it is not there yet, in words for the model. */
  async function reach(): Promise<UpstreamClient | string> {
    const client = await within(upstream.ready(), patienceMs).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (client !== null) return client;
    return upstream.state === "signing-in"
      ? `Stuga is waiting for the person to approve the sign-in page for ${node.origin} in their browser; ask them to, then try again`
      : `still connecting to the Stuga node at ${node.origin}; try again shortly`;
  }

  /** A call the node did not answer, in words for the model. */
  function lost(error: unknown): string {
    return `cannot reach the Stuga node at ${node.origin}: ${error instanceof Error ? error.message : String(error)}`;
  }

  /**
   * One call, and once more after a sign-in when the node stopped accepting the old one: the SDK has
   * already opened the consent page, and the reconnect waits for that answer within the client's patience.
   */
  async function once<T>(run: (client: UpstreamClient) => Promise<T>): Promise<T | string> {
    const client = await reach();
    if (typeof client === "string") return client;
    try {
      return await run(client);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) return lost(error);
      upstream.reset();
      const again = await reach();
      if (typeof again === "string") return again;
      try {
        return await run(again);
      } catch (retry) {
        return lost(retry);
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    const listed = await once((client) => client.listTools());
    // No tools yet; the list-changed notice brings them once the node answers.
    return typeof listed === "string" ? { tools: [] } : { tools: withLocalFiles(listed.tools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params;
    const answered = await once(async (client) =>
      name === "databases_add" && typeof args.file === "string"
        ? importFile(client, args)
        : ((await client.callTool({ name, arguments: args })) as CallToolResult),
    );
    return typeof answered === "string" ? failure(answered) : answered;
  });

  /** Stage the import on the node, upload the file to the signed URL it hands back, and commit it. */
  async function importFile(client: UpstreamClient, args: Record<string, unknown>): Promise<CallToolResult> {
    const { file, content: _content, ...rest } = args;
    const path = file as string;
    if (rest.action !== "import") return failure("`file` goes with action:import");
    if (_content !== undefined || rest.import_id !== undefined) return failure("import takes one of `file`, `content` or `import_id`");
    const format = formatForFile(path, rest.format);
    if (typeof format !== "string") return failure(format.error);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (e) {
      return failure(
        `could not read ${path}: ${(e as Error).message}. This server runs on the user's machine and reads only its disk, ` +
          "so a path in your own sandbox is not visible here — pass the file's text in `content` instead.",
      );
    }
    if (bytes.byteLength === 0) return failure(`${path} is empty`);

    const { action: _action, column_map, on_error, max_bad_rows, date_order, dry_run, ...where } = rest;
    const staged = (await client.callTool({ name: "databases_add", arguments: { ...where, action: "start_import", format } })) as CallToolResult;
    if (staged.isError) return staged;
    const ticket = JSON.parse(firstText(staged)) as { import_id: string; upload_path: string; max_bytes: number; import_page_url: string };
    const handOff = (why: string): CallToolResult => failure(renderHandOff(ticket.import_page_url, why));
    if (bytes.byteLength > ticket.max_bytes) return handOff(`That file is ${bytes.byteLength} bytes; this node accepts imports up to ${ticket.max_bytes}.`);
    // The signed path is the whole credential, and this process reaches the node at its own URL, not the public one.
    const put = await fetch(new URL(ticket.upload_path, config.url), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([bytes.slice().buffer as ArrayBuffer]),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as const);
    if (!put.ok) return handOff(`The upload was refused (${put.status}): ${(await put.text().catch(() => "")).slice(0, 300)}.`);
    const options = Object.fromEntries(Object.entries({ column_map, on_error, max_bad_rows, date_order, dry_run }).filter(([, v]) => v !== undefined));
    return (await client.callTool({
      name: "databases_add",
      arguments: { workspace_id: where.workspace_id, database_id: where.database_id, action: "import", import_id: ticket.import_id, ...options },
    })) as CallToolResult;
  }

  return server;
}
