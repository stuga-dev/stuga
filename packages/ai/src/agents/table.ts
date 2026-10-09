/**
 * The structured-database co-author loop: schema and read-only SQL for reads,
 * and writes staged through the runner as the model emits them. Each staged op
 * is a run-ledger proposal, parked or applied at once per the database's
 * setting, so the model gets per-op validation feedback and the pre-minted ids
 * it needs to chain follow-up ops onto pending work.
 */
import type { AskStopReason } from "@stuga/protocol/api/ask";
import { DATABASE_COLUMN_TYPES } from "@stuga/protocol/databases/types";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { AiCitation, AiHistoryItem } from "@stuga/protocol/wire/doc-socket";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AiConfig } from "../config.js";
import type { ModelFailure } from "../failure.js";
import { resolveModel } from "../models.js";
import type { TokenUsage } from "../types.js";
import { filterCited, runAgentLoop, textTool } from "./loop.js";
import { appendCitations, MAX_OUTPUT_TOKENS, searchCollectionTool } from "./tools.js";
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
  /** The database applies agent changes at once, without review. */
  applyAtOnce?: boolean;
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
  /**
   * Stage one op (the run-propose body shape): the text carries minted ids, `applied` says it
   * landed at once; a refusal comes back as `error`.
   */
  stageOp(op: Record<string, unknown>): Promise<{ staged: true; applied: boolean; text: string } | { staged: false; error: string }>;
  /** Failures come back as `text` with no citations. */
  searchCollection?(input: { query: string }): Promise<{ text: string; citations: AiCitation[] }>;
}

