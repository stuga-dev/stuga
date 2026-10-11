/**
 * The one form that sets a half of AI up: service, key, then the model. The
 * service's model list, fetched once the key is in, proves the key and offers
 * the models newest first; which one to use is the administrator's pick, never
 * made for them. Connect saves the half, and setting a half up turns it on.
 */
import { useEffect, useRef, useState } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { NodeSettings as NodeApi, type NodeAiSettings } from "../../../api";
import { errorMessage } from "../../../lib/http/client";
import {
  connectFailure,
  connectFailureKind,
  isServiceAddress,
  modelOptions,
  newEndpointId,
  presetFor,
  presetsFor,
  recommendedModel,
  suggestedOllamaEmbedModel,
  withConnectedProvider,
  type Preset,
} from "./ai-form";
import { t } from "../../../i18n/i18n";

export interface Connected {
  settings: NodeAiSettings;
  /** Worth a line only when the page does not show it by itself. */
  message?: string;
}

/** A failure in words, and the field it belongs beside; null for the form as a whole. */
type Problem = { message: string; field: "key" | "address" | null };

/** A save the probe refused, in words, and the field it is about: a model that cannot chat reads differently from anything else. */
function saveFailure(label: string, model: string, e: unknown): Problem {
  const message = errorMessage(e, "");
  if (/not a chat model|not supported in the v1\/chat\/completions|only supported in v1\/responses|does not support chat/i.test(message)) {
    return { message: t("nodeAccess.connect.notChat", { model }), field: null };
  }
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}key/i.test(message)) return { message: t("nodeAccess.connect.keyRefused", { service: label }), field: "key" };
  return { message: message || t("nodeAccess.connect.failed", { service: label }), field: null };
}

/** What semantic search's model must do, typed by hand, or where to get one when Ollama has none. */
function embedHint(preset: Preset, width: number): string {
  const pull = suggestedOllamaEmbedModel(width);
  if (preset.provider !== "ollama" || !pull) return t("nodeAccess.connect.embedWidth", { width });
  return t("nodeAccess.connect.pullEmbedModel", { model: pull });
}

/** Where to get what a service needs: its key page, or Ollama itself. */
export function KeyLink({ url, label }: { url: string; label: string }) {
  return (
    <Link href={url} isExternalLink type="supporting">
      {label}
    </Link>
  );
}

/** Ollama's download page, for a node whose local Ollama is not running. */
const OLLAMA_DOWNLOAD = "https://ollama.com/download";

/** How long typing in the key pauses before the key is tried: a pasted key is checked at once, without leaving the field. */
const KEY_CHECK_DELAY_MS = 600;

