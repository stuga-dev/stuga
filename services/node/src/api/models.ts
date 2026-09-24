/** GET /api/models: the chat models end users may pick. None while AI chat is off, which is how a client tells. */
import type { AiProvider } from "@stuga/ai";
import type { NodeEnv } from "../env.js";
import { json } from "../http/respond.js";
import type { PublicCall } from "../http/router.js";

/** The configured models with their providers, "Auto" (the default model) first unless listed; none while chat is off. */
function modelCatalog(env: Pick<NodeEnv, "aiSettings">): Array<{ id: string; name: string; provider: AiProvider }> {
  const chat = env.aiSettings.current().chat;
  // A turn would be refused, so there is nothing to pick. Configured endpoints stay in the settings.
  if (!chat.enabled) return [];
  const models = chat.endpoints.flatMap((e) => e.models.map((m) => ({ id: m.id, name: m.name, provider: e.provider })));
  // Auto's provider is filler: it resolves to the default model's endpoint.
  return models.some((m) => m.id === "auto") ? models : [{ id: "auto", name: "Auto", provider: "ollama" as const }, ...models];
}

/** No per-user data, so no credential; `no-store` because an administrator can change the list. */
export async function listModels({ env }: PublicCall): Promise<Response> {
  return json(modelCatalog(env), { headers: { "cache-control": "no-store" } });
}
