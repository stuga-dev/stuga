/**
 * What one workspace must provide for the tools to run in it. Bodies are the
 * shapes the node's REST routes answer with, so an in-process backend and one
 * that forwards to another node answer alike.
 */
import type {
  DatabaseColumnType,
  DatabaseImportFormat,
  DatabaseRunSummary,
  DatabaseSchema,
  DatabaseViewKind,
  RowInputValue,
} from "@stuga/protocol/databases/types";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { AgentInstructions } from "@stuga/protocol/domain/instructions";
import type { AgentFeedback } from "@stuga/protocol/domain/runs";
import type { WikiIndex, WikiLint, WikiLog } from "@stuga/protocol/domain/wiki";
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

/** A write's change, as the caller names it: the id an earlier write returned, or a title that opens one. */
export interface ChangeFields {
  change_id?: string;
  change_title?: string;
  change_summary?: string;
}

/** The change a write went into, so the agent passes the id to its next write for the same work. */
export interface ChangeAnswer {
  change_id?: string;
  change_title?: string;
}

/** The run a queued write waits behind: the agent's earlier change to the item, still undecided. */
export interface QueuedBehind {
  run_id: string;
  change_id: string | null;
  change_title: string | null;
}

/** The new document, with the instructions stack it was placed under. */
export interface CreatedDoc extends Partial<AgentInstructions>, ChangeAnswer {
  doc_id: string;
  title: string;
  /** A new page held until its change is approved: only the user and those who may approve it can open it. */
  held?: boolean;
}

/** One document's facts as the node reports them, with the instructions stack that applies to it. */
export type DocMetadata = Record<string, unknown> & Partial<AgentInstructions>;

