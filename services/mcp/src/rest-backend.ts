/** The agent tools' data access over the node's REST API. The node owns every gate, the run ledger and the audit trail. */
import {
  isRefusal,
  type AgentBackend,
  type Answer,
  type CollectionListing,
  type DatabaseMutation,
  type DocListing,
  type ImportOutcome,
} from "@stuga/agent-surface/backend";
import { DATABASE_IMPORT_INLINE_MAX_CHARS } from "@stuga/protocol/databases/limits";
import {
  DATABASE_IMPORT_FORMATS,
  type DatabaseImportFormat,
  type DatabaseImportTicket,
  type DatabaseRunSummary,
} from "@stuga/protocol/databases/types";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { ResolvedConfig } from "./config.js";
import { decodeImage } from "./media.js";
import type { NodeIdentity } from "./node.js";

export interface RestBackendDeps {
  config: ResolvedConfig;
  node: NodeIdentity;
  fetch: typeof globalThis.fetch;
  readFile: (path: string) => Promise<Uint8Array>;
}

/** Best-effort human-readable reason out of a non-2xx JSON (or text) body. */
export function errorMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    const reason = rec.error ?? rec.message;
    if (typeof reason === "string" && reason) return reason;
  }
  return `request failed (${status})`;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The import format a file path implies, unless the caller named one. */
export function formatForFile(path: string, explicit: DatabaseImportFormat | undefined): DatabaseImportFormat | { error: string } {
  if (explicit !== undefined) return explicit;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === "jsonl" || ext === "ndjson" || ext === "json") return "jsonl";
  if (ext === "csv" || ext === "tsv" || ext === "txt" || ext === undefined) return "csv";
  return { error: `cannot tell the format of "${path}" — pass format: ${DATABASE_IMPORT_FORMATS.join(" | ")}` };
}

export interface RestRequest {
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
}

/** The REST route that performs one database mutation. */
export function mutationRequest(databaseId: string, m: DatabaseMutation): RestRequest {
  const base = `/api/databases/${encodeURIComponent(databaseId)}`;
  if (m.action === "create_table") {
    return { path: `${base}/tables`, method: "POST", body: { display: m.display, ...(m.columns?.length ? { columns: m.columns } : {}) } };
  }
  const table = `${base}/tables/${encodeURIComponent(m.table_id)}`;
  switch (m.action) {
    case "add_column":
      return {
        path: `${table}/columns`,
        method: "POST",
        body: {
          display: m.display,
          type: m.type,
          ...(m.choices ? { choices: m.choices } : {}),
          ...(m.description ? { description: m.description } : {}),
        },
      };
    case "insert_rows":
      return { path: `${table}/rows`, method: "POST", body: { rows: m.rows } };
    case "update_rows":
      return { path: `${table}/rows`, method: "PATCH", body: { updates: m.updates } };
    case "delete_rows":
      // POST, not DELETE: the ids ride in the body.
      return { path: `${table}/rows/delete`, method: "POST", body: { row_ids: m.row_ids } };
    case "create_view":
      return { path: `${table}/views`, method: "POST", body: { ...m.view } };
    case "update_view":
      return { path: `${table}/views/${encodeURIComponent(m.view_id)}`, method: "PATCH", body: { ...m.changes } };
  }
}

