/**
 * The tables' in-app co-author. It runs in the request layer, which owns usage
 * attribution and the model configuration, and stages its changes on the run
 * ledger under the panel identity, where they always park for the person.
 */
import { type AiConfig, type TableToolRunner, runTableAgentTurn } from "@stuga/ai";
import { type DocRow, insertAiUsage, touchDoc } from "@stuga/db";
import { selectOnlyViolation } from "@stuga/protocol/databases/sql-guard";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { ALL_DOCUMENTS_SCOPE } from "@stuga/protocol/wire/doc-socket";
import type { Ctx } from "../auth/context.js";
import { scopeFolderIds } from "../authz/authz.js";
import { docInstructionStack } from "../documents/instructions.js";
import { error, sse } from "../http/respond.js";
import { passageCitations } from "../retrieval/passages.js";
import { retrieveAndRerank } from "../retrieval/retrieve.js";
import { collectionScope } from "../retrieval/scope.js";
import { callDatabaseActor, panelActor } from "./gate.js";
import type { DatabaseCall } from "./routes.js";

const PROMPT_MAX = 4000;
const HISTORY_TURNS = 6;

/** The tools one co-author turn runs, and the run its staged ops landed on. */
export function tableToolRunner(
  ctx: Ctx,
  doc: DocRow,
  aiCfg: AiConfig,
  collectionId: string | null,
): { runner: TableToolRunner; runId: () => string | null } {
  const actor = panelActor(ctx);
  const docId = doc.doc_id;
  let runId: string | null = null;
  // Keeps the [n] numbers in result text in step with the loop's own citation counter.
  let citationOffset = 0;

  const runner: TableToolRunner = {
    getSchema: async () => {
      const res = await callDatabaseActor(ctx, docId, `schema?agent=${encodeURIComponent(actor.alias)}`, null, "GET");
      return res.ok ? await res.text() : "error: could not load the schema";
    },
    query: async ({ sql: sqlText, params }) => {
      const violation = selectOnlyViolation(sqlText);
      if (violation) return `error: ${violation}`;
      const res = await callDatabaseActor(ctx, docId, "query", { sql: sqlText, params }, "POST", actor);
      const text = await res.text();
      if (res.ok) return text;
      let message: string | undefined;
      try {
        message = (JSON.parse(text) as { message?: string }).message;
      } catch {
        message = undefined;
      }
      return `error: ${message ?? `query failed (${res.status})`}`;
    },
    stageOp: async (op) => {
      const res = await callDatabaseActor(
        ctx,
        docId,
        "runs/propose",
        {
          op,
          source: "panel",
          agent: "AI co-author",
          reviewer: ctx.alias,
          workspace_id: ctx.workspaceId,
          doc_title: doc.title || "Untitled",
        },
        "POST",
        actor,
      );
      const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !parsed) {
        const msg = (parsed as { message?: string } | null)?.message ?? "the change was refused";
        return { text: `error: ${msg}`, isError: true, staged: false };
      }
      const run = parsed.run as DatabaseRunSummary | undefined;
      if (run) runId = run.id;
      const minted = (parsed.minted ?? {}) as Record<string, unknown>;
      const mintedNote = Object.keys(minted).length ? ` ${JSON.stringify(minted)}` : "";
      return { text: `ok: staged for the user's review.${mintedNote}`, isError: false, staged: true };
    },
    // Offered only with a collection selected. Never throws: a refusal is text the model can act on.
    searchCollection: collectionId
      ? async ({ query }) => {
          try {
            const scopeDocIds = await collectionScope(ctx, collectionId === ALL_DOCUMENTS_SCOPE ? null : collectionId);
            if (scopeDocIds === "not-found") return { text: "That collection is not available.", citations: [] };
            const { chunks } = await retrieveAndRerank({
              sql: ctx.sql,
              embeddingDims: ctx.env.embeddingDims,
              searchLanguages: () => ctx.env.searchLanguages.current(),
              aiCfg,
              alias: ctx.alias,
              principals: ctx.principals,
              workspaceId: ctx.workspaceId,
              query,
              scopeDocIds,
              scopeFolderIds: scopeFolderIds(ctx),
              topN: 8,
            });
            if (chunks.length === 0) return { text: "No relevant passages found in the knowledge base.", citations: [] };
            const offset = citationOffset;
            citationOffset += chunks.length;
            const text = chunks
              .map((c, i) => `[${offset + i + 1}] ${c.title}${c.heading_path ? ` — ${c.heading_path}` : ""}\n${c.content}`)
              .join("\n\n");
            return { text, citations: passageCitations(chunks, offset) };
          } catch (e) {
            return { text: `Search failed: ${e instanceof Error ? e.message : String(e)}`, citations: [] };
          }
        }
      : undefined,
  };
  return { runner, runId: () => runId };
}

