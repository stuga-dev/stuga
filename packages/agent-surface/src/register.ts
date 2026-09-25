/**
 * Registers the agent tools on an MCP server. A call names the workspace it acts
 * in, and the surface answers with that workspace's backend, so the same tools
 * run whether every workspace is on this node or some are on others.
 */
import type { z } from "zod";
import type {
  DatabaseColumnType,
  DatabaseImportFormat,
  DatabaseViewKind,
  RowInputValue,
  TableSchema,
} from "@stuga/protocol/databases/types";
import { selectOnlyViolation } from "@stuga/protocol/databases/sql-guard";
import { isWorkspaceEventType } from "@stuga/protocol/domain/events";
import {
  isRefusal,
  type AgentBackend,
  type ColumnSpecInput,
  type DatabaseMutation,
  type ImportSource,
  type ProposeInput,
  type Refusal,
  type RetrieveBody,
  type SearchBody,
  type ViewShape,
} from "./backend.js";
import {
  ALL_WORKSPACES,
  MCP_CONTRACT_VERSION,
  SEARCH_MAX_WORKSPACES,
  READ_TOOLS,
  TOOL_NAMES,
  toolDefinition,
  type ToolAnnotations,
  type ToolName,
} from "./catalog.js";
import { normalizeQueryParams, resolveTable, resolveView } from "./resolve.js";
import {
  bulkSteer,
  renderCreatedDatabase,
  renderDatabasePropose,
  renderDatabaseStatus,
  renderHandOff,
  renderImportCommit,
  renderOpenPage,
} from "./render/databases.js";
import { instructionFields, renderPropose, renderProvenance, renderRead, renderStatus } from "./render/docs.js";
import { renderUpload } from "./render/media.js";
import {
  RETRIEVE_AI_DISABLED_MESSAGE,
  renderPassages,
  renderSearch,
  type UnavailableWorkspace,
  type WorkspacePart,
} from "./render/search.js";

/** A type alias, not an interface: the MCP SDK's result type needs an implicit index signature. */
export type ToolText = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ERROR_PREFIX = "error: ";
const ok = (text: string): ToolText => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolText => ({ content: [{ type: "text", text: `${ERROR_PREFIX}${text}` }], isError: true });

/** The slice of an MCP server this module needs. */
export interface ToolServer {
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: ToolAnnotations & { title: string } },
    cb: (args: Record<string, unknown>) => Promise<ToolText>,
  ): unknown;
}

/** One row of the routing table: a workspace, and the node it is on. */
export interface WorkspaceRoute {
  workspace_id: string;
  name: string;
  role: string;
  /** What this connection may do there: `read`, or `propose` changes. */
  access: "read" | "propose";
  node: { id: string; name: string; origin: string };
}

export interface Reach {
  workspaces: WorkspaceRoute[];
  /** Workspaces the connection has but could not reach just now; empty while every one is on this node. */
  unavailable: UnavailableWorkspace[];
}

/** One tool call in one workspace. */
export interface ToolCall {
  tool: ToolName;
  action: string | undefined;
  workspaceId: string;
  args: Record<string, unknown>;
}

/** The backend one call runs against, and what hears the call's refusal (null when it answered) once the tool is done. */
export interface CallBackend {
  backend: AgentBackend;
  settled(refusal: string | null): void;
}

/** Everything a connection reaches, and the backend for one call in one of its workspaces. */
export interface AgentSurface {
  /** The routing table: every workspace this connection reaches, and the node each is on. */
  reach(): Promise<Reach>;
  /** The backend one call runs against, or the refusal, before any tool logic runs. */
  backendFor(call: ToolCall): Promise<CallBackend | Refusal>;
}

export interface RegisterOptions {
  /** A read-only credential is offered the reading tools only. */
  readOnly: boolean;
}

