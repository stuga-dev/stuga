/**
 * TypeSafe's System One protocol: a model answers typed questions about a
 * state, here Jev judging passages. TypeSafe serves it, and so does OpenRouter
 * at its own base URL. The published Pi has no classifier client yet.
 */
import type { AiConfig } from "../config.js";
import { fetchWithRetry, joinUrl, jsonHeaders } from "../transport.js";

export type SystemOneEndpoint = Omit<AiConfig["rerank"], "enabled">;

/** A yes/no question; the answer is the probability of yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface SystemOneAnswer {
  /** Question id → probability of yes. */
  probabilities: Record<string, number>;
  /** The model version that answered. */
  model: string;
  inputTokens: number;
}

/** Ask every question about one state in one request; throws on any failure. */
export async function askSystemOne(
  ep: SystemOneEndpoint,
  state: unknown,
  questions: Record<string, NoulQuestion>,
  signal?: AbortSignal,
): Promise<SystemOneAnswer> {
  const res = await fetchWithRetry(
    "systemone",
    (s) =>
      fetch(joinUrl(ep.baseUrl, "/systemone"), {
        method: "POST",
        headers: jsonHeaders(ep.apiKey),
        body: JSON.stringify({ model: ep.model, state, questions }),
        signal: s,
      }),
    { signal },
  );
  const body = (await res.json()) as {
    model?: string;
    answers?: Record<string, { noul?: unknown }>;
    usage?: { input_tokens?: number };
  };
  const probabilities: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const p = body.answers?.[id]?.noul;
    if (typeof p !== "number" || !Number.isFinite(p)) throw new Error(`systemone gave no answer for ${id}`);
    probabilities[id] = p;
  }
  return { probabilities, model: body.model ?? ep.model, inputTokens: body.usage?.input_tokens ?? 0 };
}

/** Prove endpoint, key and model with one question; the failure, or null. */
export async function probeSystemOne(ep: SystemOneEndpoint): Promise<string | null> {
  try {
    await askSystemOne(ep, { text: "ping" }, { ok: { type: "noul", instructions: "Is this text a greeting?", criteria: { true: "It greets", false: "It does not greet" } } });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
