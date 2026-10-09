/**
 * Read-only cross-document Q&A loop. The model writes its own searches, reads
 * documents and queries databases, and must ground every fact: a one-shot nudge
 * catches an answer given before any tool returned material, and only citations
 * the prose references are returned. Tools run through the injected AskToolRunner.
 */
import type { AskStep, AskStopReason } from "@stuga/protocol/api/ask";
import { DATABASE_ASK_QUERY_MAX_ROWS } from "@stuga/protocol/databases/limits";
import { SQL_VALUE_CONVENTIONS } from "@stuga/protocol/databases/sql-guard";
import type { AiCitation, AiHistoryItem } from "@stuga/protocol/wire/doc-socket";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AiConfig } from "../config.js";
import type { ModelFailure } from "../failure.js";
import { resolveModel } from "../models.js";
import type { TokenUsage } from "../types.js";
import { filterCited, runAgentLoop, textTool } from "./loop.js";
import { appendCitations, MAX_OUTPUT_TOKENS, queryOf, READ_CHUNK_MAX } from "./tools.js";
import { workspaceInstructionsBlock } from "./agent-instructions.js";

/** The one "don't know" reply, used by both the system prompt and the nudge; the model says it in the question's language. */
export const DONT_KNOW = "I couldn't find an answer to that in your documents.";

/** What the loop is doing between prose bursts, for the panel's activity line. */
export type AskAgentActivity =
  | { kind: "thinking" }
  | { kind: "searching"; query: string }
  | { kind: "reading"; title: string }
  | { kind: "listing" }
  /** Running SQL the model wrote against one structured database. */
  | { kind: "querying"; title: string };

/** Executes the loop's read-only tools (the node's API supplies it). */
export interface AskToolRunner {
  /**
   * Retrieve passages for one query, numbered in `text` from `offset + 1` so the
   * [n] the model reads is the citation's final number. Failures come back as
   * `text` with no citations.
   */
  search(input: { query: string; offset: number }): Promise<{ text: string; citations: AiCitation[] }>;
  /**
   * A slice of a document the caller may read; null for not found or no access,
   * `error` for a refusal worded for the model (a document outside the selected collection).
   */
  readDocument(input: { doc_id: string; offset?: number; length?: number }): Promise<{
    title: string;
    text: string;
    /** Total length of the document. */
    total: number;
  } | { error: string } | null>;
  /**
   * Readable documents, optionally filtered by a title glob and confined to a
   * folder's subtree, plus that folder's immediate children. A folder the caller
   * cannot see is `folderMissing`, like one that does not exist.
   */
  listDocuments(input: { query?: string; folder_id?: string }): Promise<{
    docs: Array<{ doc_id: string; title: string }>;
    folders: Array<{ folder_id: string; title: string }>;
    folderMissing?: boolean;
  }>;
  /** Readable databases, each with its tables and physical SQL column names. */
  listDatabases(): Promise<Array<{ database_id: string; title: string; schema: string }>>;
  /** One read-only SELECT against a readable database; refusals and SQL errors come back as `error`. */
  queryDatabase(input: { database_id: string; sql: string }): Promise<
    | { title: string; columns: string[]; rows: unknown[][]; truncated: boolean }
    | { error: string }
  >;
}

export interface AskAgentInput {
  question: string;
  /** A model id, or "auto". */
  model: string;
  history: AiHistoryItem[];
  /** Label of the retrieval scope, e.g. "all your documents" or a Collection name. */
  scopeLabel?: string;
  /** The workspace's instructions for agents, appended to the system prompt. */
  workspaceInstructions?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  /** Before every round after the first; a message stops the turn with "budget". */
  beforeRound?: (round: number) => Promise<string | null | void>;
}

export interface AskAgentResult {
  /** The answer, already streamed. */
  prose: string;
  /** Sources the prose cited, in the model's numbering. */
  citations: AiCitation[];
  /** Every tool step taken, in order. */
  steps: AskStep[];
  usage: TokenUsage;
  modelId: string;
  rounds: number;
  /** Anything but "complete" is incomplete, but prose, citations and steps must still be rendered. */
  stopReason: AskStopReason;
  /** The error or budget message. */
  error?: string;
  /** With "error": what failed. */
  failure?: ModelFailure;
}

/** Read-only turns converge faster than editing ones, and the request stays open for the whole turn. */
const DEFAULT_MAX_ROUNDS = 6;
/** Documents one list_documents call names; the runner applies it and the loop announces truncation. */
export const LIST_LIMIT = 50;

