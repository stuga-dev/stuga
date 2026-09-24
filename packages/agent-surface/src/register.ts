/** Registers every tool on a server, so both MCP servers run the same argument checks and wording. */
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
  type ViewShape,
} from "./backend.js";
import { TOOL_NAMES, toolDefinition, type COLLECTIONS_ACTIONS, type ToolName, type Variant } from "./catalog.js";
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
import { RETRIEVE_AI_DISABLED_MESSAGE, renderPassages, renderSearch } from "./render/search.js";

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
    config: { title: string; description: string; inputSchema: z.ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<ToolText>,
  ): unknown;
}

export interface ToolCall {
  tool: ToolName;
  action: string | undefined;
  args: Record<string, unknown>;
}

/** The backend one call runs against, and what hears the call's refusal (null when it answered) once the tool is done. */
export interface CallBackend {
  backend: AgentBackend;
  settled(refusal: string | null): void;
}

/** Resolves the backend one call runs against, or refuses the call before any tool logic runs. */
export type BackendFor = (call: ToolCall) => Promise<CallBackend | Refusal>;

export function registerAgentTools(server: ToolServer, backend: AgentBackend | BackendFor, variant: Variant): void {
  const backendFor: BackendFor = typeof backend === "function" ? backend : async () => ({ backend, settled: () => {} });
  for (const tool of TOOL_NAMES) {
    server.registerTool(tool, toolDefinition(tool, variant), async (args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action : undefined;
      const resolved = await backendFor({ tool, action, args });
      if (isRefusal(resolved)) return err(resolved.error);
      let refusal: string | null = null;
      try {
        const result = await HANDLERS[tool](args as never, resolved.backend, variant);
        if (result.isError) refusal = result.content[0]!.text.slice(ERROR_PREFIX.length);
        return result;
      } finally {
        resolved.settled(refusal);
      }
    });
  }
}

async function answer<T>(pending: Promise<T | Refusal>, render: (value: T) => string): Promise<ToolText> {
  const value = await pending;
  return isRefusal(value) ? err(value.error) : ok(render(value));
}

const json = (value: unknown): string => JSON.stringify(value);

interface DocsArgs {
  action: "list" | "search" | "metadata" | "create";
  q?: string;
  doc_id?: string;
  title?: string;
  collection_id?: string;
  parent_id?: string | null;
  limit?: number;
}

