/**
 * The loop the co-author, ask and table agents share, on Pi's `Agent`: Pi
 * streams each round, validates each tool call against its schema, runs the
 * calls in order, and replays each vendor's reasoning and tool calls between
 * rounds. This module maps its events to prose, usage, the agent's finish
 * policy and a stop reason, and reports failures in the result rather than
 * throwing.
 */
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type AssistantMessage, type ImageContent, type Model, type Static, type StopReason, type TSchema } from "@earendil-works/pi-ai";
import type { AskStopReason } from "@stuga/protocol/api/ask";
import type { AiHistoryItem } from "@stuga/protocol/wire/doc-socket";
import { outputCap, streamChat } from "../chat.js";
import type { AiConfig } from "../config.js";
import { requestFailure, type ModelFailure } from "../failure.js";
import { chatTarget } from "../models.js";
import { addUsage, usageOf, ZERO_USAGE, type TokenUsage } from "../types.js";

/**
 * What to do when the model tries to end its turn. `nudge` sends one more user
 * message and costs a round; `resetProse` also discards the prose streamed so
 * far. The hook must latch each nudge itself; the loop does not count them.
 */
export type FinishDecision =
  | { action: "accept" }
  | {
      action: "nudge";
      message: string;
      resetProse?: boolean;
      /** Stand-in assistant text for a round that produced none. */
      placeholder?: string;
    };

/** What the finishing round produced, for the hook to decide on. */
export interface FinishContext {
  /** Why the round ended: "end_turn", "max_tokens", or the provider's own word. */
  stopReason: string;
  /** Assistant text from this round only. */
  roundText: string;
  /** 1-based index of the round that just completed. */
  round: number;
  maxRounds: number;
}

export interface AgentLoopSpec {
  cfg: AiConfig;
  modelId: string;
  system: string;
  tools: AgentTool[];
  maxRounds: number;
  maxTokens: number;
  /** Prior turns; blank ones are dropped. */
  history: AiHistoryItem[];
  /** The user turn that starts this exchange (prompt + any context preamble). */
  seed: string;
  /** Placed before the seed text: models attend better when the instruction follows the image. */
  seedImages?: ImageContent[];
  /** Cuts the stream in flight; the turn ends "aborted" with finished rounds intact. */
  signal?: AbortSignal;
  /** Runs before every round after the first; a non-empty string stops the turn with "budget". */
  beforeRound?: (round: number) => Promise<string | null | undefined | void>;
  /** Omitted = always accept. */
  onFinishAttempt?: (ctx: FinishContext) => FinishDecision;
  /** Streamed assistant text, including the blank line injected between rounds. */
  onChunk: (text: string) => void;
  /** Fires once per round, before the model call. */
  onRoundStart?: () => void;
  /** Fires when a nudge discarded the prose streamed so far. */
  onResetProse?: () => void;
}

export interface AgentLoopResult {
  /** Assistant prose across the whole turn (already streamed through onChunk). */
  prose: string;
  usage: TokenUsage;
  rounds: number;
  stopReason: AskStopReason;
  /** Failure message for "error"/"budget"; undefined otherwise. */
  error?: string;
  /** With "error": what failed, for the node's log and the notice the person gets. */
  failure?: ModelFailure;
}

/**
 * Reasoning effort for a model that has one, clamped to the levels it offers;
 * a model without one gets no reasoning controls at all.
 */
const THINKING = "low";

/** Pi's stop reasons in the vocabulary finish hooks are written against. */
const FINISH_STOP: Partial<Record<StopReason, string>> = { stop: "end_turn", length: "max_tokens" };

/**
 * A tool whose result is text. A throw reaches the model as an error result
 * worded "error: <message>"; arguments that fail the schema never reach `run`.
 */
