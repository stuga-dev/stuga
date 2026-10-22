/**
 * The stdio server a desktop client launches: a proxy to the node's /mcp, so the
 * tools, the prompts, their wording and every gate are the node's own, whatever
 * its version. It adds what only a process on the person's machine can do: read a
 * file on that machine, for an import or an upload, and list the node's last
 * tools and prompts (offline.ts) while the node is out of reach.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { renderHandOff } from "@stuga/agent-surface/render/databases";
import { DATABASE_IMPORT_FORMATS, type DatabaseImportFormat } from "@stuga/protocol/databases/types";
import { MCP_SERVER_TITLE } from "@stuga/protocol/domain/node-name";
import type { ResolvedConfig } from "./config.js";
import type { NodeIdentity } from "./node.js";
import { KEEP_NOTHING, NO_CATALOG, type KeptLists, type OfflineCatalog } from "./offline.js";
import type { Upstream, UpstreamClient } from "./upstream.js";

/** A client gives up on a request after about a minute; answer before it does. */
export const CLIENT_PATIENCE_MS = 50_000;
/**
 * How long a tools or prompts list waits for the node. Clients cancel a list well before a call
 * (Claude Desktop at 30 s), and a list is no reason to hold up on a sign-in: the node's last list
 * answers instead, and the list-changed notice brings its current one.
 */
export const LIST_PATIENCE_MS = 2_000;

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

const UPLOAD_FILE_PARAM = {
  type: "string",
  maxLength: 4096,
  description:
    "With action:upload — a path on the USER'S machine, where this server runs; it uploads the file for you, named " +
    "as the path names it unless you pass `name`. A path in your own sandbox is not visible here: send its bytes in " +
    "`data` instead.",
};

const UPLOAD_FILE_NOTE =
  " This server runs on the user's machine: action:upload also takes `file`, a path there, and uploads it whole — " +
  "prefer it to `data` for a file on that machine.";

export interface ProxyDeps {
  config: ResolvedConfig;
  node: NodeIdentity;
  upstream: Pick<Upstream, "ready" | "reset" | "state">;
  /** Instructions from the node, when it answered before the client asked. */
  instructions?: string;
  /** What this build offers: listed while the node is not there yet and has never listed its own. */
  offline?: OfflineCatalog;
  /** The node's last lists for this connection, listed while it is not there. */
  kept?: KeptLists;
  fetch?: typeof globalThis.fetch;
  readFile?: (path: string) => Promise<Uint8Array>;
  patienceMs?: number;
  listPatienceMs?: number;
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

/** The tools that read a local `file`: what each says about it. */
const LOCAL_FILES: Record<string, { param: typeof FILE_PARAM; note: string }> = {
  databases_add: { param: FILE_PARAM, note: FILE_NOTE },
  media_upload: { param: UPLOAD_FILE_PARAM, note: UPLOAD_FILE_NOTE },
};

/** The node's tools, with `file` offered on the import and the upload that can use it. */
export function withLocalFiles(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    const local = Object.hasOwn(LOCAL_FILES, tool.name) ? LOCAL_FILES[tool.name]! : null;
    return local
      ? {
          ...tool,
          description: `${tool.description ?? ""}${local.note}`,
          inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, file: local.param } },
        }
      : tool;
  });
}

/** A path's last segment: the name a file is uploaded under. */
const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

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

/** Why the node gave no answer, in words for the model: it could not be reached, or the sign-in waits. */
class Unreached {
  constructor(readonly why: string) {}
}

/**
 * Whether an error is the node's own answer, as opposed to a request that never reached it or got no
 * answer in time: the SDK raises the last two as McpErrors of its own codes.
 */
function nodeAnswered(error: unknown): error is McpError {
  return error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed;
}

/**
 * An error the client reads with this code and these words. The SDK sends a thrown error's `message` as
 * it is, and an McpError's carries "MCP error <code>:" already, which the client would add again.
 */
function answerError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

/** The node's error, raised to the client as the node gave it. */
function relay(error: McpError): Error {
  return answerError(error.code, error.message.replace(/^(?:MCP error -?\d+: )+/, ""), error.data);
}