export function registerAgentTools(server: ToolServer, surface: AgentSurface, { readOnly }: RegisterOptions): void {
  for (const tool of readOnly ? READ_TOOLS : TOOL_NAMES) {
    const def = toolDefinition(tool);
    const config = { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: { title: def.title, ...def.annotations } };
    server.registerTool(tool, config, async (args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action : undefined;
      if (tool === "search" || tool === "retrieve") return acrossWorkspaces(tool, args, surface);
      if (tool === "workspaces" && action === "list") return listWorkspaces(surface);
      const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
      if (!workspaceId) return err("this call needs a `workspace_id` — `workspaces` action:list names the ones you can use");
      const resolved = await surface.backendFor({ tool, action, workspaceId, args });
      if (isRefusal(resolved)) return err(resolved.error);
      let refusal: string | null = null;
      try {
        const result = await HANDLERS[tool](args as never, resolved.backend);
        if (result.isError) refusal = result.content[0]!.text.slice(ERROR_PREFIX.length);
        return result;
      } finally {
        resolved.settled(refusal);
      }
    });
  }
}

async function listWorkspaces(surface: AgentSurface): Promise<ToolText> {
  const { workspaces, unavailable } = await surface.reach();
  return ok(JSON.stringify({ contract: MCP_CONTRACT_VERSION, workspaces, unavailable }));
}

interface AcrossArgs {
  workspace_ids: string[];
  q: string;
  collection_id?: string;
  limit?: number;
}

/**
 * Search or retrieval over several workspaces: each runs in its own workspace,
 * and the answers merge in rank order. One the call could not cover is reported
 * under `unavailable`; when it was the only one, its refusal is the answer.
 */
async function acrossWorkspaces(tool: "search" | "retrieve", raw: Record<string, unknown>, surface: AgentSurface): Promise<ToolText> {
  const args = raw as unknown as AcrossArgs;
  const q = args.q.trim();
  if (!q) return err(`${tool} requires \`q\``);
  const everywhere = args.workspace_ids.includes(ALL_WORKSPACES);
  const reach = everywhere ? await surface.reach() : null;
  const named = reach ? reach.workspaces.map((w) => w.workspace_id) : [...new Set(args.workspace_ids.map((id) => id.trim()).filter(Boolean))];
  // ["*"] obeys the same ceiling as a list: the rest are reported, never silently left out.
  const ids = named.slice(0, SEARCH_MAX_WORKSPACES);
  const uncovered = named.slice(SEARCH_MAX_WORKSPACES).map((workspace_id) => ({
    workspace_id,
    reason: `not searched: one call covers at most ${SEARCH_MAX_WORKSPACES} workspaces; name the ones you need in \`workspace_ids\``,
  }));
  if (args.collection_id && ids.length !== 1) {
    return err("`collection_id` narrows one workspace's search: pass exactly that workspace in `workspace_ids`");
  }
  const query = { q, collection_id: args.collection_id, limit: args.limit };

  const outcomes = await Promise.all(
    ids.map(async (workspaceId): Promise<{ workspaceId: string; origin: string; body: SearchBody | RetrieveBody } | { workspaceId: string; refusal: string }> => {
      const resolved = await surface.backendFor({ tool, action: undefined, workspaceId, args: raw });
      if (isRefusal(resolved)) return { workspaceId, refusal: resolved.error };
      let refusal: string | null = null;
      try {
        const body = tool === "search" ? await resolved.backend.searchDocs(query) : await resolved.backend.retrieve(query);
        if (isRefusal(body)) {
          refusal = body.error;
          return { workspaceId, refusal };
        }
        // Embeddings are a node's setting: say so, or an empty list reads as "nothing matched" and the agent rephrases forever.
        if ("ai_disabled" in body && body.ai_disabled) return { workspaceId, refusal: RETRIEVE_AI_DISABLED_MESSAGE };
        return { workspaceId, origin: resolved.backend.origin, body };
      } finally {
        resolved.settled(refusal);
      }
    }),
  );

  const unavailable: UnavailableWorkspace[] = [
    ...(reach?.unavailable ?? []),
    ...outcomes.flatMap((o) => ("refusal" in o ? [{ workspace_id: o.workspaceId, reason: o.refusal }] : [])),
    ...uncovered,
  ];
  const parts = outcomes.flatMap((o) => ("body" in o ? [{ workspace_id: o.workspaceId, origin: o.origin, body: o.body }] : []));
  if (parts.length === 0 && ids.length === 1 && !reach) return err(unavailable[0]!.reason);
  if (parts.length === 0 && unavailable.length > 0 && unavailable.every((u) => u.reason === RETRIEVE_AI_DISABLED_MESSAGE)) {
    return err(RETRIEVE_AI_DISABLED_MESSAGE);
  }
  return ok(
    tool === "search"
      ? renderSearch(q, parts as Array<WorkspacePart<SearchBody>>, unavailable, args.limit)
      : renderPassages(parts as Array<WorkspacePart<RetrieveBody>>, unavailable, args.limit),
  );
}

