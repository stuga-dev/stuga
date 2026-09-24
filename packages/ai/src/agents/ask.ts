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
import type { AiConfig } from "../config.js";
import { resolveModel } from "../models.js";
import type { TokenUsage, ToolSpec, ToolUse } from "../types.js";
import { runAgentLoop, filterCited, type ToolOutcome } from "./loop.js";
import { appendCitations, MAX_OUTPUT_TOKENS, READ_CHUNK_MAX } from "./tools.js";
import { workspaceInstructionsBlock } from "./agent-instructions.js";

/** The one "don't know" reply, used by both the system prompt and the nudge. */
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
- If the tools do not turn up an answer, say exactly: "${DONT_KNOW}" Do not pad it with guesses or with what you know generally.
- Be concise and synthesize; do not paste passages back verbatim.`;

function buildTools(): ToolSpec[] {
  return [
    {
      name: "list_databases",
      description:
        "List the user's structured databases with their tables, columns and physical SQL names. Call before query_database.",
      inputSchema: { json: { type: "object", properties: {} } },
    },
    {
      name: "query_database",
      description:
        `Run one read-only SELECT (SQLite dialect) against a structured database. Use physical names from list_databases. Aggregate in SQL; results cap at ${DATABASE_ASK_QUERY_MAX_ROWS} rows.`,
      inputSchema: {
        json: {
          type: "object",
          properties: {
            database_id: { type: "string", description: "The database to query (from list_databases)." },
            sql: { type: "string", description: "One SELECT statement. Bind nothing; write literal values." },
          },
          required: ["database_id", "sql"],
        },
      },
    },
    {
      name: "search_documents",
      description: "Search the user's documents for relevant passages. Returns numbered, citable passages.",
      inputSchema: {
        json: {
          type: "object",
          properties: { query: { type: "string", description: "What to search for." } },
          required: ["query"],
        },
      },
    },
    {
      name: "read_document",
      description:
        "Read a slice of one document (offset + length in characters). Get doc_id from a search result header or list_documents.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            doc_id: { type: "string", description: "The document to read." },
            offset: { type: "integer", description: "Start character offset (0-based)." },
            length: { type: "integer", description: `Chars to read (max ${READ_CHUNK_MAX}).` },
          },
          required: ["doc_id"],
        },
      },
    },
    {
      name: "list_documents",
      description:
        "List documents you can read (id + title), plus the folders at that level. Filter by title and/or confine to one folder.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional title filter. Glob, not regex: * matches any text, ? one character. Plain text matches anywhere in the title.",
            },
            folder_id: {
              type: "string",
              description: "Optional folder to look inside (its whole subtree). Get one from a previous list_documents result.",
            },
          },
        },
      },
    },
  ];
}

/** Sent at most once, when the model answers before any tool returned material. */
const NO_SEARCH_NUDGE =
  "You answered without searching the user's documents. You must not answer from your own knowledge. " +
  `Call search_documents now and base your answer only on what it returns; if it returns nothing relevant, reply exactly: "${DONT_KNOW}"`;

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

  const dispatch = async (t: ToolUse): Promise<ToolOutcome> => {
    let text: string;
    let isError = false;
    if (t.name === "search_documents") {
      const q = String(((t.input ?? {}) as { query?: unknown }).query ?? "").trim();
      if (!q) {
        text = "error: query is required";
        isError = true;
      } else {
        onStatus?.({ kind: "searching", query: q });
        const found = await runner.search({ query: q, offset: citations.length });
        appendCitations(citations, found.citations);
        grounded = true;
        const step: AskStep = { kind: "search", query: q, hits: found.citations.length };
        steps.push(step);
        onStep?.(step);
        text = found.text || "No relevant passages found.";
      }
    } else if (t.name === "read_document") {
      const a = (t.input ?? {}) as { doc_id?: unknown; offset?: unknown; length?: unknown };
      const docId = String(a.doc_id ?? "").trim();
      if (!docId) {
        text = "error: doc_id is required";
        isError = true;
      } else {
        const offset = Math.max(0, Number(a.offset) || 0);
        const length = Math.min(READ_CHUNK_MAX, Math.max(1, Number(a.length) || READ_CHUNK_MAX));
        const doc = await runner.readDocument({ doc_id: docId, offset, length });
        if (!doc) {
          text = `error: no document ${docId} you can read`;
          isError = true;
        } else if ("error" in doc) {
          text = `error: ${doc.error}`;
          isError = true;
        } else {
          onStatus?.({ kind: "reading", title: doc.title });
          grounded = true;
          const end = offset + doc.text.length;
          const more =
            end < doc.total
              ? `\n---\n[Characters ${offset}–${end} of ${doc.total}. Call read_document again with offset=${end} for more.]`
              : "";
          text = `${doc.title}\n\n${doc.text}${more}`;
          const step: AskStep = { kind: "read", doc_id: docId, title: doc.title, chars: doc.text.length };
          steps.push(step);
          onStep?.(step);
        }
      }
    } else if (t.name === "list_databases") {
      onStatus?.({ kind: "listing" });
      const dbs = await runner.listDatabases();
      if (dbs.length === 0) {
        text = "No structured databases you can read.";
      } else {
        text = dbs
          .map((d) => `database_id: ${d.database_id}\ntitle: ${d.title || "Untitled"}\n${d.schema}`)
          .join("\n\n");
      }
    } else if (t.name === "query_database") {
      const a = (t.input ?? {}) as { database_id?: unknown; sql?: unknown };
      const databaseId = String(a.database_id ?? "").trim();
      const sqlText = String(a.sql ?? "").trim();
      if (!databaseId || !sqlText) {
        text = "error: database_id and sql are required";
        isError = true;
      } else {
        onStatus?.({ kind: "querying", title: databaseId });
        const out = await runner.queryDatabase({ database_id: databaseId, sql: sqlText });
        if ("error" in out) {
          text = `error: ${out.error}`;
          isError = true;
        } else {
          grounded = true;
          const header = out.columns.join(" | ");
          const body = out.rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))).join(" | ")).join("\n");
          text =
            `Database: ${out.title || "Untitled"}\n${out.rows.length} row${out.rows.length === 1 ? "" : "s"}` +
            `${out.truncated ? " (truncated — aggregate or filter for the rest)" : ""}\n${header}\n${body}`;
          const step: AskStep = { kind: "query", database_id: databaseId, title: out.title, sql: sqlText, rows: out.rows.length };
          steps.push(step);
          onStep?.(step);
        }
      }
    } else if (t.name === "list_documents") {
      onStatus?.({ kind: "listing" });
      const args = (t.input ?? {}) as { query?: unknown; folder_id?: unknown };
      const q = String(args.query ?? "").trim();
      const folderId = String(args.folder_id ?? "").trim();
      const res = await runner.listDocuments({ query: q || undefined, folder_id: folderId || undefined });
      if (res.folderMissing) {
        text = `error: no folder ${folderId} you can read`;
        isError = true;
      } else {
        const folderLines = res.folders.map((f) => `${f.folder_id}  ${f.title || "Untitled"}/`);
        const docLines = res.docs.map((d) => `${d.doc_id}  ${d.title || "Untitled"}`);
        const parts: string[] = [];
        if (folderLines.length) parts.push(`Folders:\n${folderLines.join("\n")}`);
        if (docLines.length) parts.push(`Documents:\n${docLines.join("\n")}`);
        if (res.docs.length === LIST_LIMIT) {
          parts.push(`[Showing the first ${LIST_LIMIT} documents. Narrow with a title filter or a folder_id.]`);
        }
        text = parts.length ? parts.join("\n\n") : "No documents matched.";
        const step: AskStep = { kind: "list", count: res.docs.length, folders: res.folders.length, query: q || null };
        steps.push(step);
        onStep?.(step);
      }
    } else {
      text = `error: unknown tool ${t.name}`;
      isError = true;
    }
    return { text, isError };
  };

  const result = await runAgentLoop({
    cfg,
    modelId,
    // Instructions go last, and the prompt is unchanged when there are none.
    system: SYSTEM + workspaceInstructionsBlock(input.workspaceInstructions),
    tools: buildTools(),
    maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
    maxTokens: MAX_OUTPUT_TOKENS,
    history: input.history,
    seed: `${scope}Question: ${input.question}`,
    signal: input.signal,
    beforeRound: input.beforeRound,
    dispatch,
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
  };
}