export function buildProxy({
  config,
  node,
  upstream,
  instructions,
  offline = NO_CATALOG,
  kept = KEEP_NOTHING,
  fetch = globalThis.fetch,
  readFile = (p) => fsReadFile(p),
  patienceMs = CLIENT_PATIENCE_MS,
  listPatienceMs = LIST_PATIENCE_MS,
}: ProxyDeps): Server {
  const server = new Server(
    { name: "stuga", title: MCP_SERVER_TITLE, version: config.version },
    { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } }, instructions: instructions ?? waitingInstructions(node) },
  );

  /** The node, or why it is not there yet, in words for the model. */
  async function reach(wait: number): Promise<UpstreamClient | Unreached> {
    const client = await within(upstream.ready(), wait).catch((e: unknown) => new Unreached(e instanceof Error ? e.message : String(e)));
    if (client !== null) return client;
    return new Unreached(
      upstream.state === "signing-in"
        ? `Stuga is waiting for the person to approve the sign-in page for ${node.origin} in their browser; ask them to, then try again`
        : `still connecting to the Stuga node at ${node.origin}; try again shortly`,
    );
  }

  /** A request the node did not answer, in words for the model; the node's own error answer as it gave it. */
  function lost(error: unknown): Unreached | McpError {
    if (nodeAnswered(error)) return error;
    return new Unreached(`cannot reach the Stuga node at ${node.origin}: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * One request, and once more after a sign-in when the node stopped accepting the old one: the SDK has
   * already opened the consent page, and the reconnect waits for that answer within the client's patience.
   * Unreached when the node could not be asked or did not answer; the node's McpError when it answered with one.
   */
  async function once<T>(run: (client: UpstreamClient) => Promise<T>, wait = patienceMs): Promise<T | Unreached | McpError> {
    const client = await reach(wait);
    if (client instanceof Unreached) return client;
    try {
      return await run(client);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) return lost(error);
      upstream.reset();
      const again = await reach(wait);
      if (again instanceof Unreached) return again;
      try {
        return await run(again);
      } catch (retry) {
        return lost(retry);
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    const listed = await once((client) => client.listTools(), listPatienceMs);
    // Every node lists tools: an error is the node's own answer, passed on as it gave it.
    if (listed instanceof McpError) throw relay(listed);
    // The node's last list until it answers; the list-changed notice brings its current one.
    if (listed instanceof Unreached) return { tools: withLocalFiles(kept.read().tools ?? offline.tools) };
    kept.save({ tools: listed.tools });
    return { tools: withLocalFiles(listed.tools) };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (): Promise<ListPromptsResult> => {
    const listed = await once((client) => client.listPrompts(), listPatienceMs);
    if (listed instanceof Unreached) return { prompts: kept.read().prompts ?? offline.prompts };
    if (listed instanceof McpError) {
      // A node older than prompts has none, and is offered none while out of reach either.
      if (listed.code === ErrorCode.MethodNotFound) kept.save({ prompts: [] });
      return { prompts: [] };
    }
    kept.save({ prompts: listed.prompts });
    return { prompts: listed.prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
    const got = await once((client) => client.getPrompt(request.params));
    if (got instanceof McpError) throw relay(got);
    // A prompt has no error result: the client shows this message instead.
    if (got instanceof Unreached) throw answerError(ErrorCode.InternalError, got.why);
    return got;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params;
    const answered = await once(async (client) =>
      name === "databases_add" && typeof args.file === "string"
        ? importFile(client, args)
        : name === "media_upload" && typeof args.file === "string"
          ? uploadFile(client, args)
          : ((await client.callTool({ name, arguments: args })) as CallToolResult),
    );
    if (answered instanceof McpError) throw relay(answered);
    return answered instanceof Unreached ? failure(answered.why) : answered;
  });

  /** The bytes at `path` on this machine, or why they cannot be read, in words for the model. */
  async function local(path: string, instead: string): Promise<Uint8Array | CallToolResult> {
    try {
      const bytes = await readFile(path);
      return bytes.byteLength === 0 ? failure(`${path} is empty`) : bytes;
    } catch (e) {
      return failure(
        `could not read ${path}: ${(e as Error).message}. This server runs on the user's machine and reads only its disk, ` +
          `so a path in your own sandbox is not visible here — ${instead} instead.`,
      );
    }
  }

  /** PUT `bytes` to a staged path, which is the whole credential; this process reaches the node at its own URL, not the public one. */
  async function put(path: string, bytes: Uint8Array): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
    return fetch(new URL(path, config.url), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([bytes.slice().buffer as ArrayBuffer]),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as const);
  }

  /** Stage an upload on the node, send the file to the signed URL it hands back, and store it. */
  async function uploadFile(client: UpstreamClient, args: Record<string, unknown>): Promise<CallToolResult> {
    const { file, data: _data, upload_id: _uploadId, ...rest } = args;
    const path = file as string;
    if (rest.action !== "upload") return failure("`file` goes with action:upload");
    if (_data !== undefined || _uploadId !== undefined) return failure("upload takes one of `file`, `data` or `upload_id`");
    const bytes = await local(path, "send its bytes in `data`");
    if (!(bytes instanceof Uint8Array)) return bytes;
    const { action: _action, name, alt, caption, ...where } = rest;
    const staged = (await client.callTool({
      name: "media_upload",
      arguments: { ...where, action: "start_upload", name: typeof name === "string" && name ? name : baseName(path) },
    })) as CallToolResult;
    if (staged.isError) return staged;
    const ticket = JSON.parse(firstText(staged)) as { upload_id: string; upload_path: string; max_bytes: number };
    if (bytes.byteLength > ticket.max_bytes) return failure(`${path} is ${bytes.byteLength} bytes; this node takes files up to ${ticket.max_bytes}.`);
    const sent = await put(ticket.upload_path, bytes);
    if (!sent.ok) return failure(`The upload was refused (${sent.status}): ${(await sent.text().catch(() => "")).slice(0, 300)}.`);
    const options = Object.fromEntries(Object.entries({ alt, caption }).filter(([, v]) => v !== undefined));
    return (await client.callTool({
      name: "media_upload",
      arguments: { workspace_id: where.workspace_id, doc_id: where.doc_id, action: "upload", upload_id: ticket.upload_id, ...options },
    })) as CallToolResult;
  }

  /** Stage the import on the node, upload the file to the signed URL it hands back, and commit it. */
  async function importFile(client: UpstreamClient, args: Record<string, unknown>): Promise<CallToolResult> {
    const { file, content: _content, ...rest } = args;
    const path = file as string;
    if (rest.action !== "import") return failure("`file` goes with action:import");
    if (_content !== undefined || rest.import_id !== undefined) return failure("import takes one of `file`, `content` or `import_id`");
    const format = formatForFile(path, rest.format);
    if (typeof format !== "string") return failure(format.error);
    const bytes = await local(path, "pass the file's text in `content`");
    if (!(bytes instanceof Uint8Array)) return bytes;

    const { action: _action, column_map, on_error, max_bad_rows, date_order, dry_run, revises, ...where } = rest;
    const staged = (await client.callTool({ name: "databases_add", arguments: { ...where, action: "start_import", format } })) as CallToolResult;
    if (staged.isError) return staged;
    const ticket = JSON.parse(firstText(staged)) as { import_id: string; upload_path: string; max_bytes: number; import_page_url: string };
    const handOff = (why: string): CallToolResult => failure(renderHandOff(ticket.import_page_url, why));
    if (bytes.byteLength > ticket.max_bytes) return handOff(`That file is ${bytes.byteLength} bytes; this node accepts imports up to ${ticket.max_bytes}.`);
    const sent = await put(ticket.upload_path, bytes);
    if (!sent.ok) return handOff(`The upload was refused (${sent.status}): ${(await sent.text().catch(() => "")).slice(0, 300)}.`);
    const options = Object.fromEntries(Object.entries({ column_map, on_error, max_bad_rows, date_order, dry_run, revises }).filter(([, v]) => v !== undefined));
    return (await client.callTool({
      name: "databases_add",
      arguments: { workspace_id: where.workspace_id, database_id: where.database_id, action: "import", import_id: ticket.import_id, ...options },
    })) as CallToolResult;
  }

  return server;
}
