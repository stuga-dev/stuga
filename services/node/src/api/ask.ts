/** Ask: saved research threads, and the streamed cross-document agentic answer. */
import { type AskAgentActivity, runAskAgentTurn } from "@stuga/ai";
import type { AskStopReason } from "@stuga/protocol/api/ask";
import {
  appendAskTurn,
  createAskThread,
  deleteAskThread,
  getAskThread,
  getWorkspace,
  insertAiUsage,
  listAskThreads,
  listAskTurns,
  renameAskThread,
  setAskThreadTitleIfEmpty,
} from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { ownedCollection } from "../authz/authz.js";
import { error, json, sse } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";
import { collectionScope } from "../retrieval/scope.js";
import { createAskRunner } from "../retrieval/ask-runner.js";

/** The thread when the caller owns it in the active workspace; callers answer null with 404, never 403. */
async function authorizedAskThread(ctx: Ctx, threadId: string) {
  const thread = await getAskThread(ctx.sql, threadId);
  if (!thread) return null;
  if (thread.workspace_id !== ctx.workspaceId) return null;
  if (thread.owner !== ctx.alias) return null;
  return thread;
}

/** One-line label for what the ask agent is doing, for the panel's status line. */
function activityLabel(a: AskAgentActivity): string {
  switch (a.kind) {
    case "searching":
      return `Searching “${a.query}”…`;
    case "reading":
      return `Reading “${a.title || "a document"}”…`;
    case "listing":
      return "Looking through your documents…";
    case "querying":
      return "Querying a database…";
    default:
      return "Thinking…";
  }
}

/** The caveat shown under an answer that was not a clean, fully grounded finish; null when there is none. */
function turnNotice(stop: AskStopReason, degraded: boolean): string | null {
  if (stop === "max_rounds") return "I stopped after the maximum number of research steps — ask a follow-up to continue.";
  if (stop === "budget") return "The AI budget ran out part-way through the answer.";
  if (stop === "aborted") return "Stopped.";
  if (stop === "error") return "Something failed part-way through; this answer may be incomplete.";
  if (degraded) return "Search by meaning was unavailable, so this matched words only. Results may be less relevant.";
  return null;
}

// Not guest-forbidden: asking is read-only and confers no authority over any document.
export async function listAskThreadsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  return json({ threads: await listAskThreads(ctx.sql, ctx.workspaceId, ctx.alias) });
}

export async function createAskThreadRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { title?: string; collection_id?: string };
  if (body.collection_id && !(await ownedCollection(ctx, body.collection_id))) {
    return error(404, "not found");
  }
  const thread = await createAskThread(ctx.sql, {
    threadId: newId("ask_"),
    workspaceId: ctx.workspaceId,
    owner: ctx.alias,
    title: (body.title ?? "").trim().slice(0, 200),
    collectionId: body.collection_id ?? null,
  });
  return json(thread, { status: 201 });
}

export async function getAskThreadRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  const threadId = match[1]!;
  const thread = await authorizedAskThread(ctx, threadId);
  if (!thread) return error(404, "not found");
  // Model ids and token counts are usage data, not part of the conversation.
  const turns = (await listAskTurns(ctx.sql, threadId)).map((t) => ({
    thread_id: t.thread_id,
    seq: t.seq,
    question: t.question,
    answer: t.answer,
    citations: t.citations,
    steps: t.steps,
    created_at: t.created_at,
  }));
  return json({ thread, turns });
}

export async function renameAskThreadRoute({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const threadId = match[1]!;
  const thread = await authorizedAskThread(ctx, threadId);
  if (!thread) return error(404, "not found");
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  if (typeof body.title !== "string" || !body.title.trim()) return error(400, "title required");
  const updated = await renameAskThread(ctx.sql, threadId, body.title.trim().slice(0, 200));
  return updated ? json(updated) : error(404, "not found");
}

export async function deleteAskThreadRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  const threadId = match[1]!;
  const thread = await authorizedAskThread(ctx, threadId);
  if (!thread) return error(404, "not found");
  await deleteAskThread(ctx.sql, threadId);
  return json({ deleted: true });
}

