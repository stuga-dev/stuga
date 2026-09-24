/**
 * The structured-database co-author loop: schema and read-only SQL for reads,
 * and writes staged through the runner as the model emits them. Each staged op
 * is a run-ledger proposal, so the model gets per-op validation feedback and
 * the pre-minted ids it needs to chain follow-up ops onto pending work.
 */
import type { AskStopReason } from "@stuga/protocol/api/ask";
import { DATABASE_COLUMN_TYPES } from "@stuga/protocol/databases/types";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { AiCitation, AiHistoryItem } from "@stuga/protocol/wire/doc-socket";
import type { AiConfig } from "../config.js";
import { resolveModel } from "../models.js";
import type { TokenUsage, ToolSpec, ToolUse } from "../types.js";
import { runAgentLoop, filterCited, type ToolOutcome } from "./loop.js";
import { appendCitations, MAX_OUTPUT_TOKENS, SEARCH_COLLECTION_TOOL } from "./tools.js";
import { instructionsBlock } from "./agent-instructions.js";

export interface TableAgentInput {
  prompt: string;
  /** The schema as the user's projection sees it, as JSON. */
  schemaJson: string;
  /** Display name of the table the user is looking at. */
  activeTable: string | null;
  /** A model id, or "auto". */
  model: string;
  history: AiHistoryItem[];
  /** Expose search_collection (only when the runner can serve it). */
  collectionEnabled?: boolean;
  maxRounds?: number;
  /** The instructions for agents that apply to the database, outermost first; appended to the system prompt. */
  instructions?: InstructionLevel[];
  /** Cancels the turn; ops staged by finished rounds stay in the ledger and are counted. */
  signal?: AbortSignal;
}

/** Executes reads and stages mutations for the loop. */
export interface TableToolRunner {
  /** Fresh schema JSON, including pending proposals. */
  getSchema(): Promise<string>;
  /** Read-only SELECT; the result JSON, or throws with the SQL error. */
  query(input: { sql: string; params?: Array<string | number | null> }): Promise<string>;
  /** Stage one op (the run-propose body shape). The text carries minted ids, or the refusal as isError. */
  stageOp(op: Record<string, unknown>): Promise<{ text: string; isError: boolean; staged: boolean }>;
  /** Failures come back as `text` with no citations. */
  searchCollection?(input: { query: string }): Promise<{ text: string; citations: AiCitation[] }>;
}

export interface TableAgentResult {
  /** Prose across the whole turn, already streamed. */
  prose: string;
  /** Ops staged this turn. */
  staged: number;
  /** Sources the prose cited. Citations never go into cells, which are typed user data. */
  citations: AiCitation[];
  usage: TokenUsage;
  modelId: string;
  rounds: number;
  /** Anything but "complete" is incomplete; staged ops are already in the ledger and must still be reported. */
  stopReason: AskStopReason;
  error?: string;
}

const DEFAULT_MAX_ROUNDS = 10;
/** Schema JSON beyond this is truncated in the seed; get_schema returns it whole. */
const SCHEMA_PREVIEW_CHARS = 16_000;

const SEARCH_TOOL_LINE = `- search_collection(query): search the user's selected knowledge base of DOCUMENTS for relevant passages. Use it for facts that are not already in the tables — \`query\` reads the data you have, this reads the prose you don't. Cite facts you use with a [^n] marker in YOUR PROSE ONLY.`;