export async function databaseCoauthor({ ctx, doc, docId, writeRefusal, body }: DatabaseCall): Promise<Response> {
  if (ctx.isAgent) return error(403, "agents use the MCP databases tool");
  const r = writeRefusal();
  if (r) return r;
  const ai = ctx.env.aiSettings.current();
  if (!ai.chat.enabled) return error(503, "AI chat is disabled on this node");
  const b = await body();
  const prompt = (typeof b.prompt === "string" ? b.prompt : "").trim().slice(0, PROMPT_MAX);
  if (!prompt) return error(400, "prompt required");
  const history = (Array.isArray(b.history) ? (b.history as Array<{ role?: string; content?: string }>) : [])
    .filter((h): h is { role: "user" | "assistant"; content: string } =>
      !!h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string",
    )
    .slice(-HISTORY_TURNS)
    .map((h) => ({ role: h.role, content: h.content.slice(0, PROMPT_MAX) }));
  const model = typeof b.model === "string" ? b.model : "auto";
  const activeTable = typeof b.active_table === "string" ? b.active_table.slice(0, 200) : null;
  // No collection means the search tool is not offered at all.
  const collectionId = typeof b.collection_id === "string" && b.collection_id ? b.collection_id : null;

  // Read before the stream opens, so a broken actor is a clean 502.
  const schemaRes = await callDatabaseActor(ctx, docId, `schema?agent=${encodeURIComponent(panelActor(ctx).alias)}`, null, "GET");
  if (!schemaRes.ok) return error(502, "could not load the schema");
  const schemaJson = await schemaRes.text();

  const { runner, runId } = tableToolRunner(ctx, doc, ai, collectionId);
  // Per turn, and as this person reads the tree. House style, so a failed read runs the turn without them.
  const instructions = await docInstructionStack(ctx, doc).catch(() => []);

  // The signal fires when the browser drops the response; ops already staged stay in the ledger.
  return sse(async (send, signal) => {
    try {
      const result = await runTableAgentTurn(
        ai,
        {
          prompt,
          schemaJson,
          activeTable,
          model,
          history,
          collectionEnabled: collectionId !== null,
          instructions,
          signal,
        },
        runner,
        (text) => send("token", { text }),
        (activity) => {
          const label =
            activity.kind === "reading"
              ? "Reading the schema…"
              : activity.kind === "querying"
                ? "Querying the table…"
                : activity.kind === "searching"
                  ? `Searching for “${activity.query}”…`
                  : activity.kind === "proposing"
                    ? "Proposing changes…"
                    : "Thinking…";
          send("status", { label });
        },
      );
      if (result.modelId) {
        await insertAiUsage(ctx.sql, {
          alias: ctx.alias,
          workspaceId: ctx.workspaceId,
          docId: doc.doc_id,
          kind: "table_coauthor",
          model: result.modelId,
          // Rounds that ran were spent, even on an incomplete turn.
          status: result.stopReason === "error" ? "error" : undefined,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadInputTokens,
          cacheWriteTokens: result.usage.cacheWriteInputTokens,
        }).catch(() => {});
      }
      await touchDoc(ctx.sql, doc.doc_id).catch(() => {});

      // A failed turn that staged ops still reports them: they are parked awaiting review.
      if (result.stopReason === "error" && result.staged === 0) {
        send("error", { message: result.error ?? "the AI turn failed" });
        return;
      }
      send("done", {
        staged: result.staged,
        run_id: runId(),
        citations: result.citations,
        notice:
          result.stopReason === "max_rounds"
            ? `Stopped after ${result.rounds} rounds of work. Ask me to continue if there's more to do.`
            : result.stopReason === "error"
              ? `The turn ended early (${result.error ?? "unknown error"}), but the changes above are staged for review.`
              : undefined,
      });
    } catch (e) {
      await insertAiUsage(ctx.sql, {
        alias: ctx.alias,
        workspaceId: ctx.workspaceId,
        docId: doc.doc_id,
        kind: "table_coauthor",
        model: "",
        status: "error",
      }).catch(() => {});
      send("error", { message: e instanceof Error ? e.message : "the AI turn failed" });
    }
  });
}
