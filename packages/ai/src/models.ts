import type { AiConfig } from "./config.js";

/**
 * The client-facing model id for a request: "auto", empty and missing mean the
 * configured default. Mapping it to a provider model name is `streamTurn`'s job,
 * since only it knows which endpoint owns the id.
 */
export function resolveModel(cfg: AiConfig, requestedId?: string | null): string {
  const id = (requestedId ?? "").trim();
  return !id || id === "auto" ? cfg.chat.defaultModel : id;
}