const SYSTEM = `You are a collaborative co-author for a structured database (typed tables of rows), working through tools.
Reading:
- get_schema(): the tables, their typed columns (with column_id and physical SQL name), and row counts. Entries marked "pending": true are your OWN not-yet-accepted proposals.
- query(sql, params?): ONE read-only SELECT (SQLite dialect; JOINs between tables work). Select _id whenever you plan to update or delete rows. Results reflect live data plus nothing of your pending proposals — the schema read is what includes those.
{{SEARCH_TOOL}}NEVER put a [^n] citation marker inside a cell value. Cell values are typed data the user designed the columns for — a marker would corrupt a text cell and fail to coerce into a number or date one. Cite in your prose; the sources are shown to the user beside it.
Proposing changes (each call stages ONE change for the user to Accept or Reject in their grid — changes are NOT applied until accepted):
- insert_rows(table, rows): rows are objects of column name → value. Returns the new rows' _ids — use them to reference these rows in later calls even before they are accepted.
- update_rows(table, updates): updates are [{_id, values}].
- delete_rows(table, row_ids).
- add_column(table, name, type, choices?): types are text, number, checkbox (true/false), date ("YYYY-MM-DD"), single_select (requires choices).
- create_table(name): a new empty table (add columns next).
Making a change means CALLING a tool — describing it in prose stages nothing and the user sees nothing to accept.
Guidance: read before you write (query for _ids, get_schema for column names and types); batch related rows into ONE insert_rows/update_rows call rather than many; make the smallest set of changes that satisfies the request; briefly say what you proposed and why. A tool error means that one change was refused — fix the input and retry that change, or explain why it cannot be done.`;

function buildTools(collectionEnabled: boolean): ToolSpec[] {
  const table = { table: { type: "string", description: "Table reference: table_id, physical name, or display name." } };
  const cell = { type: ["string", "number", "boolean", "null"] };
  const tools: ToolSpec[] = [
    {
      name: "get_schema",
      description: "Read the database schema: tables, typed columns with their descriptions, row counts, and your pending proposals.",
      inputSchema: { json: { type: "object", properties: {} } },
    },
    {
      name: "query",
      description:
        "Run ONE read-only SELECT (SQLite). Bind user values via params and ? placeholders. Select _id for rows you may change.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            sql: { type: "string", description: "The SELECT statement." },
            params: { type: "array", items: cell, description: "Bound values for ? placeholders." },
          },
          required: ["sql"],
        },
      },
    },
    {
      name: "insert_rows",
      description: "Propose inserting rows. Each row is an object of column name → value.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            ...table,
            rows: { type: "array", items: { type: "object", additionalProperties: cell }, description: "Rows to insert." },
          },
          required: ["table", "rows"],
        },
      },
    },
    {
      name: "update_rows",
      description: "Propose updating rows by _id (get _ids from query, or from an insert_rows result).",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            ...table,
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: { _id: { type: "string" }, values: { type: "object", additionalProperties: cell } },
                required: ["_id", "values"],
              },
            },
          },
          required: ["table", "updates"],
        },
      },
    },
    {
      name: "delete_rows",
      description: "Propose deleting rows by _id.",
      inputSchema: {
        json: {
          type: "object",
          properties: { ...table, row_ids: { type: "array", items: { type: "string" } } },
          required: ["table", "row_ids"],
        },
      },
    },
    {
      name: "add_column",
      description: `Propose a new column. type: ${DATABASE_COLUMN_TYPES.join(" | ")} (single_select needs choices).`,
      inputSchema: {
        json: {
          type: "object",
          properties: {
            ...table,
            name: { type: "string", description: "Column display name." },
            type: { type: "string", enum: [...DATABASE_COLUMN_TYPES] },
            choices: { type: "array", items: { type: "string" }, description: "single_select only: the allowed values." },
          },
          required: ["table", "name", "type"],
        },
      },
    },
    {
      name: "create_table",
      description: "Propose a new empty table (then add_column / insert_rows against it).",
      inputSchema: {
        json: { type: "object", properties: { name: { type: "string", description: "Table display name." } }, required: ["name"] },
      },
    },
  ];
  if (collectionEnabled) tools.push(SEARCH_COLLECTION_TOOL);
  return tools;
}

/** The run-propose op body for a staging tool call, or null for other tools. */
function opOf(t: ToolUse): Record<string, unknown> | null {
  const input = (t.input ?? {}) as Record<string, unknown>;
  switch (t.name) {
    case "insert_rows":
      return { kind: "rows.insert", table: input.table, rows: input.rows };
    case "update_rows":
      return { kind: "rows.update", table: input.table, updates: input.updates };
    case "delete_rows":
      return { kind: "rows.delete", table: input.table, row_ids: input.row_ids };
    case "add_column":
      return { kind: "columns.add", table: input.table, display: input.name, type: input.type, choices: input.choices };
    case "create_table":
      return { kind: "tables.create", display: input.name };
    default:
      return null;
  }
}

