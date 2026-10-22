/**
 * The tools and prompts the server lists while the node cannot be reached or the sign-in waits, so
 * a client that lists once at launch, as Claude Desktop does, still has Save to Stuga when the
 * office machine wakes up later. A call made meanwhile answers why nothing happened, and the
 * list-changed notice brings the node's own lists.
 *
 * They are the node's last lists for this connection, kept per node address (and per key, when one
 * is sent) in `catalog.json` beside `oauth.json`, so a read-only grant or an older node is offered
 * what it offered. Before the node has ever answered, they are this build's own lists, with every
 * write tool and both prompts: a grant that turns out to be read-only is refused the writes by the
 * node, and the list-changed notice then brings its own lists.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { registerAgentTools, type AgentSurface, type ToolServer } from "@stuga/agent-surface/register";
import type { ResolvedConfig } from "./config.js";

export interface OfflineCatalog {
  tools: Tool[];
  prompts: Prompt[];
}

export const NO_CATALOG: OfflineCatalog = { tools: [], prompts: [] };

/** Listed through the SDK itself, so each schema is exactly what a node of this version would send. */
export async function offlineCatalog(): Promise<OfflineCatalog> {
  const server = new McpServer({ name: "stuga-offline", version: "0" });
  // Listing never reaches a workspace; a call while offline is answered before it would.
  registerAgentTools(server as unknown as ToolServer, {} as AgentSurface, { readOnly: false });
  const client = new Client({ name: "stuga-offline", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const [{ tools }, { prompts }] = await Promise.all([client.listTools(), client.listPrompts()]);
    return { tools, prompts };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** One connection's kept lists: what the node last listed, either list absent until it has. */
export interface KeptLists {
  read(): Partial<OfflineCatalog>;
  /** Keep what the node just listed; best-effort, never throws. */
  save(lists: Partial<OfflineCatalog>): void;
}

/** What a connection's lists are kept under: the node's address, and a digest of the key when one is sent. */
export function catalogKey(config: Pick<ResolvedConfig, "url" | "token">): string {
  if (!config.token) return config.url;
  return `${config.url} key:${createHash("sha256").update(config.token).digest("hex").slice(0, 16)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A kept list as written, or undefined when it is not one: a damaged file costs the list, not the server. */
function toolsOf(value: unknown): Tool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((t) => isRecord(t) && typeof t.name === "string" && isRecord(t.inputSchema)) ? (value as Tool[]) : undefined;
}

function promptsOf(value: unknown): Prompt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((p) => isRecord(p) && typeof p.name === "string") ? (value as Prompt[]) : undefined;
}

/** The node's last tools and prompts lists, per connection, in a JSON file readable by this user alone. */
export class CatalogFile {
  constructor(private readonly path: string) {}

  read(key: string): Partial<OfflineCatalog> {
    const entry = this.all()[key];
    if (!isRecord(entry)) return {};
    const tools = toolsOf(entry.tools);
    const prompts = promptsOf(entry.prompts);
    return { ...(tools ? { tools } : {}), ...(prompts ? { prompts } : {}) };
  }

  save(key: string, lists: Partial<OfflineCatalog>): void {
    try {
      const all = this.all();
      const current = isRecord(all[key]) ? all[key] : {};
      const next = { ...current, ...lists };
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      all[key] = next;
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Written aside and renamed over, so a crash never leaves half a file, and created private.
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
    } catch {
      // A list not kept is listed from this build next time; nothing else depends on it.
    }
  }

  /** One connection's lists. */
  forKey(key: string): KeptLists {
    return { read: () => this.read(key), save: (lists) => this.save(key, lists) };
  }

  private all(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

/** Nothing kept: for a server that has no file to keep lists in, and for tests. */
export const KEEP_NOTHING: KeptLists = { read: () => ({}), save: () => undefined };