const SYSTEM = `You research a user's own document library and answer from it, working through tools.
Tools:
- search_documents(query): find relevant passages. Returns numbered passages, each headed "[n] Title — Section (doc: <doc_id>)". Search REPEATEDLY with different phrasings and follow-up queries — one search is rarely enough.
- read_document(doc_id, offset, length): read a document in full. Use it when a passage is a lead rather than an answer ("as agreed in the Q3 retro"), when you need context around a snippet, or when the question is about a whole document.
- list_documents(query, folder_id): list documents and folders when you need to orient or the user names a document or folder. query is a title glob (* and ?); folder_id confines the list to that folder's subtree — pass one from an earlier listing to look inside it.
- list_databases(): the structured databases (typed tables of rows) the user has, with each table's columns and physical SQL names. Call it when a question is about counts, totals, sums of money, lists, dates, statuses, or anything tabular — "how many", "how much", "total", "revenue", "which ones", "latest", "overdue". A word from the business rather than from a document ("revenue", "pipeline", "headcount") is usually a question about a table.
- query_database(database_id, sql): run ONE read-only SELECT (SQLite dialect) against a database from list_databases. Use the physical table and column names from that listing. Aggregate and filter in SQL rather than pulling every row; results cap at ${DATABASE_ASK_QUERY_MAX_ROWS} rows. A database's rows are NOT in search_documents — SQL is the only way to read them.
  ${SQL_VALUE_CONVENTIONS}
Rules:
- Answer ONLY from what the tools return. Never use outside knowledge, and never guess.
- A question about data in a table is answered with query_database, and you cite the database by its title in prose (query results have no [^n] passage number).
- If two searches in a row return nothing useful, stop rephrasing and call list_databases: the answer may be in a table, which search_documents cannot see.
- SEARCH BEFORE YOU ANSWER. Do not answer from memory, even if the question looks like general knowledge — the user is asking about THEIR documents.
- Cite every asserted fact with a [^n] marker right after it, where n is the passage number from a search result. Multiple sources: [^1][^3].
- Write only the [^n] marker — do NOT write a "[^n]: ..." definition line; the app builds the source list.
- Write every reply in the language the question is written in, whatever language the documents are in; a quotation stays in its own language.
- If the tools do not turn up an answer, say only that you could not find an answer in their documents, as one sentence in the question's language (for an English question, exactly "${DONT_KNOW}"). Do not pad it with guesses or with what you know generally.
- Be concise and synthesize; do not paste passages back verbatim.`;

/** Sent at most once, when the model answers before any tool returned material. */
const NO_SEARCH_NUDGE =
  "You answered without searching the user's documents. You must not answer from your own knowledge. " +
  `Call search_documents now and base your answer only on what it returns; if it returns nothing relevant, say only that you could not find an answer in their documents, in the question's language (in English: "${DONT_KNOW}").`;

/** Streaming callbacks. */
export interface AskAgentHandlers {
  /** An answer fragment to append. */
  onChunk: (text: string) => void;
  /** What the loop is doing now; replaces the previous label. */
  onStatus?: (activity: AskAgentActivity) => void;
  /** A completed tool step. */
  onStep?: (step: AskStep) => void;
  /** Discard everything streamed so far: it was written before the model searched. */
  onReset?: () => void;
}