export function textTool<T extends TSchema>(
  name: string,
  description: string,
  parameters: T,
  run: (args: Static<T>) => Promise<string>,
): AgentTool<T> {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, args) => {
      try {
        return { content: [{ type: "text", text: await run(args) }], details: undefined };
      } catch (e) {
        throw new Error(`error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** Providers reject empty text blocks, so one stored empty turn would fail every later turn of the thread. */
export function filterHistory(history: AiHistoryItem[]): AiHistoryItem[] {
  return history.filter((h) => h.content.trim() !== "");
}

/** The citations `text` references as [n] or [^n]; searches over-fetch, so the rest were not used. */
export function filterCited<T extends { n: number }>(text: string, citations: T[]): T[] {
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[\^?(\d+)\]/g)) cited.add(Number(m[1]));
  return citations.filter((c) => cited.has(c.n));
}

/**
 * Run one agentic turn. Never throws: a failure ends it with "error" and the
 * finished rounds' prose and staged work intact.
 */
export async function runAgentLoop(spec: AgentLoopSpec): Promise<AgentLoopResult> {
  const usage: TokenUsage = { ...ZERO_USAGE };
  let prose = "";
  let roundText = "";
  let rounds = 0;
  // Set when the loop decides the ending; otherwise the last response decides it.
  let stopReason: AskStopReason | undefined;
  let error: string | undefined;
  let last: AssistantMessage | undefined;

  if (spec.signal?.aborted) return { prose, usage, rounds, stopReason: "aborted" };

  let target: ReturnType<typeof chatTarget>;
  try {
    target = chatTarget(spec.cfg, spec.modelId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { prose, usage, rounds, stopReason: "error", error: message, failure: requestFailure(null, spec.modelId, message) };
  }
  const { model, apiKey } = target;
  const maxTokens = outputCap(model, spec.maxTokens);

  const agent = new Agent({
    initialState: {
      systemPrompt: spec.system,
      model,
      thinkingLevel: model.reasoning ? clampThinkingLevel(model, THINKING) : "off",
      tools: spec.tools,
      messages: filterHistory(spec.history).map(
        (h): AgentMessage => (h.role === "user" ? { role: "user", content: h.content, timestamp: 0 } : assistantText(model, h.content)),
      ),
    },
    getApiKey: () => apiKey,
    streamFn: (m, context, options) => streamChat(m, context, { ...options, maxTokens }),
    // Edits compose against working copies, so a round's calls run in the order the model made them.
    toolExecution: "sequential",
    // A nudge after an empty round queues a stand-in answer and the nudge together.
    followUpMode: "all",
    prepareRequest: async () => {
      // Stopped between rounds: the request is cut before it is sent, so it is no round.
      if (agent.signal?.aborted) return;
      if (rounds > 0 && spec.beforeRound) {
        const stop = await spec.beforeRound(rounds);
        if (stop) {
          stopReason = "budget";
          error = stop;
          agent.abort();
          return;
        }
      }
      rounds++;
      roundText = "";
      spec.onRoundStart?.();
    },
    finishTurn: async ({ message, toolResults }) => {
      if (message.stopReason === "error" || message.stopReason === "aborted") return;
      if (toolResults.length > 0) {
        if (rounds < spec.maxRounds) return;
        stopReason = "max_rounds";
        return { action: "end" };
      }
      // The model tried to end its turn.
      const decision = spec.onFinishAttempt?.({
        stopReason: FINISH_STOP[message.stopReason] ?? message.stopReason,
        roundText,
        round: rounds,
        maxRounds: spec.maxRounds,
      }) ?? { action: "accept" };
      if (decision.action === "accept") {
        stopReason = "complete";
        return { action: "end" };
      }
      if (rounds >= spec.maxRounds) {
        stopReason = "max_rounds";
        return { action: "end" };
      }
      if (decision.resetProse) {
        prose = "";
        spec.onResetProse?.();
      }
      // Keeps user/assistant alternation for providers that require it.
      if (!hasVisibleContent(message)) agent.followUp(assistantText(model, decision.placeholder ?? "(no response)"));
      agent.followUp({ role: "user", content: decision.message, timestamp: Date.now() });
      return;
    },
  });

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (!delta) return;
      // Separate rounds with a blank line, streamed too so live and stored prose match.
      if (roundText === "" && prose !== "" && !prose.endsWith("\n")) {
        prose += "\n\n";
        spec.onChunk("\n\n");
      }
      roundText += delta;
      prose += delta;
      spec.onChunk(delta);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      last = event.message;
      addUsage(usage, usageOf(event.message.usage));
    }
  });

  const onAbort = () => agent.abort();
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt({ role: "user", content: [...(spec.seedImages ?? []), { type: "text", text: spec.seed }], timestamp: Date.now() });
  } catch (e) {
    stopReason ??= spec.signal?.aborted ? "aborted" : "error";
    error ??= e instanceof Error ? e.message : String(e);
  } finally {
    spec.signal?.removeEventListener("abort", onAbort);
  }

  if (!stopReason) {
    if (last?.stopReason === "aborted") stopReason = "aborted";
    else if (last?.stopReason === "error") {
      stopReason = "error";
      error = last.errorMessage ?? "the model request failed";
    } else stopReason = "complete";
  }
  const failure = stopReason === "error" ? requestFailure(model.api, spec.modelId, error ?? "the model request failed", { key: apiKey }) : undefined;
  return { prose, usage, rounds, stopReason, error, failure };
}

/** A text-only assistant turn attributed to this model, so Pi replays it as the model's own. */
function assistantText(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function hasVisibleContent(message: AgentMessage): boolean {
  return message.role === "assistant" && message.content.some((b) => b.type === "toolCall" || (b.type === "text" && b.text.trim() !== ""));
}