export function restBackend({ config, node, fetch: fetchImpl, readFile }: RestBackendDeps): AgentBackend {
  async function request(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${config.token}`);
    // A hint the node honours only for a workspace this credential belongs to.
    if (config.workspace) headers.set("x-stuga-workspace", config.workspace);
    headers.set("x-stuga-client", config.client);
    if (config.model) headers.set("x-stuga-model", config.model);
    // Never on a FormData body: fetch writes the multipart content-type with its boundary.
    if (!headers.has("content-type") && !(init?.body instanceof FormData)) headers.set("content-type", "application/json");
    const res = await fetchImpl(`${config.url}${path}`, { ...init, headers });
    return { status: res.status, body: parseBody(await res.text()) };
  }

  async function call<T>(path: string, init?: RequestInit): Answer<T> {
    const { status, body } = await request(path, init);
    if (status < 200 || status >= 300) return { error: errorMessage(body, status) };
    return body as T;
  }

  async function field<T, K extends string>(path: string, key: K): Answer<T> {
    const res = await call<Record<K, T>>(path);
    return isRefusal(res) ? res : res[key];
  }

  const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
  const doc = (id: string) => `/api/docs/${encodeURIComponent(id)}`;
  const db = (id: string) => `/api/databases/${encodeURIComponent(id)}`;
  const collection = (id: string) => `/api/collections/${encodeURIComponent(id)}`;

  return {
    origin: config.url,

    async listWorkspaces() {
      const me = await call<{ workspace_id?: string; alias?: string; display_name?: string }>("/api/whoami");
      if (isRefusal(me)) return me;
      // An agent key is refused the workspace list; the workspace it acts in is then the whole answer.
      const all = await call<{ workspaces: Array<{ workspace_id: string; name: string; role: string }> }>("/api/workspaces");
      const rows = isRefusal(all) ? [] : all.workspaces;
      return {
        workspace_id: me.workspace_id,
        acting_as: me.display_name || me.alias,
        reachable: rows.length ? rows.map((w) => ({ workspace_id: w.workspace_id, name: w.name, role: w.role })) : undefined,
        note: "This connector is pinned to workspace_id above; point it elsewhere with STUGA_WORKSPACE (human token) or a key minted in that workspace.",
        node: { name: node.name, origin: node.origin },
      };
    },

    workspaceInstructions: () => call("/api/instructions"),

    // `?parent_id=` (empty) is how the node spells "the root".
    listDocs: (parentId) =>
      field<DocListing[], "docs">(`/api/docs${parentId === undefined ? "" : `?parent_id=${encodeURIComponent(parentId ?? "")}`}`, "docs"),

    searchDocs: (query) => call("/api/search", post(query)),
    docMetadata: (id) => call(doc(id)),
    createDoc: (input) => call("/api/docs", post(input)),
    readMarkdown: (id) => call(`${doc(id)}/markdown`),
    docRuns: (id) => field<AgentRunSummary[], "runs">(`${doc(id)}/runs`, "runs"),
    provenance: (id) => call(`${doc(id)}/provenance`),
    propose: (id, input) => call(`${doc(id)}/propose`, post(input)),

    async uploadImage(id, source) {
      if (source.kind !== "data") return { error: "upload_from_url is available on the node's /mcp endpoint only" };
      const image = decodeImage(source.data);
      if ("error" in image) return image;
      // The node's route reads the part's declared type, so the sniffed one rides on the Blob.
      const form = new FormData();
      form.append("file", new Blob([image.bytes], { type: image.mime }), "image");
      return call(`${doc(id)}/media`, { method: "POST", body: form });
    },

    listComments: (id) => call(`${doc(id)}/comments`),
    addComment: (id, body) => call(`${doc(id)}/comments`, post({ body })),
    listFolders: () => call("/api/folders"),

    async pollEvents({ after, types, limit }) {
      let start = after;
      if (start === undefined) {
        const head = await call<{ latest: number }>("/api/events?limit=1&after=0");
        if (isRefusal(head)) return head;
        start = head.latest;
      }
      const params = new URLSearchParams();
      if (types?.length) params.set("types", types.join(","));
      if (limit) params.set("limit", String(limit));
      params.set("after", String(start));
      return call(`/api/events?${params}`);
    },

    listCollections: () => field<CollectionListing[], "collections">("/api/collections", "collections"),
    openCollection: (id) => call(collection(id)),
    createCollection: (name) => call("/api/collections", post({ name })),
    renameCollection: (id, name) => call(collection(id), { method: "PATCH", body: JSON.stringify({ name }) }),
    deleteCollection: (id) => call(collection(id), { method: "DELETE" }),
    changeCollectionItems: (id, change, items) =>
      call(`${collection(id)}/items`, { method: change === "add" ? "POST" : "DELETE", body: JSON.stringify(items) }),
    retrieve: (query) => call("/api/retrieve", post(query)),
    databaseSchema: (id) => call(`${db(id)}/schema`),
    databaseRuns: (id) => field<DatabaseRunSummary[], "runs">(`${db(id)}/runs?limit=50`, "runs"),

    mutateDatabase(id, mutation) {
      const r = mutationRequest(id, mutation);
      return call(r.path, { method: r.method, body: JSON.stringify(r.body) });
    },

    openRowPage: (id, tableId, rowId) =>
      call(`${db(id)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}/page`, post({})),

    async importRows(id, tableId, source, options): Answer<ImportOutcome> {
      const commit = async (importId: string): Promise<ImportOutcome> => {
        const { status, body } = await request(`${db(id)}/imports/${encodeURIComponent(importId)}/commit`, post(options));
        return { status, body: (body ?? {}) as Record<string, unknown> };
      };
      if (source.kind === "import_id") return commit(source.import_id);

      const format = source.kind === "file" ? formatForFile(source.path, source.format) : (source.format ?? "csv");
      if (typeof format !== "string") return format;
      // Staged first: the ticket carries the link a hand-off gives the user.
      const ticket = await call<DatabaseImportTicket>(`${db(id)}/imports`, post({ table_id: tableId, format }));
      if (isRefusal(ticket)) return ticket;
      const handOff = (why: string): ImportOutcome => ({ hand_off: { page_url: ticket.import_page_url, why } });

      let bytes: Uint8Array;
      if (source.kind === "file") {
        try {
          bytes = await readFile(source.path);
        } catch (e) {
          return handOff(
            `Could not read ${source.path}: ${(e as Error).message}. This server runs on the user's machine and reads only its disk, ` +
              `so a path in your own sandbox is not visible here.`,
          );
        }
      } else {
        if (source.content.length > DATABASE_IMPORT_INLINE_MAX_CHARS) {
          return handOff(`That is ${source.content.length} characters, past the ${DATABASE_IMPORT_INLINE_MAX_CHARS} a tool call may carry.`);
        }
        bytes = new TextEncoder().encode(source.content);
      }
      if (bytes.byteLength === 0) return { error: `${source.kind === "file" ? source.path : "content"} is empty` };
      if (bytes.byteLength > ticket.max_bytes) {
        return handOff(`That file is ${bytes.byteLength} bytes; this node accepts imports up to ${ticket.max_bytes}.`);
      }
      // The signed path is the whole credential, and this process reaches the node at its own URL, not the public one.
      const put = await fetchImpl(`${config.url}${ticket.upload_path}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Blob([bytes.slice().buffer as ArrayBuffer]),
      });
      if (!put.ok) {
        const text = await put.text().catch(() => "");
        return handOff(`The upload was refused (${put.status}): ${errorMessage(parseBody(text), put.status)}.`);
      }
      return commit(ticket.import_id);
    },

    query: (id, sql, params) => call(`${db(id)}/query`, post({ sql, params })),
  };
}