export type TableAgentActivity =
  | { kind: "thinking" }
  | { kind: "reading" }
  | { kind: "querying" }
  | { kind: "searching"; query: string }
  | { kind: "proposing" };

export async function runTableAgentTurn(
  cfg: AiConfig,
  input: TableAgentInput,
  runner: TableToolRunner,
  onChunk: (text: string) => void,
  onStatus?: (activity: TableAgentActivity) => void,
): Promise<TableAgentResult> {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const modelId = resolveModel(cfg, input.model);
  const collectionEnabled = input.collectionEnabled === true && typeof runner.searchCollection === "function";
  const tools = buildTools(collectionEnabled);
  const system =
    SYSTEM.replace("{{SEARCH_TOOL}}", collectionEnabled ? `${SEARCH_TOOL_LINE}\n` : "") +
    instructionsBlock(input.instructions);

  const schemaSeed =
    input.schemaJson.length <= SCHEMA_PREVIEW_CHARS
      ? input.schemaJson
      : `${input.schemaJson.slice(0, SCHEMA_PREVIEW_CHARS)}… [truncated — call get_schema for the full schema]`;
  const contextBlock =
    `Database schema:\n${schemaSeed}\n` +
    (input.activeTable ? `\nThe user is currently looking at the table "${input.activeTable}".` : "");

  let staged = 0;
  const citations: AiCitation[] = [];

  const dispatch = async (t: ToolUse): Promise<ToolOutcome> => {
    let text: string;
    let isError = false;
    if (t.name === "get_schema") {
      onStatus?.({ kind: "reading" });
      text = await runner.getSchema();
    } else if (t.name === "query") {
      onStatus?.({ kind: "querying" });
      const q = (t.input ?? {}) as { sql?: unknown; params?: unknown };
      if (typeof q.sql !== "string" || q.sql.trim() === "") {
        text = "error: sql is required";
        isError = true;
      } else {
        text = await runner.query({
          sql: q.sql,
          params: Array.isArray(q.params)
            ? q.params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : (p as string | number | null)))
            : undefined,
        });
      }
    } else if (t.name === "search_collection") {
      const q = String(((t.input ?? {}) as { query?: unknown }).query ?? "").trim();
      if (!q) {
        text = "error: query is required";
        isError = true;
      } else if (!runner.searchCollection) {
        text = "error: knowledge-base search is unavailable for this session";
        isError = true;
      } else {
        onStatus?.({ kind: "searching", query: q });
        const found = await runner.searchCollection({ query: q });
        appendCitations(citations, found.citations);
        text = found.text || "No relevant passages found.";
      }
    } else {
      const op = opOf(t);
      if (!op) {
        text = `error: unknown tool ${t.name}`;
        isError = true;
      } else {
        onStatus?.({ kind: "proposing" });
        const out = await runner.stageOp(op);
        text = out.text;
        isError = out.isError;
        if (out.staged) staged++;
      }
    }
    return { text, isError };
  };

  const result = await runAgentLoop({
    cfg,
    modelId,
    system,
    tools,
    maxRounds,
    maxTokens: MAX_OUTPUT_TOKENS,
    history: input.history,
    seed: `${contextBlock}\n\nRequest: ${input.prompt}`,
    signal: input.signal,
    dispatch,
    onChunk,
    onRoundStart: () => onStatus?.({ kind: "thinking" }),
  });

  return {
    prose: result.prose,
    staged,
    // Cell values are not scanned: markers are forbidden there.
    citations: filterCited(result.prose, citations),
    usage: result.usage,
    modelId,
    rounds: result.rounds,
    stopReason: result.stopReason,
    error: result.error,
  };
}