async function answer<T>(pending: Promise<T | Refusal>, render: (value: T) => string): Promise<ToolText> {
  const value = await pending;
  return isRefusal(value) ? err(value.error) : ok(render(value));
}

const json = (value: unknown): string => JSON.stringify(value);

interface MarkdownEditArgs extends Omit<ProposeInput, "action" | "citations"> {
  doc_id: string;
  action: "write" | "str_replace" | "cited_edits";
  citations?: Array<{ n: number; doc_id: string; title: string; heading_path?: string | null; content?: string }>;
}

interface MediaArgs {
  doc_id: string;
  action: "upload" | "upload_from_url";
  data?: string;
  url?: string;
  alt?: string;
  caption?: string;
}

interface DatabasesArgs {
  action: string;
  database_id?: string;
  title?: string;
  table?: string;
  name?: string;
  type?: DatabaseColumnType;
  choices?: string[];
  /** add_column: what the column holds. */
  description?: string;
  columns?: ColumnSpecInput[];
  format?: DatabaseImportFormat;
  import_id?: string;
  column_map?: Record<string, string | null>;
  on_error?: "abort" | "skip_bad_rows";
  max_bad_rows?: number;
  date_order?: "mdy" | "dmy";
  dry_run?: boolean;
  content?: string;
  rows?: Array<Record<string, RowInputValue>>;
  updates?: Array<{ _id: string; values: Record<string, RowInputValue> }>;
  row_ids?: string[];
  row_id?: string;
  view?: string;
  filter?: unknown;
  sorts?: Array<{ column_id: string; dir?: "asc" | "desc" }>;
  group_by?: string | null;
  hidden_columns?: string[];
  kind?: DatabaseViewKind;
}

interface CollectionsEditArgs {
  action: "create" | "rename" | "delete" | "add_items" | "remove_items";
  collection_id?: string;
  name?: string;
  doc_ids?: string[];
  folder_ids?: string[];
}

type Handler = (args: never, backend: AgentBackend) => Promise<ToolText>;