export interface TableAgentResult {
  /** Prose across the whole turn, already streamed. */
  prose: string;
  /** Ops staged this turn for review. */
  staged: number;
  /** Ops applied at once this turn. */
  applied: number;
  /** Sources the prose cited. Citations never go into cells, which are typed user data. */
  citations: AiCitation[];
  usage: TokenUsage;
  modelId: string;
  rounds: number;
  /** Anything but "complete" is incomplete; staged ops are already in the ledger and must still be reported. */
  stopReason: AskStopReason;
  error?: string;
  /** With "error": what failed. */
  failure?: ModelFailure;
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
{{WRITES}}
- insert_rows(table, rows): rows are objects of column name → value. Returns the new rows' _ids — use them to reference these rows in later calls even before they are accepted.
- update_rows(table, updates): updates are [{_id, values}].
- delete_rows(table, row_ids).
- add_column(table, name, type, choices?): types are text, number, checkbox (true/false), date ("YYYY-MM-DD"), single_select (requires choices), files (attachments the user uploads).
A files cell holds links to files stored with the database, one per line. You cannot upload a file: keep the links a cell holds, and never write one you did not read from this database.
- create_table(name): a new empty table (add columns next).
Making a change means CALLING a tool — describing it in prose stages nothing and the user sees nothing to accept.
Guidance: read before you write (query for _ids, get_schema for column names and types); batch related rows into ONE insert_rows/update_rows call rather than many; make the smallest set of changes that satisfies the request; briefly say what you proposed and why, in the language of the request; new cell text follows the language the table already uses. A tool error means that one change was refused — fix the input and retry that change, or explain why it cannot be done.`;

const REVIEW_LINE =
  "Proposing changes (each call stages ONE change for the user to Accept or Reject in their grid — changes are NOT applied until accepted):";
const APPLY_AT_ONCE_LINE =
  "Making changes (this database is set to apply agent changes at once: each call applies ONE change without review, and the user can revert it):";

const TABLE = Type.String({ description: "Table reference: table_id, physical name, or display name." });
/** One `type` list rather than `anyOf`, which some OpenAI-compatible servers mishandle. */
const CELL = Type.Unsafe<string | number | boolean | null>({ type: ["string", "number", "boolean", "null"] });
const ROW = Type.Object({}, { additionalProperties: CELL });

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
  const system =
    SYSTEM.replace("{{SEARCH_TOOL}}", collectionEnabled ? `${SEARCH_TOOL_LINE}\n` : "").replace(
      "{{WRITES}}",
      input.applyAtOnce ? APPLY_AT_ONCE_LINE : REVIEW_LINE,
    ) +
    instructionsBlock(input.instructions);

  const schemaSeed =
    input.schemaJson.length <= SCHEMA_PREVIEW_CHARS
      ? input.schemaJson
      : `${input.schemaJson.slice(0, SCHEMA_PREVIEW_CHARS)}… [truncated — call get_schema for the full schema]`;
  const contextBlock =
    `Database schema:\n${schemaSeed}\n` +
    (input.activeTable ? `\nThe user is currently looking at the table "${input.activeTable}".` : "");

  let staged = 0;
  let applied = 0;
  const citations: AiCitation[] = [];

  /** A tool that stages one change, built from its arguments as a run-propose op. */
  const stagingTool = <T extends TSchema>(name: string, description: string, parameters: T, op: (args: Static<T>) => Record<string, unknown>) =>
    textTool(name, description, parameters, async (args) => {
      onStatus?.({ kind: "proposing" });
      const out = await runner.stageOp(op(args));
      if (!out.staged) throw new Error(out.error);
      if (out.applied) applied++;
      else staged++;
      return out.text;
    });

  const tools: AgentTool[] = [
    textTool(
      "get_schema",
      "Read the database schema: tables, typed columns with their descriptions, row counts, and your pending proposals.",
      Type.Object({}),
      async () => {
        onStatus?.({ kind: "reading" });
        return runner.getSchema();
      },
    ),
    textTool(
      "query",
      "Run ONE read-only SELECT (SQLite). Bind user values via params and ? placeholders. Select _id for rows you may change.",
      Type.Object({
        sql: Type.String({ description: "The SELECT statement." }),
        params: Type.Optional(Type.Array(CELL, { description: "Bound values for ? placeholders." })),
      }),
      async ({ sql, params }) => {
        onStatus?.({ kind: "querying" });
        if (!sql.trim()) throw new Error("sql is required");
        return runner.query({ sql, params: params?.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p)) });
      },
    ),
    stagingTool(
      "insert_rows",
      "Propose inserting rows. Each row is an object of column name → value.",
      Type.Object({ table: TABLE, rows: Type.Array(ROW, { description: "Rows to insert." }) }),
      ({ table, rows }) => ({ kind: "rows.insert", table, rows }),
    ),
    stagingTool(
      "update_rows",
      "Propose updating rows by _id (get _ids from query, or from an insert_rows result).",
      Type.Object({ table: TABLE, updates: Type.Array(Type.Object({ _id: Type.String(), values: ROW })) }),
      ({ table, updates }) => ({ kind: "rows.update", table, updates }),
    ),
    stagingTool(
      "delete_rows",
      "Propose deleting rows by _id.",
      Type.Object({ table: TABLE, row_ids: Type.Array(Type.String()) }),
      ({ table, row_ids }) => ({ kind: "rows.delete", table, row_ids }),
    ),
    stagingTool(
      "add_column",
      `Propose a new column. type: ${DATABASE_COLUMN_TYPES.join(" | ")} (single_select needs choices).`,
      Type.Object({
        table: TABLE,
        name: Type.String({ description: "Column display name." }),
        type: Type.String({ enum: [...DATABASE_COLUMN_TYPES] }),
        choices: Type.Optional(Type.Array(Type.String(), { description: "single_select only: the allowed values." })),
      }),
      ({ table, name, type, choices }) => ({ kind: "columns.add", table, display: name, type, choices }),
    ),
    stagingTool(
      "create_table",
      "Propose a new empty table (then add_column / insert_rows against it).",
      Type.Object({ name: Type.String({ description: "Table display name." }) }),
      ({ name }) => ({ kind: "tables.create", display: name }),
    ),
  ];
  if (collectionEnabled) {
    tools.push(
      searchCollectionTool(async (query) => {
        onStatus?.({ kind: "searching", query });
        const found = await runner.searchCollection!({ query });
        appendCitations(citations, found.citations);
        return found.text || "No relevant passages found.";
      }),
    );
  }

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
    onChunk,
    onRoundStart: () => onStatus?.({ kind: "thinking" }),
  });

  return {
    prose: result.prose,
    staged,
    applied,
    // Cell values are not scanned: markers are forbidden there.
    citations: filterCited(result.prose, citations),
    usage: result.usage,
    modelId,
    rounds: result.rounds,
    stopReason: result.stopReason,
    error: result.error,
    failure: result.failure,
  };
}
