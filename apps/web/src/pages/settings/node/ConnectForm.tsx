/**
 * The one form that sets a half of AI up: service, key, then the model. The
 * service's model list, fetched once the key is in, proves the key and offers
 * the models newest first; which one to use is the administrator's pick, never
 * made for them. Connect saves the half, and setting a half up turns it on.
 */
import { useEffect, useState } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Banner } from "@astryxdesign/core/Banner";
import { NodeSettings as NodeApi, type NodeAiSettings } from "../../../api";
import { errorMessage } from "../../../lib/http/client";
import {
  connectFailure,
  newEndpointId,
  presetFor,
  presetsFor,
  suggestedOllamaEmbedModel,
  withConnectedProvider,
  type Preset,
} from "./ai-form";

export interface Connected {
  settings: NodeAiSettings;
  /** Worth a line only when the page does not show it by itself. */
  message?: string;
}

/** A save the probe refused, in words: a model that cannot chat reads differently from anything else. */
function saveFailure(label: string, model: string, e: unknown): string {
  const message = errorMessage(e, "");
  if (/not a chat model|not supported in the v1\/chat\/completions|only supported in v1\/responses|does not support chat/i.test(message)) {
    return `${model} doesn’t take chat requests. Choose another model.`;
  }
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}key/i.test(message)) return `${label} didn’t accept that key.`;
  return message || `Couldn’t connect to ${label}.`;
}

/** What semantic search's model must do, and where to get one when the service lists none. */
function embedHint(preset: Preset, width: number, listed: boolean): string {
  const pull = suggestedOllamaEmbedModel(width);
  if (listed || preset.provider !== "ollama" || !pull) return `It must return ${width} dimensions.`;
  return `No embedding model here yet. Pull one that returns ${width} dimensions, such as ${pull}.`;
}

export function ConnectForm({
  half,
  settings,
  onConnected,
  onCancel,
}: {
  half: "chat" | "search";
  settings: NodeAiSettings;
  onConnected: (result: Connected) => void;
  onCancel?: () => void;
}) {
  const all = presetsFor(settings.provider_base_urls);
  const presets = half === "chat" ? all : all.filter((p) => p.embeddings);
  // Semantic search starts on the first chat provider's service when it serves embeddings: its key carries over.
  const first = settings.chat.endpoints[0];
  const firstPreset = first ? presetFor(presets, first.provider, first.base_url) : null;
  const [service, setService] = useState(
    half === "search" && firstPreset && firstPreset !== "custom" && presets.some((p) => p.value === firstPreset) ? firstPreset : presets[0]!.value,
  );
  const preset = presets.find((p) => p.value === service) ?? presets[0]!;
  const [key, setKey] = useState("");
  const [address, setAddress] = useState("");
  /** What the service listed, and for which service, address and key. */
  const [listed, setListed] = useState<{ for: string; models: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const width = settings.embedding_column_dims;
  const isLocal = preset.provider === "ollama";
  const asksAddress = isLocal || preset.value === "custom";
  const url = (asksAddress ? address.trim() : "") || preset.baseUrl;
  const inheritsKey =
    half === "search" && !!first?.api_key_set && first.provider === preset.provider && presetFor(all, first.provider, first.base_url) === service;
  const needsKey = !isLocal && preset.value !== "custom" && !inheritsKey;
  const signature = `${service}|${url}|${key.trim()}`;
  const models = listed?.for === signature ? listed.models : null;

  async function load() {
    if (!url || (needsKey && !key.trim()) || models || loading) return;
    setLoading(true);
    setError(null);
    try {
      const found = await NodeApi.discoverModels(half === "chat" ? "chat" : "embed", preset.provider, url, key.trim() || undefined);
      if (found.models.length === 0 && found.message) {
        setError(connectFailure(preset.label, found.message));
        return;
      }
      setListed({ for: signature, models: found.models });
      setModel("");
    } catch (e) {
      setError(errorMessage(e, `Couldn’t reach ${preset.label}.`));
    } finally {
      setLoading(false);
    }
  }

  // A service that needs no key lists its models at once.
  useEffect(() => {
    if (!needsKey) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the service changes, reading it from this render
  }, [service]);

  function pick(value: string) {
    setService(value);
    setAddress("");
    setListed(null);
    setModel("");
    setError(null);
  }

  async function connect() {
    const chosen = model.trim();
    if (!chosen || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (half === "chat") {
        const input = withConnectedProvider(
          settings,
          { id: newEndpointId(service), provider: preset.provider, baseUrl: url, key: key.trim() },
          chosen,
          settings.provider_base_urls,
        );
        // The save sends a one-token request to the new provider and refuses what does not answer.
        const res = await NodeApi.saveAi(input);
        onConnected({ settings: res.settings, ...(res.settings.chat.running ? {} : { message: "Connected. Built-in AI is switched off." }) });
      } else {
        const res = await NodeApi.saveAi({
          embed: { provider: preset.provider, base_url: url, model: chosen, ...(key.trim() ? { api_key: key.trim() } : {}) },
        });
        onConnected({ settings: res.settings, message: `Search by meaning is on with ${chosen}. Indexing your documents.` });
      }
    } catch (e) {
      setError(saveFailure(preset.label, chosen, e));
    } finally {
      setSaving(false);
    }
  }

  // Enter lists the models first, then connects.
  const onEnter = () => void (models && model.trim() ? connect() : load());

  return (
    <VStack gap={3}>
      {error && <Banner status="error" title="Not connected" description={error} />}
      <Selector label="Service" options={presets.map((o) => ({ value: o.value, label: o.label }))} value={service} onChange={pick} />
      {!isLocal && (
        <TextInput
          label="API key"
          type="password"
          value={key}
          isOptional={!needsKey}
          description={inheritsKey ? "Uses the chat provider’s key when empty." : undefined}
          onChange={setKey}
          onBlur={() => void load()}
          onEnter={onEnter}
        />
      )}
      {asksAddress && (
        <TextInput
          label={isLocal ? "Ollama address" : "Base URL"}
          value={address}
          placeholder={preset.baseUrl || "https://llm.example.com/v1"}
          onChange={setAddress}
          onBlur={() => void load()}
          onEnter={onEnter}
        />
      )}
      {models && models.length === 0 ? (
        <TextInput
          label="Model"
          value={model}
          description={half === "chat" ? "The service lists no models. Enter one." : embedHint(preset, width, false)}
          onChange={setModel}
          onEnter={onEnter}
        />
      ) : (
        <Selector
          label="Model"
          placeholder={loading ? "Listing models…" : models ? "Choose a model" : needsKey ? "Enter the key to list models" : "Enter the address to list models"}
          description={half === "search" ? embedHint(preset, width, true) : undefined}
          options={(models ?? []).map((id) => ({ value: id, label: id }))}
          value={model}
          hasSearch
          isDisabled={!models}
          onChange={setModel}
        />
      )}
      <HStack gap={2} vAlign="center">
        <Button label="Connect" variant="primary" size="sm" isLoading={saving} isDisabled={!model.trim() || loading} onClick={() => void connect()} />
        {onCancel && <Button label="Cancel" variant="ghost" size="sm" isDisabled={saving} onClick={onCancel} />}
      </HStack>
    </VStack>
  );
}
