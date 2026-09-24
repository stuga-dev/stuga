/**
 * What a server must provide for the tools to run. Bodies are the shapes the
 * node's REST routes answer with, so the stdio server passes them through and
 * the node's /mcp maps its in-process outcomes onto them.
 */
import type {
  DatabaseColumnType,
  DatabaseImportFormat,
  DatabaseRunSummary,
  DatabaseSchema,
  DatabaseViewKind,
  RowInputValue,
} from "@stuga/protocol/databases/types";
import type { AgentInstructions } from "@stuga/protocol/domain/instructions";
import type { AgentRunSummary, AiCitation, AiStrEdit } from "@stuga/protocol/wire/doc-socket";

/** A refusal, in words the agent can act on. */
export interface Refusal {
  error: string;
}

export type Answer<T> = Promise<T | Refusal>;

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && typeof (value as Refusal).error === "string";
}

export interface DocListing {
  doc_id: string;
  title: string;
  doc_type: string;
  parent_id: string | null;
  updated_at: string;
}

/** The new document, with the instructions stack it was placed under. */
export interface CreatedDoc extends Partial<AgentInstructions> {
  doc_id: string;
  title: string;
}

/** One document's facts as the node reports them, with the instructions stack that applies to it. */
export type DocMetadata = Record<string, unknown> & Partial<AgentInstructions>;

export interface CreateDocInput {
  title: string;
  parent_id?: string;
  doc_type?: "prose" | "database";
  /** Databases: the starter table's name. */
  table?: string;
  columns?: ColumnSpecInput[];
}

export interface ColumnSpecInput {
  name: string;
  type: DatabaseColumnType;
  choices?: string[];
  /** Short help text: what the column holds. */
  description?: string;
}

export interface WorkspaceInstructions {
  workspace_id: string;
  name: string;
  instructions: string;
}

export interface SearchQuery {
  q: string;
  collection_id?: string;
  limit?: number;
}

export interface SearchBody {
  query: string;
  results: unknown[];
  degraded: boolean;
  semantic: boolean;
  /** The collection scope resolved to nothing this credential can read. */
  empty_scope?: boolean;
}

export interface RetrievedChunk {
  doc_id: string;
  title: string;
  content: string;
  heading_path: string | null;
}

export interface RetrieveBody {
  chunks: RetrievedChunk[];
  degraded?: boolean;
  /** Embeddings are off on this node; nothing was ranked. */
  ai_disabled?: boolean;
  empty_scope?: boolean;
}

/** A read, with the instructions stack that applies to the document. */
export interface MarkdownBody extends Partial<AgentInstructions> {
  markdown: string;
  run_id?: string | null;
  pending?: number;
}

export interface ProposeInput {
  action: "write" | "str_replace" | "append" | "cited_edits";
  text?: string;
  heading?: string;
  find?: string;
  replace?: string;
  replace_all?: boolean;
  edits?: AiStrEdit[];
  citations?: AiCitation[];
}

/**
 * A write's answer names the instructions for agents below the workspace that apply to the document, labels only,
 * so an agent that wrote without reading (an append needs no read) learns they exist; the read carries their text.
 */
export interface ProposeInstructionLabels {
  instructions_labels?: string[];
}

export type ProposeBody =
  | ({ mode: "proposed"; run: AgentRunSummary; pending: number; reason: string; media_note?: string } & ProposeInstructionLabels)
  | ({ mode: "auto_applied"; run: AgentRunSummary; seq: number; reason: string; review_url: string; media_note?: string } & ProposeInstructionLabels)
  | { mode: "noop"; message: string };

export interface ProvenancePassage {
  run_id: string;
  agent: string;
  agent_alias: string;
  landed: "accepted" | "auto_applied";
  reviewed: boolean;
  excerpt: string;
}

export interface ProvenanceBody {
  passages: ProvenancePassage[];
  pending_runs: number;
}

export type ImageSource = { kind: "data"; data: string } | { kind: "url"; url: string };

export interface StoredImage {
  url: string;
  hash: string;
  size: number;
  mime: string;
}

export interface EventsQuery {
  /** Omitted: start from the newest event. */
  after?: number;
  types?: string[];
  limit?: number;
}

export interface CollectionListing {
  collection_id: string;
  name: string;
  item_count: number;
}

export interface CollectionRef {
  collection_id: string;
  name: string;
}

/** One member the caller can read: a document or a folder. */
export interface CollectionMember {
  doc_id: string | null;
  folder_id: string | null;
  title: string;
}

export interface OpenedCollection {
  collection: CollectionRef;
  items: CollectionMember[];
}

export interface CollectionItemsChange {
  doc_ids: string[];
  folder_ids: string[];
}

/** `added` counts new members and `skipped` the ids the caller cannot read; a removal reports `removed`. */
export type CollectionItemsBody = { added: number; skipped: number } | { removed: number };

export interface ViewShape {
  name?: string;
  kind?: DatabaseViewKind;
  filter?: unknown;
  sorts?: Array<{ column_id: string; dir?: "asc" | "desc" }>;
  group_by?: string | null;
  hidden_columns?: string[];
}