export interface CreateDocInput extends ChangeFields {
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

/** A search hit; the node's scores ride along until a merge drops them. */
export interface SearchHitBody {
  doc_id: string;
  title: string;
  score?: number;
  sem_score?: number;
  [key: string]: unknown;
}

export interface SearchBody {
  query: string;
  results: SearchHitBody[];
  degraded: boolean;
  semantic: boolean;
  /** The collection scope resolved to nothing this credential can read. */
  empty_scope?: boolean;
  /** No document holds every word of the query: these hold some of them. */
  partial?: boolean;
}

/**
 * Who wrote a document, as an agent's recall answer cites it: what a person's REST answer leaves out.
 * `ai_edits` is "unreviewed" while an AI change applied directly stands that no person has reviewed.
 * A type alias, so a search hit that carries it keeps the hit's open shape.
 */
export type Authorship = {
  updated_at?: string;
  last_edited_by?: Array<{ kind: "person" | "agent"; name: string }>;
  ai_edits?: "none" | "reviewed" | "unreviewed";
  /**
   * AI changes proposed to it that wait for approval, by who asked for them and the level they wait at; none of
   * their text is in it. The user's own are listed in `proposed`, as they would land; others' are counted.
   */
  pending_changes?: WaitingChanges[];
};

/** Who approves a waiting AI change: the person who asked the AI (`review`), or someone else (`colleague`). */
export type WaitsFor = "review" | "colleague";

/**
 * Who asked for a waiting AI change: the user the caller acts for (through this agent, another of theirs, or their
 * AI co-author), or someone else.
 */
export type AskedBy = "user" | "others";

/**
 * One of the user's own waiting changes as it would land on the approved text, cut short: a change to another of
 * their waiting changes is one with it.
 */
export interface ProposedChange {
  /** The approved text it changes; "" when it adds, as it does on a page with no approved text. */
  approved_now: string;
  /** What that text reads once approved; "" when it removes it. */
  after_approval: string;
  /** Where it lands, by heading path, when it is listed on a passage of another section ("" before any heading). */
  section?: string;
}

/** AI changes to a document that wait at one level, asked for by one side: not in its text until approved. */
export interface WaitingChanges {
  /** Absent from an answer that does not tell them apart. */
  asked_by?: AskedBy;
  waits_for: WaitsFor;
  /** How many changes wait. */
  changes: number;
  /** When the oldest of them was proposed, at the latest. */
  since: string;
  /** The user's own, those about the question first, each as it would land. */
  proposed?: ProposedChange[];
  /** Said when `proposed` lists fewer than `changes`: "1 of 4 listed here; read the page for the rest." */
  note?: string;
}

/**
 * One of the reader's own changes that waits, laid over the text it read, as it would land on the approved text:
 * a change to another of its waiting changes is one with it.
 */
export interface PendingChange {
  /** The approved text it changes; "" when it adds, as it does on a page with no approved text. */
  approved_now: string;
  /** What that text reads once approved, as the read shows it; "" when it removes it. */
  after_approval: string;
  /** For an addition, the approved line it follows, or, when it goes first, the one it precedes: neither on an empty page. */
  adds_after?: string;
  adds_before?: string;
  waits_for: WaitsFor;
}

export interface RetrievedChunk extends Authorship {
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
  /** Embeddings are off on this node, so these passages were found by their words alone. */
  keyword_only?: boolean;
  /** Found by their words, and no passage holds every word of the question: these hold some of them. */
  partial?: boolean;
  empty_scope?: boolean;
}

/** A read, with the instructions stack that applies to the document. */
export interface MarkdownBody extends Partial<AgentInstructions> {
  markdown: string;
  run_id?: string | null;
  pending?: number;
  /** An agent's read: its own changes laid over `markdown`, each as it would land on the approved text. */
  pending_changes?: PendingChange[];
  /** When the run holding them began. */
  pending_since?: string;
  /** Other changes here that wait, by who asked and level: not in `markdown`. The user's other agents' are listed. */
  others_waiting?: WaitingChanges[];
  /** The reader's rejections here it has not acted on; repeated until it proposes to the document again. */
  feedback?: AgentFeedback[];
}

export interface ProposeInput extends ChangeFields {
  action: "write" | "str_replace" | "append" | "cited_edits";
  text?: string;
  heading?: string;
  find?: string;
  replace?: string;
  replace_all?: boolean;
  edits?: AiStrEdit[];
  citations?: AiCitation[];
  /** Feedback ids this proposal answers. */
  revises?: string[];
}

/**
 * A write's answer names the instructions for agents below the workspace that apply to the document, labels only,
 * so an agent that wrote without reading (an append needs no read) learns they exist; the read carries their text.
 */
export interface ProposeInstructionLabels {
  instructions_labels?: string[];
}

/** The agent's open feedback here, carried with every proposal, and the ids this one answered. */
export interface ProposeFeedback {
  feedback?: AgentFeedback[];
  revised?: string[];
}

/** Where an append under a heading with subsections went: before the first of them. */
export interface ProposePlacement {
  placement_note?: string;
}

export type ProposeBody =
  | ({ mode: "proposed"; run: AgentRunSummary; pending: number; reason: string; media_note?: string; queued_behind?: QueuedBehind } & ProposeInstructionLabels &
      ProposeFeedback &
      ProposePlacement &
      ChangeAnswer)
  | ({ mode: "auto_applied"; run: AgentRunSummary; seq: number; reason: string; review_url: string; media_note?: string } & ProposeInstructionLabels &
      ProposeFeedback &
      ProposePlacement &
      ChangeAnswer)
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

/** Bytes for `media_upload`: inline base64, a URL the node downloads, or a file staged by `startUpload`. */
export type UploadSource =
  | { kind: "data"; data: string; name?: string }
  | { kind: "url"; url: string; name?: string }
  | { kind: "upload_id"; upload_id: string };

export interface StoredMedia {
  url: string;
  hash: string;
  size: number;
  mime: string;
  /** A file's name, which its url ends in; absent for an image a document shows. */
  name?: string;
  /** Stored with a database, for a files cell, rather than with a document. */
  database?: true;
}

/** A staged upload the caller sends the file to itself, then stores by `upload_id`. */
export interface MediaUpload {
  upload_id: string;
  /** PUT the whole file here; the signed URL is the credential and works once. */
  upload_url: string;
  /** The same target as a path, for a client that reaches the node at another origin. */
  upload_path: string;
  max_bytes: number;
  /** ISO timestamp after which the upload is refused. */
  expires_at: string;
}

export interface EventsQuery {
  /** Omitted: start from the newest event, or with `mine`, from RUN_FEEDBACK_LOOKBACK_DAYS ago. */
  after?: number;
  types?: string[];
  limit?: number;
  /** Only events about the caller's own runs: decisions on its proposals, unless `types` names others. */
  mine?: boolean;
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

/** A database write, with the feedback ids it answers and the change it belongs to. */
export type DatabaseProposal = DatabaseMutation & { revises?: string[] } & ChangeFields;

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
  /** It waits behind the agent's earlier change here, still undecided. */
  queued_behind?: QueuedBehind;
  change_id?: string;
  change_title?: string;
  /** The agent's open feedback here, and the ids this proposal answered. */
  feedback?: AgentFeedback[];
  revised?: string[];
  [key: string]: unknown;
};

/** The caller's projection of a database, with the instructions stack that applies to it. */
/** `feedback`: the reader's rejections here it has not acted on, as a document read carries them. */
export type DatabaseSchemaBody = DatabaseSchema & Partial<AgentInstructions> & { feedback?: AgentFeedback[] };

export interface DatabaseSchemaOptions {
  /** Default true. A backend may still carry them (REST adds them for any agent); none has to. */
  instructions?: boolean;
}

export interface RowPage {
  doc_id: string;
  created: boolean;
  restored: boolean;
}

/** A staged import a caller uploads the file to itself, then commits by `import_id`. */
export interface ImportUpload {
  import_id: string;
  /** PUT the whole file here; the signed URL is the credential and works once. */
  upload_url: string;
  /** The same target as a path, for a client that reaches the node at another origin. */
  upload_path: string;
  max_bytes: number;
  /** ISO timestamp after which the upload and the commit are refused. */
  expires_at: string;
  /** Where the person can drop the file instead. */
  import_page_url: string;
}

export type ImportSource =
  | { kind: "content"; content: string; format?: DatabaseImportFormat }
  | { kind: "import_id"; import_id: string };

export interface ImportOptions {
  /** Feedback ids this import answers. */
  revises?: string[];
  column_map?: Record<string, string | null>;
  on_error?: "abort" | "skip_bad_rows";
  max_bad_rows?: number;
  date_order?: "mdy" | "dmy";
  dry_run?: boolean;
}

/** The commit's answer, or the data could not reach the node and the person must finish the import. */
export type ImportOutcome = { status: number; body: Record<string, unknown> } | { hand_off: { page_url: string; why: string } };

/** One point a `remember` places. */
export interface RememberPoint {
  text: string;
  topic?: string;
  /** Where it came from (a meeting, an email, a chat, and when), kept out of `text`. */
  source?: string;
}

/** How a write to a place would be reviewed, and why, as `docs` action:metadata reports it. */
export interface PlaceReview {
  mode: ReviewMode;
  reason: string;
}

/** A page a point could go in. */
export interface RememberCandidate {
  kind: "page";
  doc_id: string;
  title: string;
  /** The folders it is in, from the top: a folder the user cannot read is "…". */
  folder_path: string[];
  /** The heading of the section it fits under, for `markdown_append`'s `heading`; null for the page's opening. */
  section: string | null;
  heading_path: string | null;
  why: string;
  excerpt: string;
  review: PlaceReview;
  /** Labels of the instructions for agents below the workspace that apply there; their text is in the plan's `instructions`. */
  instructions_labels?: string[];
  /** It is in the user's own My notes. */
  in_my_notes?: true;
  url?: string;
}

/** A folder a point could start a page in: its name or its instructions for agents fit the point, and no page there is about it. */
export interface RememberNewPage {
  kind: "new_page";
  folder_id: string;
  /** The folders from the top, the folder itself last. */
  folder_path: string[];
  why: string;
  review: PlaceReview;
  instructions_labels?: string[];
}

/** A passage that already says the point. */
export interface AlreadySavedPassage {
  doc_id: string;
  title: string;
  heading_path: string | null;
  /** The sentence that says it, as written; several when the point has several. */
  sentence: string;
  excerpt: string;
  in_my_notes?: true;
  url?: string;
}

/** A sentence the point may make untrue (`possibly_replaces`), or that says it already in other words (`likely_duplicate`). */
export interface ReplaceablePassage {
  doc_id: string;
  title: string;
  heading_path: string | null;
  sentence: string;
  hint: "possibly_replaces" | "likely_duplicate";
  /** Whether the user can edit it; when not, tell them instead of writing beside it. */
  can_edit: boolean;
  review: PlaceReview;
  in_my_notes?: true;
  url?: string;
}

export interface RememberPlanPoint {
  /** Its place in the call, from 0. */
  index: number;
  text: string;
  topic: string | null;
  source: string | null;
  candidates: Array<RememberCandidate | RememberNewPage>;
  already_saved: AlreadySavedPassage[];
  possibly_replaces: ReplaceablePassage[];
  /**
   * Said when the plan matched words only and no page found is about the point: a page on it may be written in
   * another language, which a word search cannot reach.
   */
  note?: string;
}

/** The person's own "My notes" folder in the workspace. */
export interface RememberHome {
  folder_id: string;
  title: string;
  /** This call made it. */
  created: boolean;
  /** Someone besides the user can read it now: they shared it. */
  shared: boolean;
  review: PlaceReview;
  /** The pages in it, by title, so a point joins the page on its topic. */
  pages: Array<{ doc_id: string; title: string }>;
  url?: string;
}

/** Where each point belongs: a plan, which writes nothing but My notes when it is first needed. */
export interface RememberPlanBody extends Partial<AgentInstructions> {
  /** Whom the connection acts for, by their Stuga name: who "the user" is in what you write. */
  user: { name: string; username: string } | null;
  points: RememberPlanPoint[];
  home: RememberHome | null;
  /** Why there is no `home`. */
  home_note?: string;
  /** Labels of the folders whose instructions say what belongs in them; their text is in `instructions`. */
  folders_with_instructions?: Array<{ folder_id: string; path: string[]; instructions_label: string }>;
  /** Meaning counted beside words, as `search` reports it. */
  semantic: boolean;
  degraded: boolean;
}

/** A comment an agent adds: a new thread, on a passage when `quote` names one, or a reply in a thread. */
export interface CommentAddInput {
  body: string;
  /** Any comment in the thread to reply in; a reply lands under the thread's first comment. */
  parent_num?: number;
  /** Text of the document, exactly as written and there once, to anchor a new thread to. */
  quote?: string;
}

export interface AgentBackend {
  /** Base URL for document links in results; "" when there is none to give. */
  origin: string;
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
  /** Store an image or file with a document, or a file with a database. */
  uploadMedia(docId: string, source: UploadSource): Answer<StoredMedia>;
  startUpload(docId: string, name: string): Answer<MediaUpload>;
  listComments(docId: string): Answer<Record<string, unknown>>;
  addComment(docId: string, input: CommentAddInput): Answer<Record<string, unknown>>;
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
  mutateDatabase(databaseId: string, mutation: DatabaseProposal): Answer<DatabaseProposeBody>;
  openRowPage(databaseId: string, tableId: string, rowId: string): Answer<RowPage>;
  /** The live page a row already has, or null: a read, which never restores or creates one. */
  findRowPage(databaseId: string, tableId: string, rowId: string): Answer<{ doc_id: string | null }>;
  startImport(databaseId: string, tableId: string, format: DatabaseImportFormat): Answer<ImportUpload>;
  /** `tableId` is null only for an `import_id` retry, whose staging names its own table. */
  importRows(databaseId: string, tableId: string | null, source: ImportSource, options: ImportOptions): Answer<ImportOutcome>;
  query(databaseId: string, sql: string, params: Array<string | number | null>): Answer<Record<string, unknown>>;
  /** Where each point belongs, in what the caller can read; makes the person's "My notes" when first needed. */
  planRemember(points: RememberPoint[]): Answer<RememberPlanBody>;
  /** The wiki's Index as the caller reads it, the whole workspace or one folder (`parentId`) and what is under it. */
  wikiIndex(parentId: string | null | undefined): Answer<WikiIndex>;
  /** The AI changes people decided, newest first, from before the cursor an earlier page gave. */
  wikiLog(before: string | undefined, limit: number): Answer<WikiLog>;
  /** What in the wiki to look at again, as the caller reads it: the whole workspace or one folder. */
  wikiLint(parentId: string | null | undefined): Answer<WikiLint>;
}
