/**
 * Chat, semantic search and the ranker, each set up on its own: any runs without
 * the others, as semantic search does for an outside agent that brings its own
 * chat. Setting a part up turns it on. Its switch, shown once it is set up, turns
 * it off and keeps it; Remove forgets it. Shown as Built-in AI, Semantic search and
 * Reranking.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Link } from "@astryxdesign/core/Link";
import type { SearchStrictness } from "@stuga/protocol/domain/search-strictness";
import { NodeSettings as NodeApi, type AiProbe, type NodeAiSettings } from "../../../api";
import { invalidateModelOptions } from "../../../state/model-options";
import {
  HALF_COPY,
  NO_CLEARED_KEYS,
  PROVIDERS,
  RERANK_PRESETS,
  STRICTNESS_COPY,
  allChatModelIds,
  calibrationBanner,
  chatInputWith,
  endpointLabel,
  modelIds,
  modelOptions,
  presetFor,
  presetsFor,
  rerankFormOf,
  rerankInput,
  rerankPresetFor,
  searchServiceDetail,
  strictnessNote,
  strictnessWarning,
  toForm,
  toInput,
  withSavedHalf,
  withSelectedModels,
  type BaseUrls,
  type ChatEndpointForm,
  type Form,
  type RerankForm,
} from "./ai-form";
import { ConnectForm, type Connected } from "./ConnectForm";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { StoredSecret } from "./StoredSecret";

type ProbeRow = { ok: boolean; model?: string; latency_ms?: number; dims?: number; message?: string; skipped?: boolean };

/** While the node measures its embedding model, how often Settings follows along. */
const CALIBRATION_POLL_MS = 2000;

/** What a save or a test heard back, one line per service that was asked. */
function ProbeBanner({ probe, labels, level }: { probe: AiProbe; labels: Record<string, string>; level: SearchStrictness }) {
  const line = (label: string, r: ProbeRow) =>
    r.ok
      ? `${label}: ok${r.model ? ` · ${r.model}` : ""}${r.latency_ms ? ` · ${r.latency_ms}ms` : ""}${r.dims ? ` · ${r.dims} dimensions` : ""}`
      : `${label}: ${r.message ?? "failed"}`;
  // A model measured before shows where the chosen level sits for it.
  const cutoff = probe.embed.cutoffs && level !== "off" && level !== "custom" ? ` · ${STRICTNESS_COPY[level].label} ${probe.embed.cutoffs[level].toFixed(2)}` : "";
  // A skipped row made no request, so it says nothing about the service.
  const rows = [
    ...probe.chat.filter((r) => !r.skipped).map((r) => line(labels[r.id] ?? r.id, r)),
    ...(probe.embed.skipped ? [] : [line(HALF_COPY.search.title, probe.embed) + (probe.embed.ok ? cutoff : "")]),
    ...(probe.rerank.skipped ? [] : [line(HALF_COPY.rerank.title, probe.rerank)]),
  ];
  if (rows.length === 0) return null;
  return (
    <Banner
      status={probe.ok ? "success" : "error"}
      title={probe.ok ? "Answered" : "Did not answer as expected"}
      description={
        <VStack gap={1}>
          {rows.map((r, i) => (
            <Text key={i} type="supporting">
              {r}
            </Text>
          ))}
        </VStack>
      }
    />
  );
}

/** A half's heading, what it is for, and its switch once it is set up. */
function HalfHead({ title, about, toggle }: { title: string; about: string; toggle?: ReactNode }) {
  return (
    <HStack hAlign="between" vAlign="center" gap={3}>
      <VStack gap={0}>
        <Heading level={2}>{title}</Heading>
        <Text type="supporting" color="secondary">
          {about}
        </Text>
      </VStack>
      {toggle}
    </HStack>
  );
}

/** A half with nothing set up yet: the same line and button for both. */
function NotSetUp({ note, onSetUp }: { note: string; onSetUp: () => void }) {
  return (
    <HStack hAlign="between" vAlign="center" gap={3}>
      <Text type="supporting" color="secondary">
        {note}
      </Text>
      <Button label="Set up" variant="secondary" size="sm" onClick={onSetUp} />
    </HStack>
  );
}