/** Every single-workspace tool; `search` and `retrieve` span workspaces and never reach this table. */
const HANDLERS: Record<Exclude<ToolName, "search" | "retrieve">, Handler> = {
  workspaces: (async (_args: { action: "instructions" }, b: AgentBackend) => answer(b.workspaceInstructions(), json)),

  docs: (async ({ action, doc_id, parent_id }: { action: "list" | "metadata"; doc_id?: string; parent_id?: string | null }, b: AgentBackend) => {
    if (action === "list") {
      return answer(b.listDocs(parent_id), (docs) =>
        // doc_type sends the agent to `markdown` or to `databases`; a database read as prose dead-ends the loop.
        json({ docs: docs.map((d) => ({ doc_id: d.doc_id, title: d.title, doc_type: d.doc_type, parent_id: d.parent_id, updated_at: d.updated_at })) }),
      );
    }
    if (!doc_id) return err("metadata requires `doc_id`");
    return answer(b.docMetadata(doc_id), json);
  }),

  docs_create: (async ({ title, parent_id }: { title: string; parent_id?: string }, b: AgentBackend) =>
    answer(b.createDoc({ title, ...(parent_id ? { parent_id } : {}) }), (d) => json({ doc_id: d.doc_id, title: d.title, ...instructionFields(d) }))),

  markdown: (async ({ doc_id, action }: { doc_id: string; action: "read" | "status" | "provenance" }, b: AgentBackend) => {
    if (action === "read") return answer(b.readMarkdown(doc_id), renderRead);
    if (action === "status") return answer(b.docRuns(doc_id), renderStatus);
    return answer(b.provenance(doc_id), renderProvenance);
  }),

  markdown_append: (async ({ doc_id, text, heading }: { doc_id: string; text: string; heading?: string }, b: AgentBackend) =>
    answer(b.propose(doc_id, { action: "append", text, heading }), renderPropose)),

  markdown_edit: (async ({ doc_id, action, text, find, replace, replace_all, edits, citations }: MarkdownEditArgs, b: AgentBackend) => {
    if (action === "write" && text == null) return err("write requires `text`");
    if (action === "str_replace" && !find) return err("str_replace requires a non-empty `find`");
    if (action === "cited_edits" && !edits?.length) return err("cited_edits requires a non-empty `edits` array");
    return answer(
      b.propose(doc_id, {
        action,
        text,
        find,
        replace,
        replace_all,
        edits,
        citations: citations?.map((c) => ({ ...c, heading_path: c.heading_path ?? null, content: c.content ?? "" })),
      }),
      renderPropose,
    );
  }),

  media_upload: (async ({ doc_id, action, data, url, alt, caption }: MediaArgs, b: AgentBackend) => {
    if (action === "upload" && !data) return err("upload requires base64 image bytes in `data`");
    if (action === "upload_from_url" && !url) return err("upload_from_url requires `url`");
    const source = action === "upload" ? { kind: "data" as const, data: data! } : { kind: "url" as const, url: url! };
    return answer(b.uploadImage(doc_id, source), (stored) => renderUpload(stored, alt, caption));
  }),

  comments: (async ({ doc_id }: { doc_id: string }, b: AgentBackend) => answer(b.listComments(doc_id), json)),

  comments_add: (async ({ doc_id, body }: { doc_id: string; body: string }, b: AgentBackend) => {
    const text = body.trim();
    if (!text) return err("comments_add requires `body`");
    return answer(b.addComment(doc_id, text), json);
  }),

  folders: (async (_args: unknown, b: AgentBackend) => answer(b.listFolders(), json)),

  events: (async ({ after, types, limit }: { after?: number; types?: string[]; limit?: number }, b: AgentBackend) => {
    for (const t of types ?? []) if (!isWorkspaceEventType(t)) return err(`unknown event type ${t}`);
    return answer(b.pollEvents({ after, types, limit }), json);
  }),

  collections: (async ({ action, collection_id }: { action: "list" | "open"; collection_id?: string }, b: AgentBackend) => {
    if (action === "list") {
      return answer(b.listCollections(), (rows) =>
        json({ collections: rows.map((c) => ({ collection_id: c.collection_id, name: c.name, item_count: c.item_count })) }),
      );
    }
    if (!collection_id) return err("open requires `collection_id`");
    return answer(b.openCollection(collection_id), ({ collection, items }) =>
      json({
        collection_id: collection.collection_id,
        name: collection.name,
        items: items.map((i) => (i.doc_id ? { doc_id: i.doc_id, title: i.title } : { folder_id: i.folder_id, title: i.title })),
      }),
    );
  }),

  collections_edit: collectionsEdit,

  databases: databasesRead,
  databases_add: databasesAdd,
  databases_change: databasesChange,

  query: (async ({ database_id, sql, params }: { database_id: string; sql: string; params?: Array<string | number | boolean | null> }, b: AgentBackend) => {
    const violation = selectOnlyViolation(sql);
    if (violation) return err(violation);
    return answer(b.query(database_id, sql, normalizeQueryParams(params)), json);
  }),
};

const collectionRef = (c: { collection_id: string; name: string }): string => json({ collection_id: c.collection_id, name: c.name });

async function collectionsEdit({ action, collection_id, name, doc_ids, folder_ids }: CollectionsEditArgs, b: AgentBackend): Promise<ToolText> {
  if (action === "create") {
    if (!name?.trim()) return err("create requires `name`");
    return answer(b.createCollection(name.trim()), collectionRef);
  }
  if (!collection_id) return err(`${action} requires \`collection_id\``);
  switch (action) {
    case "rename":
      if (!name?.trim()) return err("rename requires `name`");
      return answer(b.renameCollection(collection_id, name.trim()), collectionRef);
    case "delete":
      return answer(b.deleteCollection(collection_id), json);
    case "add_items":
    case "remove_items": {
      if (!doc_ids?.length && !folder_ids?.length) return err(`${action} requires \`doc_ids\` or \`folder_ids\``);
      const change = action === "add_items" ? "add" : "remove";
      return answer(b.changeCollectionItems(collection_id, change, { doc_ids: doc_ids ?? [], folder_ids: folder_ids ?? [] }), (res) =>
        json("skipped" in res && res.skipped > 0 ? { ...res, note: `${plural(res.skipped, "id")} skipped: not found, or not readable by this connector.` } : res),
      );
    }
  }
}

