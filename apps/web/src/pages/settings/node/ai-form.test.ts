import { describe, expect, it } from "vitest";
import type { NodeAiSettings } from "../../../api";
import {
  EMBED_PROVIDERS,
  bedrockAddress,
  bedrockRegionProblem,
  calibrationBanner,
  chatInputWith,
  connectFailure,
  endpointLabel,
  presetFor,
  presetsFor,
  recommendedModel,
  strictnessNote,
  strictnessWarning,
  suggestedOllamaEmbedModel,
  toForm,
  withConnectedProvider,
} from "./ai-form";

const BASE = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://127.0.0.1:11434",
  bedrock: "https://bedrock-runtime.us-east-1.amazonaws.com",
};

const provider = (id: string, models: string[]) => ({
  id,
  provider: "openai" as const,
  base_url: "https://api.openai.com/v1",
  models: models.map((m) => ({ id: m, name: m })),
  api_key_set: true,
  api_key_fingerprint: "abcd1234",
  api_key_stale: false,
});

const settings = (endpoints: ReturnType<typeof provider>[], defaultModel = endpoints[0]?.models[0]?.id ?? ""): NodeAiSettings => ({
  chat: { enabled: true, running: endpoints.length > 0, default_model: defaultModel, endpoints },
  embed: {
    enabled: true,
    running: false,
    provider: "ollama",
    base_url: BASE.ollama,
    model: "",
    api_key_set: false,
    api_key_fingerprint: null,
    api_key_stale: false,
    search_strictness: null,
    cutoff: null,
    calibration: null,
  },
  rerank: { enabled: true, running: false, base_url: "", model: "", api_key_set: false, api_key_fingerprint: null, api_key_stale: false },
  embedding_column_dims: 1024,
  strictness_default: "balanced",
  provider_base_urls: BASE,
  updated_by: null,
  updated_at: null,
});

describe("suggestedOllamaEmbedModel", () => {
  it("names a model Ollama could pull that fits the column", () => {
    expect(suggestedOllamaEmbedModel(1024)).toBe("embeddinggemma:300m");
    expect(suggestedOllamaEmbedModel(768)).toBe("embeddinggemma:300m");
    expect(suggestedOllamaEmbedModel(1536)).toBe("embeddinggemma:300m");
    expect(suggestedOllamaEmbedModel(256)).toBe("embeddinggemma:300m");
    expect(suggestedOllamaEmbedModel(384)).toBe("embeddinggemma:300m");
    expect(suggestedOllamaEmbedModel(100)).toBeNull();
  });
});

describe("withConnectedProvider", () => {
  const added = { id: "anthropic-x", provider: "anthropic", baseUrl: BASE.anthropic, key: "sk-ant" };

  it("offers the chosen model and makes the first provider's the default, keeping chat's switch as saved", () => {
    const input = withConnectedProvider(settings([]), added, "claude-new", BASE);
    expect(input).toEqual({
      chat: {
        enabled: true,
        default_model: "claude-new",
        endpoints: [{ id: "anthropic-x", provider: "anthropic", base_url: BASE.anthropic, models: [{ id: "claude-new", name: "claude-new" }], api_key: "sk-ant" }],
      },
    });
  });

  it("keeps the default and every saved provider, their keys untouched, when another joins", () => {
    const input = withConnectedProvider(settings([provider("openai-1", ["gpt-4.1"])]), added, "claude-new", BASE);
    expect(input.chat!.default_model).toBe("gpt-4.1");
    expect(input.chat!.endpoints.map((e) => e.id)).toEqual(["openai-1", "anthropic-x"]);
    expect(input.chat!.endpoints[0]).not.toHaveProperty("api_key");
  });
});

describe("chatInputWith", () => {
  const two = settings([provider("a", ["m1"]), provider("b", ["m2"])], "m2");

  it("drops a removed provider and leaves a default it took with it for the node to settle", () => {
    const input = chatInputWith(two, { removeId: "b" }, BASE);
    expect(input.chat!.endpoints.map((e) => e.id)).toEqual(["a"]);
    expect(input.chat!.default_model).toBe("");
  });

  it("disconnects chat when the last provider goes", () => {
    expect(chatInputWith(settings([provider("a", ["m1"])]), { removeId: "a" }, BASE).chat).toEqual({ enabled: true, default_model: "", endpoints: [] });
  });

  it("flips chat's switch with the providers sent back as saved", () => {
    const off = chatInputWith(two, { enabled: false }, BASE);
    expect(off.chat).toMatchObject({ enabled: false, default_model: "m2" });
    expect(off.chat!.endpoints.map((e) => e.id)).toEqual(["a", "b"]);
    expect(off.chat!.endpoints.some((e) => "api_key" in e)).toBe(false);
  });

  it("changes the default among offered models, and deletes a key only when asked", () => {
    expect(chatInputWith(two, { defaultModel: "m1" }, BASE).chat!.default_model).toBe("m1");
    const cleared = chatInputWith(two, { edit: { id: "a", provider: "openai", baseUrl: BASE.openai, models: "m1", key: "" }, clearKeyOf: "a" }, BASE);
    expect(cleared.chat!.endpoints[0]).toMatchObject({ id: "a", api_key: "" });
    expect(cleared.chat!.endpoints[1]).not.toHaveProperty("api_key");
    expect(cleared).not.toHaveProperty("embed");
  });
});

