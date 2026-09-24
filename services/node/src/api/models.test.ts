import { describe, expect, it } from "vitest";
import type { AiConfig } from "@stuga/ai";
import type { PublicCall } from "../http/router.js";
import { listModels } from "./models.js";

function call(chat: AiConfig["chat"]): PublicCall {
  return { env: { aiSettings: { current: () => ({ chat }) } } } as unknown as PublicCall;
}

const endpoint = {
  id: "ep1",
  provider: "anthropic" as const,
  baseUrl: "https://api.anthropic.com",
  models: [
    { id: "claude-a", name: "Claude A" },
    { id: "claude-b", name: "Claude B" },
  ],
};

describe("GET /api/models", () => {
  it("lists Auto first, then every configured model with its provider", async () => {
    const res = await listModels(call({ enabled: true, defaultModel: "claude-a", endpoints: [endpoint] }));
    expect(await res.json()).toEqual([
      { id: "auto", name: "Auto", provider: "ollama" },
      { id: "claude-a", name: "Claude A", provider: "anthropic" },
      { id: "claude-b", name: "Claude B", provider: "anthropic" },
    ]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("adds no second Auto when an endpoint lists one", async () => {
    const withAuto = { ...endpoint, models: [{ id: "auto", name: "Auto" }, ...endpoint.models] };
    const res = await listModels(call({ enabled: true, defaultModel: "claude-a", endpoints: [withAuto] }));
    expect(((await res.json()) as Array<{ id: string }>).map((m) => m.id)).toEqual(["auto", "claude-a", "claude-b"]);
  });

  it("offers nothing while chat is off, though endpoints stay configured", async () => {
    const res = await listModels(call({ enabled: false, defaultModel: "claude-a", endpoints: [endpoint] }));
    expect(await res.json()).toEqual([]);
  });
});