export type DatabaseMutation =
  | { action: "create_table"; display: string; columns?: ColumnSpecInput[] }
  | { action: "add_column"; table_id: string; display: string; type: DatabaseColumnType; choices?: string[]; description?: string }
  | { action: "insert_rows"; table_id: string; rows: Array<Record<string, RowInputValue>> }
  | { action: "update_rows"; table_id: string; updates: Array<{ _id: string; values: Record<string, RowInputValue> }> }
  | { action: "delete_rows"; table_id: string; row_ids: string[] }
  | { action: "create_view"; table_id: string; view: ViewShape & { name: string } }
  | { action: "update_view"; table_id: string; view_id: string; changes: ViewShape };

/**
 * A database write's envelope: `proposed` waits for review, `applied` landed at
 * once; a body with neither is a human credential's direct write.
 */
export type DatabaseProposeBody = ProposeInstructionLabels & {
  mode?: "proposed" | "applied";
  run?: DatabaseRunSummary;
  pending?: number;
  /** Ids the actor assigned (table_id / column_id / row_ids). */
  minted?: Record<string, unknown>;
  /** An `auto` database parked this anyway: the run still holds undecided ops. */
  held?: boolean;
  [key: string]: unknown;
};

/** The caller's projection of a database, with the instructions stack that applies to it. */
export type DatabaseSchemaBody = DatabaseSchema & Partial<AgentInstructions>;

export interface DatabaseSchemaOptions {
  /** Default true. A backend may still carry them (REST adds them for any agent); none has to. */
  instructions?: boolean;
}

export interface RowPage {
  doc_id: string;
  created: boolean;
  restored: boolean;
}

export type ImportSource =
  | { kind: "content"; content: string; format?: DatabaseImportFormat }
  | { kind: "file"; path: string; format?: DatabaseImportFormat }
  | { kind: "import_id"; import_id: string };

export interface ImportOptions {
  column_map?: Record<string, string | null>;
  on_error?: "abort" | "skip_bad_rows";
  max_bad_rows?: number;
  date_order?: "mdy" | "dmy";
  dry_run?: boolean;
}

/** The commit's answer, or the data could not reach the node and the person must finish the import. */
export type ImportOutcome = { status: number; body: Record<string, unknown> } | { hand_off: { page_url: string; why: string } };

export interface AgentBackend {
  /** Base URL for document links in results; "" when there is none to give. */
  origin: string;
  listWorkspaces(): Answer<Record<string, unknown>>;
  workspaceInstructions(): Answer<WorkspaceInstructions>;
  listDocs(parentId: string | null | undefined): Answer<DocListing[]>;
  searchDocs(query: SearchQuery): Answer<SearchBody>;
  docMetadata(docId: string): Answer<DocMetadata>;
  createDoc(input: CreateDocInput): Answer<CreatedDoc>;
  readMarkdown(docId: string): Answer<MarkdownBody>;
  /** This caller's own runs on the document, newest first. */
  docRuns(docId: string): Answer<AgentRunSummary[]>;
  provenance(docId: string): Answer<ProvenanceBody>;
  propose(docId: string, input: ProposeInput): Answer<ProposeBody>;
  uploadImage(docId: string, source: ImageSource): Answer<StoredImage>;
  listComments(docId: string): Answer<Record<string, unknown>>;
  addComment(docId: string, body: string): Answer<Record<string, unknown>>;
  listFolders(): Answer<Record<string, unknown>>;
  pollEvents(query: EventsQuery): Answer<Record<string, unknown>>;
  listCollections(): Answer<CollectionListing[]>;
  openCollection(collectionId: string): Answer<OpenedCollection>;
  createCollection(name: string): Answer<CollectionRef>;
  renameCollection(collectionId: string, name: string): Answer<CollectionRef>;
  deleteCollection(collectionId: string): Answer<{ deleted: boolean }>;
  changeCollectionItems(collectionId: string, change: "add" | "remove", items: CollectionItemsChange): Answer<CollectionItemsBody>;
  retrieve(query: SearchQuery): Answer<RetrieveBody>;
  /**
   * The caller's projection: its own pending proposals included. `instructions: false` for a caller that only
   * needs the tables, so a write never resolves (or fails on) a stack nobody reads.
   */
  databaseSchema(databaseId: string, opts?: DatabaseSchemaOptions): Answer<DatabaseSchemaBody>;
  /** This caller's own runs on the database, newest first. */
  databaseRuns(databaseId: string): Answer<DatabaseRunSummary[]>;
  mutateDatabase(databaseId: string, mutation: DatabaseMutation): Answer<DatabaseProposeBody>;
  openRowPage(databaseId: string, tableId: string, rowId: string): Answer<RowPage>;
  /** `tableId` is null only for an `import_id` retry, whose staging names its own table. */
  importRows(databaseId: string, tableId: string | null, source: ImportSource, options: ImportOptions): Answer<ImportOutcome>;
  query(databaseId: string, sql: string, params: Array<string | number | null>): Answer<Record<string, unknown>>;
}