describe("Amazon Bedrock", () => {
  const presets = presetsFor(BASE);
  const EU_WEST = "https://bedrock-runtime.eu-west-1.amazonaws.com";

  it("is a chat-only service at the node's Bedrock address, recommending the newest global Claude Sonnet profile", () => {
    const bedrock = presets.find((p) => p.value === "bedrock");
    expect(bedrock).toMatchObject({ label: "Amazon Bedrock", provider: "bedrock", baseUrl: BASE.bedrock, embeddings: false });
    expect(presetsFor({}).find((p) => p.value === "bedrock")?.baseUrl).toBe(BASE.bedrock);
    const listed = ["us.anthropic.claude-haiku-5-5", "anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-4-5"];
    expect(recommendedModel(bedrock, "chat", listed)).toBe("global.anthropic.claude-sonnet-5-5");
    expect(EMBED_PROVIDERS.map((p) => p.value)).toEqual(["openai", "ollama"]);
  });

  it("names a saved provider by its Region, in any Region", () => {
    expect(presetFor(presets, "bedrock", EU_WEST)).toBe("bedrock");
    expect(endpointLabel(presets, "bedrock", EU_WEST)).toBe("Amazon Bedrock · eu-west-1");
    expect(endpointLabel(presets, "openai", BASE.openai)).toBe("OpenAI");
  });

  it("builds a Region's runtime address, keeping a FIPS address while its Region stays", () => {
    const fips = "https://bedrock-runtime-fips.us-east-1.amazonaws.com";
    expect(bedrockAddress("eu-west-1", BASE.bedrock)).toBe(EU_WEST);
    expect(bedrockAddress(" us-east-1 ", fips)).toBe(fips);
    expect(bedrockAddress("us-west-2", fips)).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
  });

  it("refuses a Region that is not one, in plain words", () => {
    expect(bedrockRegionProblem("eu-central-2")).toBeNull();
    expect(bedrockRegionProblem("us-gov-west-1")).toBeNull();
    expect(bedrockRegionProblem("Europe")).toBe("Enter an AWS Region, such as us-east-1.");
    expect(bedrockRegionProblem("")).toBe("Enter an AWS Region, such as us-east-1.");
  });
});

describe("connectFailure", () => {
  it("names a refused key and an unreachable server in words, and quotes anything else", () => {
    expect(connectFailure("OpenAI", 'models 401: {"error":{"message":"Incorrect API key provided"}}')).toBe("OpenAI didn’t accept that key.");
    expect(connectFailure("Ollama (local)", "fetch failed")).toContain("Couldn’t reach Ollama (local)");
    expect(connectFailure("Groq", "models 500: overloaded")).toBe("Groq answered: models 500: overloaded");
  });
});

describe("search strictness copy", () => {
  const LEVELS = { short: { strict: 0.27, balanced: 0.34, loose: 0.39 }, question: { strict: 0.25, balanced: 0.31, loose: 0.36 } };
  const base = settings([]);
  const measured = (over: Partial<NodeAiSettings["embed"]> = {}): NodeAiSettings => ({
    ...base,
    embed: {
      ...base.embed,
      model: "bge-m3",
      running: true,
      cutoff: { level: "balanced", source: "measured", short: 0.34, question: 0.31 },
      calibration: { state: "ready", model: "bge-m3", progress: null, measured_at: null, levels: LEVELS, related_kept: 0.8, by_language: null, message: null, kind: null, next_attempt_at: null },
      ...over,
    },
  });

  it("shows the measured distance of the chosen level, and nothing to measure while semantic search is off", () => {
    const s = measured();
    expect(strictnessNote(s, toForm(s))).toEqual({ text: "Measured for this model: 0.34", measureAgain: true });
    const off = measured({ running: false });
    expect(strictnessNote(off, toForm(off))).toEqual({ text: "Measured once semantic search is on.", measureAgain: false });
  });

  it("offers no retry for a model that cannot be measured", () => {
    const s = measured({ calibration: { ...measured().embed.calibration!, state: "failed", levels: null, kind: "inseparable", message: "alike" }, cutoff: { level: "balanced", source: "unmeasured", short: null, question: null } });
    expect(strictnessNote(s, toForm(s))).toEqual({ text: "This model can’t be measured.", measureAgain: false });
    expect(calibrationBanner(s)?.retry).toBe(false);
  });

  it("warns about a model that keeps related text far only for the model in force", () => {
    const s = measured();
    expect(strictnessWarning(s, toForm(s))).toMatch(/Loose may suit it/);
    expect(strictnessWarning(s, { ...toForm(s), embedModel: "other-model" })).toBeNull();
  });

  it("shows no failure banner while strictness is off", () => {
    const failed = { ...measured().embed.calibration!, state: "failed" as const, levels: null, kind: "endpoint" as const, message: "connect ECONNREFUSED" };
    expect(calibrationBanner(measured({ calibration: failed, cutoff: { level: "balanced", source: "unmeasured", short: null, question: null } }))?.title).toBe("Couldn’t measure bge-m3");
    expect(calibrationBanner(measured({ calibration: failed, cutoff: { level: "off", source: "off", short: null, question: null } }))).toBeNull();
  });

});