export async function runAskAgentTurn(
  cfg: AiConfig,
  input: AskAgentInput,
  runner: AskToolRunner,
  handlers: AskAgentHandlers,
): Promise<AskAgentResult> {
  const { onChunk, onStatus, onStep, onReset } = handlers;
  const modelId = resolveModel(cfg, input.model);

  const scope = input.scopeLabel ? `You are searching: ${input.scopeLabel}.\n\n` : "";

  const citations: AiCitation[] = [];
  const steps: AskStep[] = [];
  // Set by a search, an opened document or a query result; listings and failed tools are not material.
  let grounded = false;
  let nudged = false;

  /** Record a completed step and report it. */
  const step = (s: AskStep): void => {
    steps.push(s);
    onStep?.(s);
  };

  const tools: AgentTool[] = [
    textTool(
      "list_databases",
      "List the user's structured databases with their tables, columns and physical SQL names. Call before query_database.",
      Type.Object({}),
      async () => {
        onStatus?.({ kind: "listing" });
        const dbs = await runner.listDatabases();
        if (dbs.length === 0) return "No structured databases you can read.";
        return dbs.map((d) => `database_id: ${d.database_id}\ntitle: ${d.title || "Untitled"}\n${d.schema}`).join("\n\n");
      },
    ),
    textTool(
      "query_database",
      `Run one read-only SELECT (SQLite dialect) against a structured database. Use physical names from list_databases. Aggregate in SQL; results cap at ${DATABASE_ASK_QUERY_MAX_ROWS} rows.`,
      Type.Object({
        database_id: Type.String({ description: "The database to query (from list_databases)." }),
        sql: Type.String({ description: "One SELECT statement. Bind nothing; write literal values." }),
      }),
      async (args) => {
        const databaseId = args.database_id.trim();
        const sqlText = args.sql.trim();
        if (!databaseId || !sqlText) throw new Error("database_id and sql are required");
        onStatus?.({ kind: "querying", title: databaseId });
        const out = await runner.queryDatabase({ database_id: databaseId, sql: sqlText });
        if ("error" in out) throw new Error(out.error);
        grounded = true;
        step({ kind: "query", database_id: databaseId, title: out.title, sql: sqlText, rows: out.rows.length });
        const header = out.columns.join(" | ");
        const body = out.rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))).join(" | ")).join("\n");
        return (
          `Database: ${out.title || "Untitled"}\n${out.rows.length} row${out.rows.length === 1 ? "" : "s"}` +
          `${out.truncated ? " (truncated — aggregate or filter for the rest)" : ""}\n${header}\n${body}`
        );
      },
    ),
    textTool(
      "search_documents",
      "Search the user's documents for relevant passages. Returns numbered, citable passages.",
      Type.Object({ query: Type.String({ description: "What to search for." }) }),
      async (args) => {
        const query = queryOf(args.query);
        onStatus?.({ kind: "searching", query });
        const found = await runner.search({ query, offset: citations.length });
        appendCitations(citations, found.citations);
        grounded = true;
        step({ kind: "search", query, hits: found.citations.length });
        return found.text || "No relevant passages found.";
      },
    ),
    textTool(
      "read_document",
      "Read a slice of one document (offset + length in characters). Get doc_id from a search result header or list_documents.",
      Type.Object({
        doc_id: Type.String({ description: "The document to read." }),
        offset: Type.Optional(Type.Integer({ description: "Start character offset (0-based)." })),
        length: Type.Optional(Type.Integer({ description: `Chars to read (max ${READ_CHUNK_MAX}).` })),
      }),
      async (args) => {
        const docId = args.doc_id.trim();
        if (!docId) throw new Error("doc_id is required");
        const offset = Math.max(0, args.offset ?? 0);
        const length = Math.min(READ_CHUNK_MAX, Math.max(1, args.length || READ_CHUNK_MAX));
        const doc = await runner.readDocument({ doc_id: docId, offset, length });
        if (!doc) throw new Error(`no document ${docId} you can read`);
        if ("error" in doc) throw new Error(doc.error);
        onStatus?.({ kind: "reading", title: doc.title });
        grounded = true;
        step({ kind: "read", doc_id: docId, title: doc.title, chars: doc.text.length });
        const end = offset + doc.text.length;
        const more =
          end < doc.total ? `\n---\n[Characters ${offset}–${end} of ${doc.total}. Call read_document again with offset=${end} for more.]` : "";
        return `${doc.title}\n\n${doc.text}${more}`;
      },
    ),
    textTool(
      "list_documents",
      "List documents you can read (id + title), plus the folders at that level. Filter by title and/or confine to one folder.",
      Type.Object({
        query: Type.Optional(
          Type.String({
            description: "Optional title filter. Glob, not regex: * matches any text, ? one character. Plain text matches anywhere in the title.",
          }),
        ),
        folder_id: Type.Optional(
          Type.String({ description: "Optional folder to look inside (its whole subtree). Get one from a previous list_documents result." }),
        ),
      }),
      async (args) => {
        onStatus?.({ kind: "listing" });
        const q = args.query?.trim() ?? "";
        const folderId = args.folder_id?.trim() ?? "";
        const res = await runner.listDocuments({ query: q || undefined, folder_id: folderId || undefined });
        if (res.folderMissing) throw new Error(`no folder ${folderId} you can read`);
        step({ kind: "list", count: res.docs.length, folders: res.folders.length, query: q || null });
        const parts: string[] = [];
        if (res.folders.length) parts.push(`Folders:\n${res.folders.map((f) => `${f.folder_id}  ${f.title || "Untitled"}/`).join("\n")}`);
        if (res.docs.length) parts.push(`Documents:\n${res.docs.map((d) => `${d.doc_id}  ${d.title || "Untitled"}`).join("\n")}`);
        if (res.docs.length === LIST_LIMIT) {
          parts.push(`[Showing the first ${LIST_LIMIT} documents. Narrow with a title filter or a folder_id.]`);
        }
        return parts.length ? parts.join("\n\n") : "No documents matched.";
      },
    ),
  ];

  const result = await runAgentLoop({
    cfg,
    modelId,
    // Instructions go last, and the prompt is unchanged when there are none.
    system: SYSTEM + workspaceInstructionsBlock(input.workspaceInstructions),
    tools,
    maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
    maxTokens: MAX_OUTPUT_TOKENS,
    history: input.history,
    seed: `${scope}Question: ${input.question}`,
    signal: input.signal,
    beforeRound: input.beforeRound,
    onFinishAttempt: () => {
      if (grounded || nudged) return { action: "accept" };
      nudged = true;
      return { action: "nudge", message: NO_SEARCH_NUDGE, resetProse: true };
    },
    onChunk,
    onRoundStart: () => onStatus?.({ kind: "thinking" }),
    onResetProse: () => onReset?.(),
  });

  return {
    prose: result.prose,
    citations: filterCited(result.prose, citations),
    steps,
    usage: result.usage,
    modelId,
    rounds: result.rounds,
    stopReason: result.stopReason,
    error: result.error,
    failure: result.failure,
  };
}