interface MarkdownArgs extends Omit<ProposeInput, "action" | "citations"> {
  doc_id: string;
  action: "read" | "status" | "provenance" | ProposeInput["action"];
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
  file?: string;
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

interface CollectionsArgs {
  action: (typeof COLLECTIONS_ACTIONS)[number];
  collection_id?: string;
  name?: string;
  doc_ids?: string[];
  folder_ids?: string[];
}

type Handler = (args: never, backend: AgentBackend, variant: Variant) => Promise<ToolText>;

const HANDLERS: Record<ToolName, Handler> = {
  workspaces: (async ({ action }: { action: "list" | "instructions" }, b: AgentBackend) =>
    action === "instructions" ? answer(b.workspaceInstructions(), json) : answer(b.listWorkspaces(), json)),

  docs: (async ({ action, q, doc_id, title, collection_id, parent_id, limit }: DocsArgs, b: AgentBackend) => {
    switch (action) {
      case "list":
        return answer(b.listDocs(parent_id), (docs) =>
          // doc_type sends the agent to `markdown` or to `databases`; a database read as prose dead-ends the loop.
          json({ docs: docs.map((d) => ({ doc_id: d.doc_id, title: d.title, doc_type: d.doc_type, parent_id: d.parent_id, updated_at: d.updated_at })) }),
        );
      case "search": {
        const query = (q ?? "").trim();
        if (!query) return err("search requires `q`");
        return answer(b.searchDocs({ q: query, collection_id, limit }), renderSearch);
      }
      case "create":
        return answer(b.createDoc({ title: title ?? "", ...(parent_id ? { parent_id } : {}) }), (d) =>
          json({ doc_id: d.doc_id, title: d.title, ...instructionFields(d) }),
        );
      case "metadata":
        if (!doc_id) return err("metadata requires `doc_id`");
        return answer(b.docMetadata(doc_id), json);
    }
  }),

  markdown: (async ({ doc_id, action, text, heading, find, replace, replace_all, edits, citations }: MarkdownArgs, b: AgentBackend) => {
    if (action === "read") return answer(b.readMarkdown(doc_id), renderRead);
    if (action === "status") return answer(b.docRuns(doc_id), renderStatus);
    if (action === "provenance") return answer(b.provenance(doc_id), renderProvenance);
    if ((action === "write" || action === "append") && text == null) return err(`${action} requires \`text\``);
    if (action === "str_replace" && !find) return err("str_replace requires a non-empty `find`");
    if (action === "cited_edits" && !edits?.length) return err("cited_edits requires a non-empty `edits` array");
    return answer(
      b.propose(doc_id, {
        action,
        text,
        heading,
        find,
        replace,
        replace_all,
        edits,
        citations: citations?.map((c) => ({ ...c, heading_path: c.heading_path ?? null, content: c.content ?? "" })),
      }),
      renderPropose,
    );
  }),

  media: (async ({ doc_id, action, data, url, alt, caption }: MediaArgs, b: AgentBackend) => {
    if (action === "upload" && !data) return err("upload requires base64 image bytes in `data`");
    if (action === "upload_from_url" && !url) return err("upload_from_url requires `url`");
    const source = action === "upload" ? { kind: "data" as const, data: data! } : { kind: "url" as const, url: url! };
    return answer(b.uploadImage(doc_id, source), (stored) => renderUpload(stored, alt, caption));
  }),

  comments: (async ({ doc_id, action, body }: { doc_id: string; action: "list" | "add"; body?: string }, b: AgentBackend) => {
    if (action === "list") return answer(b.listComments(doc_id), json);
    const text = body?.trim();
    if (!text) return err("add requires `body`");
    return answer(b.addComment(doc_id, text), json);
  }),

  folders: (async (_args: unknown, b: AgentBackend) => answer(b.listFolders(), json)),

  events: (async ({ after, types, limit }: { after?: number; types?: string[]; limit?: number }, b: AgentBackend) => {
    for (const t of types ?? []) if (!isWorkspaceEventType(t)) return err(`unknown event type ${t}`);
    return answer(b.pollEvents({ after, types, limit }), json);
  }),

  collections,

  retrieve: (async ({ q, collection_id, limit }: { q: string; collection_id?: string; limit?: number }, b: AgentBackend) => {
    const query = q.trim();
    if (!query) return err("retrieve requires `q`");
    const res = await b.retrieve({ q: query, collection_id, limit });
    if (isRefusal(res)) return err(res.error);
    // An empty list here would read as "nothing matched" and send the agent rephrasing forever.
    if (res.ai_disabled) return err(RETRIEVE_AI_DISABLED_MESSAGE);
    return ok(renderPassages(res, b.origin));
  }),

  databases,

  query: (async ({ database_id, sql, params }: { database_id: string; sql: string; params?: Array<string | number | boolean | null> }, b: AgentBackend) => {
    const violation = selectOnlyViolation(sql);
    if (violation) return err(violation);
    return answer(b.query(database_id, sql, normalizeQueryParams(params)), json);
  }),
};

const collectionRef = (c: { collection_id: string; name: string }): string => json({ collection_id: c.collection_id, name: c.name });

async function collections({ action, collection_id, name, doc_ids, folder_ids }: CollectionsArgs, b: AgentBackend): Promise<ToolText> {
  if (action === "list") {
    return answer(b.listCollections(), (rows) =>
      json({ collections: rows.map((c) => ({ collection_id: c.collection_id, name: c.name, item_count: c.item_count })) }),
    );
  }
  if (action === "create") {
    if (!name?.trim()) return err("create requires `name`");
    return answer(b.createCollection(name.trim()), collectionRef);
  }
  if (!collection_id) return err(`${action} requires \`collection_id\``);
  switch (action) {
    case "open":
      return answer(b.openCollection(collection_id), ({ collection, items }) =>
        json({
          collection_id: collection.collection_id,
          name: collection.name,
          items: items.map((i) => (i.doc_id ? { doc_id: i.doc_id, title: i.title } : { folder_id: i.folder_id, title: i.title })),
        }),
      );
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

async function databases(args: DatabasesArgs, b: AgentBackend, variant: Variant): Promise<ToolText> {
  const { action } = args;
  if (action === "list") {
    return answer(b.listDocs(undefined), (docs) =>
      json({
        databases: docs.filter((d) => d.doc_type === "database").map((d) => ({ database_id: d.doc_id, title: d.title, updated_at: d.updated_at })),
      }),
    );
  }
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
  const propose = (mutation: DatabaseMutation, applied: string, note = ""): Promise<ToolText> =>
    answer(b.mutateDatabase(databaseId, mutation), (res) => renderDatabasePropose(res, applied, note));

  if (action === "schema") return answer(b.databaseSchema(databaseId), json);
  if (action === "status") return answer(b.databaseRuns(databaseId), renderDatabaseStatus);
  if (action === "create_table") {
    // An agent that just used `title` for create_database reaches for it again here.
    const display = args.name ?? args.title;
    if (!display) return err("create_table requires `name`");
    const columns = args.columns ?? [];
    return propose(
      { action: "create_table", display, ...(columns.length > 0 ? { columns } : {}) },
      `created table "${display}"${columns.length > 0 ? ` with ${plural(columns.length, "column")}` : ""}.`,
    );
  }

  let source: ImportSource | null = null;
  if (action === "import") {
    const file = variant === "stdio" ? args.file : undefined;
    const given = [file, args.content, args.import_id].filter((v) => v !== undefined).length;
    if (given === 0) {
      return err(
        variant === "stdio"
          ? "import requires `file` (a path on this machine), `content` (the file's text), or `import_id` to retry an upload the node holds"
          : "import requires `content` (the file's text) or `import_id` to retry an upload the node holds",
      );
    }
    if (given > 1) {
      return err(variant === "stdio" ? "import takes exactly one of `file`, `content` or `import_id`" : "import takes `content` or `import_id`, not both");
    }
    source =
      args.import_id !== undefined
        ? { kind: "import_id", import_id: args.import_id }
        : file !== undefined
          ? { kind: "file", path: file, ...(args.format ? { format: args.format } : {}) }
          : { kind: "content", content: args.content!, ...(args.format ? { format: args.format } : {}) };
  }

  // A retry names a staging the node already holds, and that staging knows its own table.
  let tableId: string | null = null;
  let tableName = "";
  let table: TableSchema | null = null;
  if (source?.kind !== "import_id") {
    // Only the table is wanted here: `schema` is the action that hands the stack over.
    const schema = await b.databaseSchema(databaseId, { instructions: false });
    if (isRefusal(schema)) return err(schema.error);
    const resolved = resolveTable(schema, args.table);
    if ("error" in resolved) return err(resolved.error);
    table = resolved.table;
    tableId = table.table_id;
    tableName = table.name;
  }

  if (source) {
    const out = await b.importRows(databaseId, tableId, source, {
      column_map: args.column_map,
      on_error: args.on_error,
      max_bad_rows: args.max_bad_rows,
      date_order: args.date_order,
      dry_run: args.dry_run,
    });
    if (isRefusal(out)) return err(out.error);
    if ("hand_off" in out) return err(renderHandOff(out.hand_off.page_url, out.hand_off.why));
    const rendered = renderImportCommit(out.status, out.body, variant === "stdio" ? "file/content" : "content");
    return rendered.isError ? err(rendered.text) : ok(rendered.text);
  }

  const id = tableId!;
  switch (action) {
    case "add_column":
      if (!args.name || !args.type) return err("add_column requires `name` and `type`");
      return propose(
        {
          action: "add_column",
          table_id: id,
          display: args.name,
          type: args.type,
          ...(args.choices ? { choices: args.choices } : {}),
          ...(args.description ? { description: args.description } : {}),
        },
        `added ${args.type} column "${args.name}" to ${tableName}.`,
      );
    case "insert_rows":
      if (!args.rows?.length) return err("insert_rows requires `rows` — for a whole file use action:import");
      return propose({ action: "insert_rows", table_id: id, rows: args.rows }, `inserted ${args.rows.length} row(s) into ${tableName}.`, bulkSteer(args.rows.length));
    case "update_rows":
      if (!args.updates?.length) return err("update_rows requires `updates`");
      return propose({ action: "update_rows", table_id: id, updates: args.updates }, `updated ${args.updates.length} row(s) in ${tableName}.`);
    case "delete_rows":
      if (!args.row_ids?.length) return err("delete_rows requires `row_ids`");
      return propose({ action: "delete_rows", table_id: id, row_ids: args.row_ids }, `deleted ${args.row_ids.length} row(s) from ${tableName}.`);
    case "open_page":
      if (!args.row_id) return err("open_page requires `row_id` (a row's `_id`, from `query`)");
      return answer(b.openRowPage(databaseId, id, args.row_id), renderOpenPage);
    case "create_view":
      if (!args.name) return err("create_view requires `name`");
      return propose({ action: "create_view", table_id: id, view: { name: args.name, ...viewShape(args) } }, `created view "${args.name}" on ${tableName}.`);
    case "update_view": {
      const hit = resolveView(table!, args.view);
      if ("error" in hit) return err(hit.error);
      const changes = { ...(args.name ? { name: args.name } : {}), ...viewShape(args) };
      if (Object.keys(changes).length === 0) return err("update_view needs something to change: name, filter, sorts, group_by or hidden_columns");
      return propose({ action: "update_view", table_id: id, view_id: hit.view.view_id, changes }, `changed view "${hit.view.name}" on ${tableName}.`);
    }
    default:
      return err(`unknown action ${action}`);
  }
}