/** One configured service. */
function ServiceRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <Card variant="muted">
      <HStack hAlign="between" vAlign="center" gap={3}>
        <VStack gap={0}>
          <Text weight="semibold">{title}</Text>
          <Text type="supporting" color="secondary">
            {detail}
          </Text>
        </VStack>
        <HStack gap={1}>{children}</HStack>
      </HStack>
    </Card>
  );
}

type Confirm = { kind: "remove-provider"; id: string } | { kind: "remove-search" } | { kind: "reembed" } | { kind: "remove-rerank" };

export function AiSection({ settings, onSaved }: { settings: NodeAiSettings; onSaved: (settings: NodeAiSettings) => void }) {
  const nav = useNavigate();
  const status = useSectionStatus();
  const baseUrls: BaseUrls = settings.provider_base_urls;
  const presets = presetsFor(baseUrls);
  const providers = settings.chat.endpoints;
  const labels = Object.fromEntries(providers.map((e) => [e.id, endpointLabel(presets, e.provider, e.base_url)]));
  const searchSetUp = !!settings.embed.model;

  const [busy, setBusy] = useState("");
  const [probe, setProbe] = useState<AiProbe | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** The Connect form for a chat provider, the first or another. */
  const [adding, setAdding] = useState(false);
  /** The provider open for editing, as edited so far. */
  const [draft, setDraft] = useState<ChatEndpointForm | null>(null);
  const [draftKeyCleared, setDraftKeyCleared] = useState(false);
  /** Model ids a provider reported, per provider. Empty until asked. */
  const [found, setFound] = useState<Record<string, string[]>>({});
  const [fetching, setFetching] = useState("");
  const [settingUpSearch, setSettingUpSearch] = useState(false);
  const [editingSearch, setEditingSearch] = useState(false);
  /** Semantic search as edited so far; the chat fields are unused here. */
  const [form, setForm] = useState<Form>(() => toForm(settings));
  const [embedKeyCleared, setEmbedKeyCleared] = useState(false);
  const [foundEmbed, setFoundEmbed] = useState<string[]>([]);
  /** The ranker as edited so far, while it is being set up or edited. */
  const [rerankDraft, setRerankDraft] = useState<RerankForm | null>(null);
  const [rerankKeyCleared, setRerankKeyCleared] = useState(false);
  const rerankSetUp = !!settings.rerank.model;

  // Bumped by every save, so a poll that set out before it cannot apply older settings.
  const savedAt = useRef(0);

  function applied(next: NodeAiSettings) {
    savedAt.current++;
    onSaved(next);
    invalidateModelOptions();
  }

  // While the node measures its model, follow the measurement until it lands. An answer that
  // arrives after the poll stopped, or after a save already applied newer settings, is dropped.
  const measuring = settings.embed.calibration?.state === "running";
  useEffect(() => {
    if (!measuring) return;
    let alive = true;
    const t = setInterval(() => {
      const asked = savedAt.current;
      void NodeApi.ai()
        .then((next) => alive && asked === savedAt.current && onSaved(next))
        .catch(() => {});
    }, CALIBRATION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [measuring, onSaved]);

  const measureAgain = () =>
    act("measure", async () => {
      await NodeApi.calibrateAi();
      onSaved(await NodeApi.ai());
    });

  /** Drops the distance for Ask and agents that was set through the API. */
  const clearRetrievalDistance = () =>
    act("clear-retrieval", async () => {
      const input = toInput(toForm(settings), NO_CLEARED_KEYS, baseUrls, "embed");
      if (input.embed) input.embed.retrieval_max_distance = null;
      applied((await NodeApi.saveAi(input)).settings);
    });

  /** One action at a time, its failure shown above the fields. */
  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    status.clear();
    setProbe(null);
    try {
      await fn();
    } catch (e) {
      status.fail(e);
    } finally {
      setBusy("");
    }
  }

  function connected(result: Connected) {
    applied(result.settings);
    setForm((f) => withSavedHalf(f, toForm(result.settings), "embed"));
    setAdding(false);
    setSettingUpSearch(false);
    status.clear();
    if (result.message) status.setNotice({ status: "success", message: result.message });
  }

  // ---- chat ----

  const setChatOn = (on: boolean) =>
    act("chat-switch", async () => {
      applied((await NodeApi.saveAi(chatInputWith(settings, { enabled: on }, baseUrls))).settings);
    });

  async function discover(ep: ChatEndpointForm) {
    setFetching(ep.id);
    try {
      // With no key typed, the node uses the saved provider's own.
      const r = await NodeApi.discoverModels("chat", ep.provider, ep.baseUrl || baseUrls[ep.provider] || "", ep.key || undefined);
      setFound((f) => ({ ...f, [ep.id]: r.models }));
      if (r.models.length === 0) status.setNotice({ status: "warning", message: "That service lists no models. Type the model id instead." });
    } catch (e) {
      status.fail(e);
    } finally {
      setFetching("");
    }
  }

  function edit(id: string) {
    const ep = toForm(settings).chatEndpoints.find((e) => e.id === id);
    if (!ep) return;
    setDraft(ep);
    setDraftKeyCleared(false);
    setAdding(false);
    if (!found[id]) void discover(ep);
  }

  const saveProvider = () =>
    act("save-provider", async () => {
      if (!draft) return;
      const res = await NodeApi.saveAi(chatInputWith(settings, { edit: draft, clearKeyOf: draftKeyCleared ? draft.id : undefined }, baseUrls));
      applied(res.settings);
      setProbe(res.probe);
      setDraft(null);
    });

  // Switched on for the test, so a switched-off half is asked too.
  const testProvider = () =>
    act("test-provider", async () => {
      if (!draft) return;
      setProbe(await NodeApi.testAi(chatInputWith(settings, { edit: draft, clearKeyOf: draftKeyCleared ? draft.id : undefined, enabled: true }, baseUrls)));
    });

  const removeProvider = (id: string) =>
    act("remove-provider", async () => {
      applied((await NodeApi.saveAi(chatInputWith(settings, { removeId: id }, baseUrls))).settings);
      if (draft?.id === id) setDraft(null);
    });

  const saveDefault = (model: string) =>
    act("default", async () => {
      applied((await NodeApi.saveAi(chatInputWith(settings, { defaultModel: model }, baseUrls))).settings);
    });

  // ---- semantic search ----

  const setSearchOn = (on: boolean) =>
    act("search-switch", async () => {
      const res = await NodeApi.saveAi(toInput({ ...toForm(settings), embedEnabled: on }, NO_CLEARED_KEYS, baseUrls, "embed"));
      applied(res.settings);
      setForm((f) => ({ ...f, embedEnabled: res.settings.embed.enabled }));
    });

  function editSearch() {
    setForm(toForm(settings));
    setEmbedKeyCleared(false);
    setFoundEmbed([]);
    setEditingSearch(true);
  }

  async function discoverEmbed() {
    status.setError(null);
    setFetching("embed");
    try {
      const r = await NodeApi.discoverModels("embed", form.embedProvider, form.embedBaseUrl, form.embedKey);
      setFoundEmbed(r.models);
      if (r.models.length === 0) status.setNotice({ status: "warning", message: "That service lists no embedding models. Type the model id instead." });
    } catch (e) {
      status.fail(e);
    } finally {
      setFetching("");
    }
  }

  /** A new embedding model invalidates every stored vector, so the save asks first. */
  const level = form.searchStrictness ?? settings.strictness_default;
  const note = strictnessNote(settings, form);
  const warning = strictnessWarning(settings, form);
  const banner = calibrationBanner(settings);

  const embeddingChanged = () =>
    form.embedModel !== settings.embed.model || form.embedBaseUrl !== settings.embed.base_url || form.embedProvider !== settings.embed.provider;

  const saveSearch = () =>
    act("save-search", async () => {
      const res = await NodeApi.saveAi(toInput(form, { chat: {}, embed: embedKeyCleared }, baseUrls, "embed"));
      applied(res.settings);
      setForm((f) => withSavedHalf(f, toForm(res.settings), "embed"));
      setProbe(res.probe);
      setEditingSearch(false);
      if (res.reembed?.armed) {
        status.setNotice({ status: "success", message: `Re-indexing with ${res.settings.embed.model}. Search matches words until it finishes.` });
      }
    });

  const testSearch = () =>
    act("test-search", async () => {
      setProbe(await NodeApi.testAi(toInput({ ...form, embedEnabled: true }, { chat: {}, embed: embedKeyCleared }, baseUrls, "embed")));
    });

  const removeSearch = () =>
    act("remove-search", async () => {
      applied((await NodeApi.saveAi({ embed: { provider: "", base_url: "", model: "", api_key: "" } })).settings);
      setEditingSearch(false);
    });

  // ---- ranking ----

  const setRerankOn = (on: boolean) =>
    act("rerank-switch", async () => {
      applied((await NodeApi.saveAi(rerankInput(rerankFormOf(settings), { enabled: on }))).settings);
    });

  function editRerank() {
    setRerankDraft(rerankFormOf(settings));
    setRerankKeyCleared(false);
  }

  const saveRerank = () =>
    act("save-rerank", async () => {
      if (!rerankDraft) return;
      const res = await NodeApi.saveAi(rerankInput(rerankDraft, { clearKey: rerankKeyCleared }));
      applied(res.settings);
      setProbe(res.probe);
      setRerankDraft(null);
    });

  // Switched on for the test, so a switched-off ranker is asked too.
  const testRerank = () =>
    act("test-rerank", async () => {
      if (!rerankDraft) return;
      setProbe(await NodeApi.testAi(rerankInput(rerankDraft, { clearKey: rerankKeyCleared, enabled: true })));
    });

  const removeRerank = () =>
    act("remove-rerank", async () => {
      applied((await NodeApi.saveAi(rerankInput({ baseUrl: "", model: "", key: "" }))).settings);
      setRerankDraft(null);
    });

  /** What reranks passages while no reranker is set up. */
  const rerankFallback = settings.chat.running ? "Built-in AI reranks passages." : "Passages keep their search order.";
  const rerankLabel = (baseUrl: string) => RERANK_PRESETS.find((p) => p.value === rerankPresetFor(baseUrl) && p.value !== "custom")?.label ?? baseUrl;

  // ---- the page ----

  const offered = allChatModelIds(toForm(settings).chatEndpoints);
  const removingProvider = confirm?.kind === "remove-provider" ? confirm.id : null;

  return (
    <>
      {/* Someone with their own subscription looks here first, and needs nothing on this page. */}
      <Text type="supporting" color="secondary">
        Using Claude, Codex or another AI on your own subscription? Connect it in{" "}
        {/* In-app navigation: a full page load would drop the in-memory session. */}
        <Link type="supporting" onClick={() => nav("/settings/agents")}>Your AI agents</Link>.
      </Text>
      <SectionStatusBanners status={status} />
      {probe && <ProbeBanner probe={probe} labels={labels} level={level} />}

      <VStack gap={3}>
        <HalfHead
          {...HALF_COPY.chat}
          toggle={
            providers.length > 0 && (
              <Switch label={HALF_COPY.chat.title} isLabelHidden value={settings.chat.enabled} isDisabled={busy === "chat-switch"} onChange={(v: boolean) => void setChatOn(v)} />
            )
          }
        />

        {providers.length === 0 &&
          (adding ? (
            <Card>
              <ConnectForm half="chat" settings={settings} onConnected={connected} onCancel={() => setAdding(false)} />
            </Card>
          ) : (
            <NotSetUp note="Not set up." onSetUp={() => setAdding(true)} />
          ))}

        {providers.map((ep) =>
          draft?.id === ep.id ? (
            <Card key={ep.id} variant="muted">
              <VStack gap={3}>
                <Selector
                  label="Service"
                  options={presets.map((o) => ({ value: o.value, label: o.label }))}
                  value={presetFor(presets, draft.provider, draft.baseUrl)}
                  onChange={(v: string) => {
                    const preset = presets.find((x) => x.value === v);
                    if (!preset) return;
                    // Discovered models belong to the old host.
                    setFound(({ [ep.id]: _drop, ...rest }) => rest);
                    setDraft({ ...draft, provider: preset.provider, baseUrl: preset.baseUrl });
                  }}
                />
                <VStack gap={1}>
                  <TextInput
                    label="API key"
                    type="password"
                    value={draft.key}
                    placeholder={ep.api_key_set ? "Leave blank to keep the current key" : "Not set"}
                    onChange={(v: string) => setDraft({ ...draft, key: v })}
                  />
                  <StoredSecret
                    onFile={ep.api_key_set ? `Key set · ${ep.api_key_fingerprint ?? "on file"}` : null}
                    removed={draftKeyCleared}
                    onRemove={() => setDraftKeyCleared(true)}
                    removeLabel="Remove key"
                    removedNote="The key will be removed when you save."
                  />
                </VStack>
                <HStack gap={2} vAlign="end">
                  {found[ep.id]?.length ? (
                    <MultiSelector
                      label="Models offered"
                      options={modelOptions(found[ep.id]!, modelIds(draft.models))}
                      value={modelIds(draft.models)}
                      hasSearch
                      onChange={(ids: string[]) => setDraft({ ...draft, models: withSelectedModels(draft.models, ids) })}
                    />
                  ) : (
                    <TextInput
                      label="Models offered"
                      value={draft.models}
                      placeholder="gpt-4.1=GPT-4.1, o3-mini=o3 mini"
                      onChange={(v: string) => setDraft({ ...draft, models: v })}
                    />
                  )}
                  <Button label="Fetch models" variant="secondary" size="sm" isLoading={fetching === ep.id} onClick={() => void discover(draft)} />
                </HStack>
                <Collapsible trigger="Advanced" defaultIsOpen={presetFor(presets, draft.provider, draft.baseUrl) === "custom"}>
                  <VStack gap={3}>
                    <Selector label="API protocol" options={PROVIDERS} value={draft.provider} onChange={(v: string) => setDraft({ ...draft, provider: v })} />
                    <TextInput label="Base URL" value={draft.baseUrl} placeholder={baseUrls[draft.provider]} onChange={(v: string) => setDraft({ ...draft, baseUrl: v })} />
                  </VStack>
                </Collapsible>
                <HStack gap={2}>
                  <Button label="Save" variant="primary" size="sm" isLoading={busy === "save-provider"} onClick={() => void saveProvider()} />
                  <Button label="Test" variant="secondary" size="sm" isLoading={busy === "test-provider"} onClick={() => void testProvider()} />
                  <Button label="Cancel" variant="ghost" size="sm" onClick={() => setDraft(null)} />
                </HStack>
              </VStack>
            </Card>
          ) : (
            <ServiceRow
              key={ep.id}
              title={labels[ep.id] ?? ep.base_url}
              detail={[ep.models.map((m) => m.name).join(", ") || "No models offered", ep.api_key_stale ? "key file missing" : null].filter(Boolean).join(" · ")}
            >
              <Button label="Edit" variant="ghost" size="sm" onClick={() => edit(ep.id)} />
              <Button
                label="Remove"
                variant="ghost"
                size="sm"
                isLoading={busy === "remove-provider" && removingProvider === ep.id}
                onClick={() => setConfirm({ kind: "remove-provider", id: ep.id })}
              />
            </ServiceRow>
          ),
        )}

        {providers.length > 0 &&
          (adding ? (
            <Card>
              <ConnectForm half="chat" settings={settings} onConnected={connected} onCancel={() => setAdding(false)} />
            </Card>
          ) : (
            <HStack>
              <Button
                label="Connect another provider"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(null);
                  setAdding(true);
                }}
              />
            </HStack>
          ))}

        {offered.length > 1 && (
          <Selector
            label="Default model"
            options={modelOptions(offered, settings.chat.default_model)}
            value={settings.chat.default_model}
            hasSearch
            isDisabled={busy === "default"}
            onChange={(v: string) => v !== settings.chat.default_model && void saveDefault(v)}
          />
        )}
      </VStack>

      <Divider />

      <VStack gap={3}>
        <HalfHead
          {...HALF_COPY.search}
          toggle={
            searchSetUp && (
              <Switch
                label={HALF_COPY.search.title}
                isLabelHidden
                value={settings.embed.enabled}
                isDisabled={busy === "search-switch"}
                onChange={(v: boolean) => void setSearchOn(v)}
              />
            )
          }
        />

        {!searchSetUp &&
          (settingUpSearch ? (
            <Card>
              <ConnectForm half="search" settings={settings} onConnected={connected} onCancel={() => setSettingUpSearch(false)} />
            </Card>
          ) : (
            <NotSetUp note="Not set up: search matches words only." onSetUp={() => setSettingUpSearch(true)} />
          ))}

        {searchSetUp && banner && (
          <Banner
            status={banner.status}
            title={banner.title}
            description={banner.description}
            endContent={banner.retry ? <Button label="Measure again" variant="secondary" size="sm" isLoading={busy === "measure"} onClick={() => void measureAgain()} /> : undefined}
          />
        )}

        {searchSetUp && !editingSearch && (
          <ServiceRow
            title={endpointLabel(presets, settings.embed.provider, settings.embed.base_url)}
            detail={[settings.embed.model, searchServiceDetail(settings), settings.embed.api_key_stale ? "key file missing" : null].filter(Boolean).join(" · ")}
          >
            <Button label="Edit" variant="ghost" size="sm" onClick={editSearch} />
            <Button label="Remove" variant="ghost" size="sm" isLoading={busy === "remove-search"} onClick={() => setConfirm({ kind: "remove-search" })} />
          </ServiceRow>
        )}

        {searchSetUp && editingSearch && (
          <Card variant="muted">
            <VStack gap={3}>
              <Selector
                label="Service"
                options={presets.filter((o) => o.embeddings).map((o) => ({ value: o.value, label: o.label }))}
                value={presetFor(presets, form.embedProvider, form.embedBaseUrl)}
                onChange={(v: string) => {
                  const preset = presets.find((x) => x.value === v);
                  if (!preset) return;
                  setFoundEmbed([]);
                  setForm({ ...form, embedProvider: preset.provider, embedBaseUrl: preset.baseUrl });
                }}
              />
              <VStack gap={1}>
                <TextInput
                  label="API key"
                  type="password"
                  value={form.embedKey}
                  placeholder={settings.embed.api_key_set ? "Leave blank to keep the current key" : "Not set"}
                  onChange={(v: string) => setForm({ ...form, embedKey: v })}
                />
                <StoredSecret
                  onFile={settings.embed.api_key_set ? `Key set · ${settings.embed.api_key_fingerprint ?? "on file"}` : null}
                  removed={embedKeyCleared}
                  onRemove={() => setEmbedKeyCleared(true)}
                  removeLabel="Remove key"
                  removedNote="The key will be removed when you save."
                />
              </VStack>
              <HStack gap={2} vAlign="end">
                {foundEmbed.length > 0 ? (
                  <Selector
                    label="Model"
                    placeholder="Choose a model"
                    options={modelOptions(foundEmbed, form.embedModel)}
                    value={form.embedModel}
                    hasSearch
                    onChange={(v: string) => setForm({ ...form, embedModel: v })}
                  />
                ) : (
                  <TextInput label="Model" value={form.embedModel} onChange={(v: string) => setForm({ ...form, embedModel: v })} />
                )}
                <Button label="Fetch models" variant="secondary" size="sm" isLoading={fetching === "embed"} onClick={() => void discoverEmbed()} />
              </HStack>
              <VStack gap={1}>
                <Text type="label">Search strictness</Text>
                <SegmentedControl
                  label="Search strictness"
                  size="sm"
                  layout="fill"
                  value={level}
                  onChange={(v: string) =>
                    // Choosing the default while none is stored keeps following the default.
                    setForm({ ...form, searchStrictness: settings.embed.search_strictness === null && v === settings.strictness_default ? null : (v as SearchStrictness) })
                  }
                >
                  <SegmentedControlItem value="strict" label={STRICTNESS_COPY.strict.label} />
                  <SegmentedControlItem value="balanced" label={STRICTNESS_COPY.balanced.label} />
                  <SegmentedControlItem value="loose" label={STRICTNESS_COPY.loose.label} />
                  <SegmentedControlItem value="off" label={STRICTNESS_COPY.off.label} />
                  {settings.embed.search_strictness === "custom" && <SegmentedControlItem value="custom" label={STRICTNESS_COPY.custom.label} />}
                </SegmentedControl>
                <Text type="supporting" color="secondary">
                  {STRICTNESS_COPY[level].line}
                </Text>
                {note && (
                  <Text type="supporting" color="secondary">
                    {note.text}
                    {note.measureAgain && (
                      <>
                        {" · "}
                        <Link type="supporting" onClick={() => void measureAgain()}>
                          Measure again
                        </Link>
                      </>
                    )}
                  </Text>
                )}
                {warning && (
                  <Text type="supporting" color="secondary">
                    {warning}
                  </Text>
                )}
                {settings.embed.retrieval_max_distance !== null && (
                  <Text type="supporting" color="secondary">
                    Ask and agents: distance {settings.embed.retrieval_max_distance.toFixed(2)}, set by hand ·{" "}
                    <Link type="supporting" onClick={() => void clearRetrievalDistance()}>
                      Clear
                    </Link>
                  </Text>
                )}
              </VStack>
              <Collapsible trigger="Advanced" defaultIsOpen={presetFor(presets, form.embedProvider, form.embedBaseUrl) === "custom"}>
                <VStack gap={3}>
                  <Selector
                    label="API protocol"
                    options={PROVIDERS.filter((o) => o.value !== "anthropic")}
                    value={form.embedProvider}
                    onChange={(v: string) => setForm({ ...form, embedProvider: v })}
                  />
                  <TextInput label="Base URL" value={form.embedBaseUrl} placeholder={baseUrls[form.embedProvider]} onChange={(v: string) => setForm({ ...form, embedBaseUrl: v })} />
                </VStack>
              </Collapsible>
              <HStack gap={2}>
                <Button
                  label="Save"
                  variant="primary"
                  size="sm"
                  isLoading={busy === "save-search"}
                  onClick={() => (embeddingChanged() ? setConfirm({ kind: "reembed" }) : void saveSearch())}
                />
                <Button label="Test" variant="secondary" size="sm" isLoading={busy === "test-search"} onClick={() => void testSearch()} />
                <Button label="Cancel" variant="ghost" size="sm" onClick={() => setEditingSearch(false)} />
              </HStack>
            </VStack>
          </Card>
        )}
      </VStack>

      <Divider />

      <VStack gap={3}>
        <HalfHead
          {...HALF_COPY.rerank}
          toggle={
            rerankSetUp && (
              <Switch
                label={HALF_COPY.rerank.title}
                isLabelHidden
                value={settings.rerank.enabled}
                isDisabled={busy === "rerank-switch"}
                onChange={(v: boolean) => void setRerankOn(v)}
              />
            )
          }
        />

        {!rerankSetUp && !rerankDraft && <NotSetUp note={`Not set up: ${rerankFallback.toLowerCase()}`} onSetUp={editRerank} />}

        {rerankSetUp && !rerankDraft && (
          <ServiceRow
            title={rerankLabel(settings.rerank.base_url)}
            detail={[settings.rerank.model, settings.rerank.api_key_stale ? "key file missing" : null].filter(Boolean).join(" · ")}
          >
            <Button label="Edit" variant="ghost" size="sm" onClick={editRerank} />
            <Button label="Remove" variant="ghost" size="sm" isLoading={busy === "remove-rerank"} onClick={() => setConfirm({ kind: "remove-rerank" })} />
          </ServiceRow>
        )}

        {rerankDraft && (
          <Card variant="muted">
            <VStack gap={3}>
              <Selector
                label="Service"
                options={RERANK_PRESETS.map((o) => ({ value: o.value, label: o.label }))}
                value={rerankPresetFor(rerankDraft.baseUrl)}
                onChange={(v: string) => {
                  const preset = RERANK_PRESETS.find((x) => x.value === v);
                  if (preset) setRerankDraft({ ...rerankDraft, baseUrl: preset.baseUrl, model: preset.model });
                }}
              />
              <VStack gap={1}>
                <TextInput
                  label="API key"
                  type="password"
                  value={rerankDraft.key}
                  placeholder={settings.rerank.api_key_set ? "Leave blank to keep the current key" : "Not set"}
                  onChange={(v: string) => setRerankDraft({ ...rerankDraft, key: v })}
                />
                <StoredSecret
                  onFile={settings.rerank.api_key_set ? `Key set · ${settings.rerank.api_key_fingerprint ?? "on file"}` : null}
                  removed={rerankKeyCleared}
                  onRemove={() => setRerankKeyCleared(true)}
                  removeLabel="Remove key"
                  removedNote="The key will be removed when you save."
                />
              </VStack>
              <TextInput label="Model" value={rerankDraft.model} onChange={(v: string) => setRerankDraft({ ...rerankDraft, model: v })} />
              <Collapsible trigger="Advanced" defaultIsOpen={rerankPresetFor(rerankDraft.baseUrl) === "custom"}>
                <TextInput label="Base URL" value={rerankDraft.baseUrl} onChange={(v: string) => setRerankDraft({ ...rerankDraft, baseUrl: v })} />
              </Collapsible>
              <HStack gap={2}>
                <Button label="Save" variant="primary" size="sm" isLoading={busy === "save-rerank"} onClick={() => void saveRerank()} />
                <Button label="Test" variant="secondary" size="sm" isLoading={busy === "test-rerank"} onClick={() => void testRerank()} />
                <Button label="Cancel" variant="ghost" size="sm" onClick={() => setRerankDraft(null)} />
              </HStack>
            </VStack>
          </Card>
        )}
      </VStack>

      <AlertDialog
        isOpen={removingProvider !== null}
        title={`Remove ${removingProvider ? (labels[removingProvider] ?? "this provider") : "this provider"}?`}
        description={providers.length === 1 ? "Built-in AI stops until you connect another provider." : "Its models leave every model picker."}
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel="Remove"
        onAction={() => {
          const id = removingProvider;
          setConfirm(null);
          if (id) void removeProvider(id);
        }}
      />
      <AlertDialog
        isOpen={confirm?.kind === "remove-search"}
        title="Remove embeddings?"
        description="Search goes back to matching words, and its index is deleted."
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel="Remove"
        onAction={() => {
          setConfirm(null);
          void removeSearch();
        }}
      />
      <AlertDialog
        isOpen={confirm?.kind === "remove-rerank"}
        title="Remove reranking?"
        description={`Its key is deleted. ${rerankFallback}`}
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel="Remove"
        onAction={() => {
          setConfirm(null);
          void removeRerank();
        }}
      />
      <AlertDialog
        isOpen={confirm?.kind === "reembed"}
        title="Re-index every document?"
        description={
          "Vectors from two models cannot be compared, so saving clears them and re-embeds every document. Search matches words until that finishes, and strictness is measured for the new model." +
          (settings.embed.search_strictness === "custom" || settings.embed.retrieval_max_distance !== null ? " Your custom distance is cleared." : "")
        }
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel="Save and re-index"
        onAction={() => {
          setConfirm(null);
          void saveSearch();
        }}
      />
    </>
  );
}