function viewShape(args: DatabasesArgs): ViewShape {
  return {
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.filter !== undefined ? { filter: args.filter } : {}),
    ...(args.sorts !== undefined ? { sorts: args.sorts } : {}),
    ...(args.group_by !== undefined ? { group_by: args.group_by } : {}),
    ...(args.hidden_columns !== undefined ? { hidden_columns: args.hidden_columns } : {}),
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The table an action names, against the caller's projection so a table it proposed moments ago resolves. */
async function tableOf(b: AgentBackend, databaseId: string, ref: string | undefined): Promise<TableSchema | Refusal> {
  // Only the table is wanted here: `schema` is the action that hands the stack over.
  const schema = await b.databaseSchema(databaseId, { instructions: false });
  if (isRefusal(schema)) return schema;
  const resolved = resolveTable(schema, ref);
  return "error" in resolved ? resolved : resolved.table;
}

async function databasesRead(args: DatabasesArgs, b: AgentBackend): Promise<ToolText> {
  const { action } = args;
  if (action === "list") {
    return answer(b.listDocs(undefined), (docs) =>
      json({
        databases: docs.filter((d) => d.doc_type === "database").map((d) => ({ database_id: d.doc_id, title: d.title, updated_at: d.updated_at })),
      }),
    );
  }
  const databaseId = args.database_id;
  if (!databaseId) return err(`${action} requires \`database_id\``);
  if (action === "schema") return answer(b.databaseSchema(databaseId), json);
  if (action === "status") return answer(b.databaseRuns(databaseId), renderDatabaseStatus);
  if (!args.row_id) return err("page requires `row_id` (a row's `_id`, from `query`)");
  const table = await tableOf(b, databaseId, args.table);
  if (isRefusal(table)) return err(table.error);
  return answer(b.findRowPage(databaseId, table.table_id, args.row_id), (page) =>
    json(
      page.doc_id
        ? { doc_id: page.doc_id, note: "Read and edit the page with `markdown` and `markdown_edit`, like any document." }
        : { doc_id: null, note: "This row has no page yet; `databases_add` action:open_page creates one." },
    ),
  );
}

async function databasesAdd(args: DatabasesArgs, b: AgentBackend): Promise<ToolText> {
  const { action } = args;
  if (action === "create_database") {
    const created = await b.createDoc({
      title: args.title ?? "",
      doc_type: "database",
      ...(args.table !== undefined ? { table: args.table } : {}),
      ...(args.columns !== undefined ? { columns: args.columns } : {}),
    });
    if (isRefusal(created)) return err(created.error);
    // The database exists now: a failed read-back must not read as a failed create, or the agent makes another.
    // The create already carried the stack, so the read-back needs only the tables.
    const schema = await b.databaseSchema(created.doc_id, { instructions: false }).catch(() => null);
    return ok(renderCreatedDatabase(created, schema === null || isRefusal(schema) ? null : schema));
  }

  const databaseId = args.database_id;
  if (!databaseId) return err(`${action} requires \`database_id\``);
  if (action === "create_table") {
    // An agent that just used `title` for create_database reaches for it again here.
    const display = args.name ?? args.title;
    if (!display) return err("create_table requires `name`");
    const columns = args.columns ?? [];
    return propose(
      b,
      databaseId,
      { action: "create_table", display, ...(columns.length > 0 ? { columns } : {}) },
      `created table "${display}"${columns.length > 0 ? ` with ${plural(columns.length, "column")}` : ""}.`,
    );
  }

  if (action === "import") {
    const given = [args.content, args.import_id].filter((v) => v !== undefined).length;
    if (given === 0) return err("import requires `content` (the file's text) or `import_id` to commit an upload the node holds");
    if (given > 1) return err("import takes `content` or `import_id`, not both");
    const source: ImportSource =
      args.import_id !== undefined
        ? { kind: "import_id", import_id: args.import_id }
        : { kind: "content", content: args.content!, ...(args.format ? { format: args.format } : {}) };
    // A retry names a staging the node already holds, and that staging knows its own table.
    let tableId: string | null = null;
    if (source.kind !== "import_id") {
      const table = await tableOf(b, databaseId, args.table);
      if (isRefusal(table)) return err(table.error);
      tableId = table.table_id;
    }
    const out = await b.importRows(databaseId, tableId, source, {
      column_map: args.column_map,
      on_error: args.on_error,
      max_bad_rows: args.max_bad_rows,
      date_order: args.date_order,
      dry_run: args.dry_run,
    });
    if (isRefusal(out)) return err(out.error);
    if ("hand_off" in out) return err(renderHandOff(out.hand_off.page_url, out.hand_off.why));
    const rendered = renderImportCommit(out.status, out.body, "content");
    return rendered.isError ? err(rendered.text) : ok(rendered.text);
  }

  const table = await tableOf(b, databaseId, args.table);
  if (isRefusal(table)) return err(table.error);
  const id = table.table_id;
  switch (action) {
    case "start_import":
      return answer(b.startImport(databaseId, id, args.format ?? "csv"), (upload) =>
        json({
          ...upload,
          next:
            `PUT the whole file's bytes to upload_url (for example: curl -T data.csv '${upload.upload_url}'), then call ` +
            `\`databases_add\` action:import with import_id: "${upload.import_id}". If you cannot send the file, give the ` +
            "user import_page_url instead and stop.",
        }),
      );
    case "add_column":
      if (!args.name || !args.type) return err("add_column requires `name` and `type`");
      return propose(
        b,
        databaseId,
        {
          action: "add_column",
          table_id: id,
          display: args.name,
          type: args.type,
          ...(args.choices ? { choices: args.choices } : {}),
          ...(args.description ? { description: args.description } : {}),
        },
        `added ${args.type} column "${args.name}" to ${table.name}.`,
      );
    case "insert_rows":
      if (!args.rows?.length) return err("insert_rows requires `rows` — for a whole file use action:import");
      return propose(b, databaseId, { action: "insert_rows", table_id: id, rows: args.rows }, `inserted ${args.rows.length} row(s) into ${table.name}.`, bulkSteer(args.rows.length));
    case "create_view":
      if (!args.name) return err("create_view requires `name`");
      return propose(b, databaseId, { action: "create_view", table_id: id, view: { name: args.name, ...viewShape(args) } }, `created view "${args.name}" on ${table.name}.`);
    case "open_page":
      if (!args.row_id) return err("open_page requires `row_id` (a row's `_id`, from `query`)");
      return answer(b.openRowPage(databaseId, id, args.row_id), renderOpenPage);
    default:
      return err(`unknown action ${action}`);
  }
}

async function databasesChange(args: DatabasesArgs, b: AgentBackend): Promise<ToolText> {
  const databaseId = args.database_id!;
  const table = await tableOf(b, databaseId, args.table);
  if (isRefusal(table)) return err(table.error);
  const id = table.table_id;
  switch (args.action) {
    case "update_rows":
      if (!args.updates?.length) return err("update_rows requires `updates`");
      return propose(b, databaseId, { action: "update_rows", table_id: id, updates: args.updates }, `updated ${args.updates.length} row(s) in ${table.name}.`);
    case "delete_rows":
      if (!args.row_ids?.length) return err("delete_rows requires `row_ids`");
      return propose(b, databaseId, { action: "delete_rows", table_id: id, row_ids: args.row_ids }, `deleted ${args.row_ids.length} row(s) from ${table.name}.`);
    case "update_view": {
      const hit = resolveView(table, args.view);
      if ("error" in hit) return err(hit.error);
      const changes = { ...(args.name ? { name: args.name } : {}), ...viewShape(args) };
      if (Object.keys(changes).length === 0) return err("update_view needs something to change: name, filter, sorts, group_by or hidden_columns");
      return propose(b, databaseId, { action: "update_view", table_id: id, view_id: hit.view.view_id, changes }, `changed view "${hit.view.name}" on ${table.name}.`);
    }
    default:
      return err(`unknown action ${args.action}`);
  }
}

function propose(b: AgentBackend, databaseId: string, mutation: DatabaseMutation, applied: string, note = ""): Promise<ToolText> {
  return answer(b.mutateDatabase(databaseId, mutation), (res) => renderDatabasePropose(res, applied, note));
}