/** An address's host, for naming a service that has no name of its own; "" when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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
  const [problem, setProblem] = useState<Problem | null>(null);
  /** The service picked was asked for its models unprompted and did not answer, as a local Ollama not yet started. */
  const [quietMiss, setQuietMiss] = useState(false);
  /** The signature the last listing was asked for, so a key is tried once per pause in typing. */
  const asked = useRef("");

  const width = settings.embedding_column_dims;
  const isLocal = preset.provider === "ollama";
  const asksAddress = isLocal || preset.value === "custom";
  const url = (asksAddress ? address.trim() : "") || preset.baseUrl;
  const inheritsKey =
    half === "search" && !!first?.api_key_set && first.provider === preset.provider && presetFor(all, first.provider, first.base_url) === service;
  const needsKey = !isLocal && preset.value !== "custom" && !inheritsKey;
  const signature = `${service}|${url}|${key.trim()}`;
  const models = listed?.for === signature ? listed.models : null;
  const listedNone = models?.length === 0;
  // A custom service's name is its address; "Something else…" reads oddly inside a sentence.
  const serviceName = preset.value === "custom" ? hostOf(url) || preset.label : preset.label;
  const recommended = models ? recommendedModel(preset, half === "chat" ? "chat" : "embed", models) : null;
  /** The form's signature now: an answer for an older key or address, arriving late, is dropped. */
  const current = useRef(signature);
  current.current = signature;

  /**
   * Lists the service's models, once per service, address and key, or `again` after it listed none.
   * `quietly`: asked unprompted, so a service that does not answer is a hint, not an error.
   */
  async function load(again = false, quietly = false) {
    if (!url || (needsKey && !key.trim()) || (models && !(again && listedNone)) || loading) return;
    if (asksAddress && address.trim() && !isServiceAddress(address)) {
      setProblem({ message: t("nodeAccess.connect.addressInvalid"), field: "address" });
      return;
    }
    const sig = signature;
    asked.current = sig;
    setLoading(true);
    setProblem(null);
    try {
      const found = await NodeApi.discoverModels(half === "chat" ? "chat" : "embed", preset.provider, url, key.trim() || undefined);
      if (current.current !== sig) return;
      if (found.models.length === 0 && found.message) {
        if (quietly) return setQuietMiss(true);
        setProblem(failure(found.message));
        return;
      }
      setQuietMiss(false);
      // Still none: keep any id typed while the request was out.
      if (listedNone && found.models.length === 0) return;
      setListed({ for: signature, models: found.models });
      setModel("");
    } catch (e) {
      if (current.current !== sig) return;
      if (quietly) return setQuietMiss(true);
      setProblem({ message: errorMessage(e, t("nodeAccess.connect.unreachable", { service: serviceName })), field: asksAddress ? "address" : null });
    } finally {
      setLoading(false);
    }
  }

  /** A listing's refusal, beside the field it is about. */
  function failure(message: string): Problem {
    const kind = connectFailureKind(message);
    const field = kind === "key" ? "key" : kind === "unreachable" && asksAddress ? "address" : null;
    return { message: connectFailure(serviceName, message), field };
  }

  // A service that needs no key lists its models at once, without a word if it is not running yet.
  useEffect(() => {
    setQuietMiss(false);
    if (!needsKey) void load(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the service changes, reading it from this render
  }, [service]);

  // A key is tried once typing pauses, so a pasted key is checked where it was pasted. A key typed
  // while an older one was being tried is tried once that answer is in.
  useEffect(() => {
    if (!needsKey || !key.trim() || models || loading || asked.current === signature) return;
    const timer = window.setTimeout(() => void load(), KEY_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads this render's service, address and key
  }, [signature, loading]);

  // A service that listed no models, or did not answer unprompted, lists again when the page is back
  // in front, so a model pulled or a service started in the meantime shows up without starting over.
  useEffect(() => {
    if (!(listedNone || quietMiss) || model.trim() || loading) return;
    const again = () => void load(true, quietMiss);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads this render's service, address and key
  }, [listedNone, quietMiss, signature, model, loading]);

  function pick(value: string) {
    setService(value);
    setAddress("");
    setListed(null);
    setModel("");
    setProblem(null);
  }

  async function connect() {
    const chosen = model.trim();
    if (!chosen || saving) return;
    setSaving(true);
    setProblem(null);
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
        onConnected({ settings: res.settings, ...(res.settings.chat.running ? {} : { message: t("nodeAccess.connect.builtInOff") }) });
      } else {
        const res = await NodeApi.saveAi({
          embed: { provider: preset.provider, base_url: url, model: chosen, ...(key.trim() ? { api_key: key.trim() } : {}) },
        });
        onConnected({ settings: res.settings, message: t("nodeAccess.connect.searchOn", { model: chosen }) });
      }
    } catch (e) {
      setProblem(saveFailure(serviceName, chosen, e));
    } finally {
      setSaving(false);
    }
  }

  // Enter lists the models first, then connects.
  const onEnter = () => void (models && model.trim() ? connect() : load(true));
  const fieldStatus = (field: "key" | "address") => (problem?.field === field ? { type: "error" as const, message: problem.message } : undefined);

  return (
    <VStack gap={3}>
      {problem && problem.field === null && <Banner status="error" title={t("nodeAccess.connect.notConnected")} description={problem.message} />}
      <Selector label={t("nodeAccess.connect.service")} options={presets.map((o) => ({ value: o.value, label: o.label }))} value={service} onChange={pick} />
      {!isLocal && (
        <VStack gap={1}>
          <TextInput
            label={t("nodeAccess.connect.apiKey")}
            type="password"
            value={key}
            isOptional={!needsKey}
            description={inheritsKey ? t("nodeAccess.connect.inheritsKey") : undefined}
            status={fieldStatus("key")}
            onChange={setKey}
            onBlur={() => void load()}
            onEnter={onEnter}
          />
          {preset.keyUrl && <KeyLink url={preset.keyUrl} label={t("nodeAccess.connect.getKey", { service: preset.label })} />}
        </VStack>
      )}
      {asksAddress && (
        <VStack gap={1}>
          <TextInput
            label={isLocal ? t("nodeAccess.connect.ollamaAddress") : t("nodeAccess.connect.baseUrl")}
            value={address}
            placeholder={preset.baseUrl || "https://llm.example.com/v1"} // i18n-exempt: an example address
            description={isLocal ? undefined : t("nodeAccess.connect.baseUrlHint")}
            status={fieldStatus("address")}
            onChange={setAddress}
            onBlur={() => void load()}
            onEnter={onEnter}
          />
          {isLocal && quietMiss && (
            <Text type="supporting" color="secondary">
              {t("nodeAccess.connect.ollamaNotRunning")} <KeyLink url={OLLAMA_DOWNLOAD} label={t("nodeAccess.connect.getOllama")} />
            </Text>
          )}
        </VStack>
      )}
      {models && models.length === 0 ? (
        <TextInput
          label={t("nodeAccess.connect.model")}
          value={model}
          description={half === "chat" ? t("nodeAccess.connect.noModelsListed") : embedHint(preset, width)}
          onChange={setModel}
          onEnter={onEnter}
        />
      ) : (
        <Selector
          label={t("nodeAccess.connect.model")}
          placeholder={
            loading
              ? t("nodeAccess.connect.listingModels")
              : models
                ? t("nodeAccess.connect.chooseModel")
                : needsKey
                  ? t("nodeAccess.connect.enterKey")
                  : t("nodeAccess.connect.enterAddress")
          }
          options={modelOptions(models ?? [], [], recommended)}
          value={model}
          hasSearch
          isDisabled={!models}
          onChange={setModel}
        />
      )}
      <HStack gap={2} vAlign="center">
        <Button label={t("nodeAccess.connect.connect")} variant="primary" size="sm" isLoading={saving} isDisabled={!model.trim() || loading} onClick={() => void connect()} />
        {onCancel && <Button label={t("common.cancel")} variant="ghost" size="sm" isDisabled={saving} onClick={onCancel} />}
      </HStack>
    </VStack>
  );
}
