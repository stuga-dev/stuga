/**
 * The loop mechanics the co-author, ask and table agents share: stream rounds,
 * join them into one answer, dispatch tools, and report failures in the result
 * rather than throwing. Each agent supplies its tools, prompt and finish policy.
 */
import type { AskStopReason } from "@stuga/protocol/api/ask";
import type { AiHistoryItem } from "@stuga/protocol/wire/doc-socket";
import type { AiConfig } from "../config.js";
import { streamTurn } from "../providers/dispatch.js";
import { ZERO_USAGE, type ContentBlock, type TokenUsage, type ToolSpec, type ToolUse, type TurnMessage } from "../types.js";

/** The result of executing one tool call. */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

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
  /** The provider's stop reason for the round, if it reported one. */
  stopReason: string | undefined;
  /** Assistant text from this round only. */
  roundText: string;
  /** Tool calls this round requested. */
  toolUses: number;
  /** 1-based index of the round that just completed. */
  round: number;
  maxRounds: number;
}

export interface AgentLoopSpec {
  cfg: AiConfig;
  modelId: string;
  system: string;
  tools: ToolSpec[];
  maxRounds: number;
  maxTokens: number;
  /** Prior turns; blank ones are dropped. */
  history: AiHistoryItem[];
  /** The user turn that starts this exchange (prompt + any context preamble). */
  seed: string;
  /** Blocks (images) placed before the seed text: models attend better when the instruction follows the image. */
  seedPrefix?: ContentBlock[];
  /** Cuts the stream in flight; the turn ends "aborted" with finished rounds intact. */
  signal?: AbortSignal;
  /** Runs before every round after the first; a non-empty string stops the turn with "budget". */
  beforeRound?: (round: number) => Promise<string | null | undefined | void>;
  /** Executes one tool call; a throw is reported to the model as an error result. */
  dispatch: (tool: ToolUse) => Promise<ToolOutcome>;
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
  const { cfg, modelId, system, tools, maxRounds, maxTokens, dispatch, onChunk } = spec;

  const messages: TurnMessage[] = [
    ...filterHistory(spec.history).map((h) => ({ role: h.role, content: [{ text: h.content }] as ContentBlock[] })),
    { role: "user", content: [...(spec.seedPrefix ?? []), { text: spec.seed }] },
  ];

  let prose = "";
  let rounds = 0;
  const usage: TokenUsage = { ...ZERO_USAGE };

  // Falling out of the loop means the round cap was reached.
  let stopReason: AskStopReason = "max_rounds";
  let error: string | undefined;

  try {
    while (rounds < maxRounds) {
      if (spec.signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      if (rounds > 0 && spec.beforeRound) {
        const stop = await spec.beforeRound(rounds);
        if (stop) {
          stopReason = "budget";
          error = stop;
          break;
        }
      }
      rounds++;
      const toolUses: ToolUse[] = [];
      let roundText = "";
      spec.onRoundStart?.();

      // The system prompt is byte-stable across rounds, so it is the cached prefix.
      const gen = streamTurn(
        cfg,
        { modelId, cachedPrefix: system, messages, maxTokens, tools, signal: spec.signal },
        {
          onUsage: (u) => {
            usage.inputTokens += u.inputTokens;
            usage.outputTokens += u.outputTokens;
            usage.cacheReadInputTokens += u.cacheReadInputTokens;
            usage.cacheWriteInputTokens += u.cacheWriteInputTokens;
          },
          onToolUse: (t) => toolUses.push(t),
        },
      );

      let next = await gen.next();
      while (!next.done) {
        // Separate rounds with a blank line, streamed too so live and stored prose match.
        if (roundText === "" && prose !== "" && !prose.endsWith("\n")) {
          prose += "\n\n";
          onChunk("\n\n");
        }
        roundText += next.value;
        prose += next.value;
        onChunk(next.value);
        next = await gen.next();
      }
      const turnStopReason = next.value;

      const assistantContent: ContentBlock[] = [];
      if (roundText) assistantContent.push({ text: roundText });
      for (const t of toolUses) {
        assistantContent.push({ toolUse: { toolUseId: t.toolUseId, name: t.name, input: t.input } });
      }
      if (assistantContent.length) messages.push({ role: "assistant", content: assistantContent });

      if (turnStopReason !== "tool_use" || toolUses.length === 0) {
        const decision = spec.onFinishAttempt?.({
          stopReason: turnStopReason,
          roundText,
          toolUses: toolUses.length,
          round: rounds,
          maxRounds,
        }) ?? { action: "accept" };
        if (decision.action === "nudge") {
          // Providers require user/assistant alternation; a round that emitted nothing pushed no assistant turn.
          if (messages[messages.length - 1]?.role === "user") {
            messages.push({ role: "assistant", content: [{ text: decision.placeholder ?? "(no response)" }] });
          }
          messages.push({ role: "user", content: [{ text: decision.message }] });
          if (decision.resetProse) {
            prose = "";
            spec.onResetProse?.();
          }
          continue;
        }
        stopReason = "complete";
        break;
      }

      const results: ContentBlock[] = [];
      for (const t of toolUses) {
        let outcome: ToolOutcome;
        try {
          outcome = await dispatch(t);
        } catch (e) {
          outcome = { text: `error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
        results.push({
          toolResult: {
            toolUseId: t.toolUseId,
            content: [{ text: outcome.text }],
            status: outcome.isError ? "error" : "success",
          },
        });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (spec.signal?.aborted) {
      stopReason = "aborted";
    } else {
      stopReason = "error";
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return { prose, usage, rounds, stopReason, error };
}