// A bounded model/tool loop over read-only, ACL-filtered tools, streamed over SSE with citations.
export async function ask({ ctx, req }: WorkspaceCall): Promise<Response> {
  if (!ctx.env.aiSettings.current().chat.enabled) return error(503, "AI chat is disabled on this node");
  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    model?: string;
    collection_id?: string;
    thread_id?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  };
  const question = (body.question ?? "").trim().slice(0, 4000);
  if (!question) return error(400, "question required");

  // Thread and scope resolve before the stream opens, so a bad id is a clean 404.
  const thread = body.thread_id ? await authorizedAskThread(ctx, body.thread_id) : null;
  if (body.thread_id && !thread) return error(404, "not found");

  const collectionId = body.collection_id ?? thread?.collection_id ?? undefined;
  const scopeDocIds = await collectionScope(ctx, collectionId);
  if (scopeDocIds === "not-found") return error(404, "not found");

  // A thread's stored history wins over the client's, which could rewrite what
  // the assistant said. The last 3 turns (6 messages), each capped.
  const history = thread
    ? (await listAskTurns(ctx.sql, thread.thread_id))
        .slice(-3)
        .flatMap((t) => [
          { role: "user" as const, content: t.question.slice(0, 4000) },
          { role: "assistant" as const, content: t.answer.slice(0, 4000) },
        ])
        .filter((h) => h.content.trim() !== "")
    : (Array.isArray(body.history) ? body.history : [])
        .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
        .slice(-6)
        .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
  const model: string = body.model ?? "auto";
  const aiCfg = ctx.env.aiSettings.current();

  const scopeLabel = scopeDocIds === null ? "all your documents" : "the selected collection, and nothing outside it";
  // Per request, so an edited instruction applies to the next question; house style, so a failed read is none.
  const workspaceInstructions = (await getWorkspace(ctx.sql, ctx.workspaceId).catch(() => null))?.agent_instructions ?? "";

  return sse(async (send, signal) => {
    const { runner, degraded } = createAskRunner({ ctx, aiCfg, scopeDocIds, topN: 8 });

    const result = await runAskAgentTurn(
      aiCfg,
      {
        question,
        model,
        history,
        scopeLabel,
        workspaceInstructions,
        signal,
      },
      runner,
      {
        onChunk: (text) => send("token", { text }),
        onStatus: (a) => send("status", { label: activityLabel(a) }),
        onStep: (step) => send("step", step),
        // The model answered from memory and is sent back to search: drop the uncited draft.
        onReset: () => send("reset", {}),
      },
    );

    // One usage row for the turn; each search records its own embedding and rerank rows.
    await insertAiUsage(ctx.sql, {
      alias: ctx.alias,
      workspaceId: ctx.workspaceId,
      docId: null,
      kind: "ask",
      model: result.modelId,
      status: result.stopReason === "error" ? "error" : undefined,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadInputTokens,
      cacheWriteTokens: result.usage.cacheWriteInputTokens,
    }).catch(() => {});

    // Persisted before `done`, aborted and capped turns included.
    if (thread) {
      await appendAskTurn(ctx.sql, {
        threadId: thread.thread_id,
        question,
        answer: result.prose,
        citations: result.citations,
        steps: result.steps,
        model: result.modelId,
        rounds: result.rounds,
        stopReason: result.stopReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      }).catch(() => {});
      await setAskThreadTitleIfEmpty(ctx.sql, thread.thread_id, question.slice(0, 120)).catch(() => {});
    }

    send("done", {
      citations: result.citations,
      rounds: result.rounds,
      stop_reason: result.stopReason,
      notice: turnNotice(result.stopReason, degraded()),
    });
  });
}
