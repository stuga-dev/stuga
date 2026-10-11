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
import { StackItem } from "@astryxdesign/core/Stack";
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
import { t } from "../../../i18n/i18n";
import { tRich } from "../../../i18n/rich";
import { presentServerMessage } from "../../../lib/http/server-messages";
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
  type Half,
  type BaseUrls,
  type ChatEndpointForm,
  type Form,
  type RerankForm,
} from "./ai-form";
import { ConnectForm, KeyLink, type Connected } from "./ConnectForm";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { StoredSecret } from "./StoredSecret";

/** The badge for a stored key: its fingerprint, or that one is on file. */
const keyOnFile = (fingerprint: string | null | undefined) =>
  fingerprint ? t("node.ai.keySet", { fingerprint }) : t("node.ai.keySetOnFile");

type ProbeRow = { ok: boolean; model?: string; latency_ms?: number; message?: string; skipped?: boolean };

/** While the node measures its embedding model, how often Settings follows along. */
const CALIBRATION_POLL_MS = 2000;

/** What a save or a test heard back from one half, one line per service that was asked, shown in that half. */
function ProbeBanner({ probe, half, labels }: { probe: AiProbe; half: Half; labels: Record<string, string> }) {
  const line = (label: string, r: ProbeRow) =>
    r.ok
      ? r.model && r.latency_ms
        ? t("node.ai.probe.answeredIn", { service: label, model: r.model, seconds: r.latency_ms / 1000 })
        : t("node.ai.probe.ok", { service: label })
      : r.message
        ? t("node.ai.probe.failedWith", { service: label, message: presentServerMessage(r.message) })
        : t("node.ai.probe.failed", { service: label });
  // A skipped row made no request, so it says nothing about the service.
  const asked: Array<[string, ProbeRow]> =
    half === "chat"
      ? probe.chat.filter((r) => !r.skipped).map((r) => [labels[r.id] ?? r.id, r])
      : half === "search"
        ? probe.embed.skipped
          ? []
          : [[HALF_COPY.search.title, probe.embed]]
        : probe.rerank.skipped
          ? []
          : [[HALF_COPY.rerank.title, probe.rerank]];
  if (asked.length === 0) return null;
  const ok = asked.every(([, r]) => r.ok);
  return (
    <Banner
      status={ok ? "success" : "error"}
      title={ok ? t("node.ai.probe.answered") : t("node.ai.probe.unexpected")}
      description={
        <VStack gap={1}>
          {asked.map(([label, r], i) => (
            <Text key={i} type="supporting">
              {line(label, r)}
            </Text>
          ))}
        </VStack>
      }
    />
  );
}

/** A switch that says On or Off beside it, so its state reads without knowing the control. */
function OnOffSwitch({ label, value, isDisabled, onChange }: { label: string; value: boolean; isDisabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <HStack gap={2} vAlign="center">
      <Text type="supporting" color="secondary" aria-hidden>
        {value ? t("node.ai.switchOn") : t("node.ai.switchOff")}
      </Text>
      <Switch label={label} isLabelHidden value={value} isDisabled={isDisabled} onChange={onChange} />
    </HStack>
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
      <Button label={t("node.ai.setUp")} variant="secondary" size="sm" onClick={onSetUp} />
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
  /** The last save's or test's answer, and the half it was about, which shows it beside what was tested. */
  const [probe, setProbe] = useState<{ half: Half; result: AiProbe } | null>(null);
  /** The half the last action was in: its outcome line shows there, not at the top of the page. */
  const [statusHalf, setStatusHalf] = useState<Half>("chat");
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

  // The local Ollama takes no key, as Set up asks none; a key already on file can still be removed.
  // A key typed before switching to it is dropped with its field.
  const asksKey = (provider: string, baseUrl: string, keySet: boolean) => keySet || presetFor(presets, provider, baseUrl) !== "ollama";
  const setProviderDraft = (d: ChatEndpointForm, keySet: boolean) => setDraft(asksKey(d.provider, d.baseUrl, keySet) ? d : { ...d, key: "" });
  const setSearchForm = (f: Form) => setForm(asksKey(f.embedProvider, f.embedBaseUrl, settings.embed.api_key_set) ? f : { ...f, embedKey: "" });
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
    const timer = setInterval(() => {
      const asked = savedAt.current;
      void NodeApi.ai()
        .then((next) => alive && asked === savedAt.current && onSaved(next))
        .catch(() => {});
    }, CALIBRATION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [measuring, onSaved]);

  const measureAgain = () =>
    act("measure", "search", async () => {
      await NodeApi.calibrateAi();
      onSaved(await NodeApi.ai());
    });

  /** One action at a time, its outcome shown in the half it was about. */
  async function act(key: string, half: Half, fn: () => Promise<void>) {
    setBusy(key);
    setStatusHalf(half);
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

  /** Opening or closing a form leaves the last outcome behind: it was about what was there before. */
  function clearOutcome() {
    status.clear();
    setProbe(null);
  }

  function connected(half: Half, result: Connected) {
    applied(result.settings);
    setStatusHalf(half);
    setForm((f) => withSavedHalf(f, toForm(result.settings), "embed"));
    setAdding(false);
    setSettingUpSearch(false);
    status.clear();
    if (result.message) status.setNotice({ status: "success", message: result.message });
  }

  // ---- chat ----

  const setChatOn = (on: boolean) =>
    act("chat-switch", "chat", async () => {
      applied((await NodeApi.saveAi(chatInputWith(settings, { enabled: on }, baseUrls))).settings);
    });

  async function discover(ep: ChatEndpointForm) {
    setFetching(ep.id);
    setStatusHalf("chat");
    try {
      // With no key typed, the node uses the saved provider's own.
      const r = await NodeApi.discoverModels("chat", ep.provider, ep.baseUrl || baseUrls[ep.provider] || "", ep.key || undefined);
      setFound((f) => ({ ...f, [ep.id]: r.models }));
      if (r.models.length === 0) status.setNotice({ status: "warning", message: t("node.ai.noModelsListed") });
    } catch (e) {
      status.fail(e);
    } finally {
      setFetching("");
    }
  }

  function edit(id: string) {
    const ep = toForm(settings).chatEndpoints.find((e) => e.id === id);
    if (!ep) return;
    clearOutcome();
    setDraft(ep);
    setDraftKeyCleared(false);
    setAdding(false);
    if (!found[id]) void discover(ep);
  }

  const saveProvider = () =>
    act("save-provider", "chat", async () => {
      if (!draft) return;
      const res = await NodeApi.saveAi(chatInputWith(settings, { edit: draft, clearKeyOf: draftKeyCleared ? draft.id : undefined }, baseUrls));
      applied(res.settings);
      setProbe({ half: "chat", result: res.probe });
      setDraft(null);
    });

  // Switched on for the test, so a switched-off half is asked too.
  const testProvider = () =>
    act("test-provider", "chat", async () => {
      if (!draft) return;
      setProbe({ half: "chat", result: await NodeApi.testAi(chatInputWith(settings, { edit: draft, clearKeyOf: draftKeyCleared ? draft.id : undefined, enabled: true }, baseUrls)) });
    });

  const removeProvider = (id: string) =>
    act("remove-provider", "chat", async () => {
      applied((await NodeApi.saveAi(chatInputWith(settings, { removeId: id }, baseUrls))).settings);
      if (draft?.id === id) setDraft(null);
    });

  const saveDefault = (model: string) =>
    act("default", "chat", async () => {
      applied((await NodeApi.saveAi(chatInputWith(settings, { defaultModel: model }, baseUrls))).settings);
    });

  // ---- semantic search ----

  const setSearchOn = (on: boolean) =>
    act("search-switch", "search", async () => {
      const res = await NodeApi.saveAi(toInput({ ...toForm(settings), embedEnabled: on }, NO_CLEARED_KEYS, baseUrls, "embed"));
      applied(res.settings);
      setForm((f) => ({ ...f, embedEnabled: res.settings.embed.enabled }));
    });

  function editSearch() {
    clearOutcome();
    setForm(toForm(settings));
    setEmbedKeyCleared(false);
    setFoundEmbed([]);
    setEditingSearch(true);
  }

  async function discoverEmbed() {
    status.setError(null);
    setStatusHalf("search");
    setFetching("embed");
    try {
      const r = await NodeApi.discoverModels("embed", form.embedProvider, form.embedBaseUrl, form.embedKey);
      setFoundEmbed(r.models);
      if (r.models.length === 0) status.setNotice({ status: "warning", message: t("node.ai.noEmbeddingModelsListed") });
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
    act("save-search", "search", async () => {
      const res = await NodeApi.saveAi(toInput(form, { chat: {}, embed: embedKeyCleared }, baseUrls, "embed"));
      applied(res.settings);
      setForm((f) => withSavedHalf(f, toForm(res.settings), "embed"));
      setProbe({ half: "search", result: res.probe });
      setEditingSearch(false);
      if (res.reembed?.armed) {
        status.setNotice({ status: "success", message: t("node.ai.reindexing", { model: res.settings.embed.model ?? "" }) });
      }
    });

  const testSearch = () =>
    act("test-search", "search", async () => {
      setProbe({ half: "search", result: await NodeApi.testAi(toInput({ ...form, embedEnabled: true }, { chat: {}, embed: embedKeyCleared }, baseUrls, "embed")) });
    });

  const removeSearch = () =>
    act("remove-search", "search", async () => {
      applied((await NodeApi.saveAi({ embed: { provider: "", base_url: "", model: "", api_key: "" } })).settings);
      setEditingSearch(false);
    });

  // ---- ranking ----

  const setRerankOn = (on: boolean) =>
    act("rerank-switch", "rerank", async () => {
      applied((await NodeApi.saveAi(rerankInput(rerankFormOf(settings), { enabled: on }))).settings);
    });

  function editRerank() {
    clearOutcome();
    setRerankDraft(rerankFormOf(settings));
    setRerankKeyCleared(false);
  }

  const saveRerank = () =>
    act("save-rerank", "rerank", async () => {
      if (!rerankDraft) return;
      const res = await NodeApi.saveAi(rerankInput(rerankDraft, { clearKey: rerankKeyCleared }));
      applied(res.settings);
      setProbe({ half: "rerank", result: res.probe });
      setRerankDraft(null);
    });

  // Switched on for the test, so a switched-off ranker is asked too.
  const testRerank = () =>
    act("test-rerank", "rerank", async () => {
      if (!rerankDraft) return;
      setProbe({ half: "rerank", result: await NodeApi.testAi(rerankInput(rerankDraft, { clearKey: rerankKeyCleared, enabled: true })) });
    });

  const removeRerank = () =>
    act("remove-rerank", "rerank", async () => {
      applied((await NodeApi.saveAi(rerankInput({ baseUrl: "", model: "", key: "" }))).settings);
      setRerankDraft(null);
    });

  /** What reranks passages while no reranker is set up. */
  const chatReranks = settings.chat.running;
  const rerankLabel = (baseUrl: string) => RERANK_PRESETS.find((p) => p.value === rerankPresetFor(baseUrl) && p.value !== "custom")?.label ?? baseUrl;
  const rerankPreset = rerankDraft ? RERANK_PRESETS.find((p) => p.value === rerankPresetFor(rerankDraft.baseUrl)) : undefined;
  const rerankKeyUrl = rerankPreset?.keyUrl ? { url: rerankPreset.keyUrl, label: rerankPreset.label } : null;

  // ---- the page ----

  const offered = allChatModelIds(toForm(settings).chatEndpoints);
  const removingProvider = confirm?.kind === "remove-provider" ? confirm.id : null;
  /** What the last action in a half heard back, shown in that half under what was tested. */
  const outcome = (half: Half) => (
    <>
      {statusHalf === half && <SectionStatusBanners status={status} />}
      {probe?.half === half && <ProbeBanner probe={probe.result} half={half} labels={labels} />}
    </>
  );

  return (
    <>
      {/* Under the page's title, from the rail. Someone with their own subscription looks here first, and needs nothing on this page. */}
      <Text type="supporting" color="secondary">
        {tRich("node.ai.ownSubscription", {
          // In-app navigation: a full page load would drop the in-memory session.
          link: (chunks) => (
            <Link type="supporting" onClick={() => nav("/settings/agents")}>
              {chunks}
            </Link>
          ),
        })}
      </Text>

      <VStack gap={3}>
        <HalfHead
          {...HALF_COPY.chat}
          toggle={
            providers.length > 0 && (
              <OnOffSwitch label={HALF_COPY.chat.title} value={settings.chat.enabled} isDisabled={busy === "chat-switch"} onChange={(v) => void setChatOn(v)} />
            )
          }
        />

        {providers.length === 0 &&
          (adding ? (
            <Card>
              <ConnectForm half="chat" settings={settings} onConnected={(r) => connected("chat", r)} onCancel={() => setAdding(false)} />
            </Card>
          ) : (
            <NotSetUp
              note={t("node.ai.notSetUp")}
              onSetUp={() => {
                clearOutcome();
                setAdding(true);
              }}
            />
          ))}

        {providers.map((ep) =>
          draft?.id === ep.id ? (
            <Card key={ep.id} variant="muted">
              <VStack gap={3}>
                <Selector
                  label={t("node.ai.service")}
                  options={presets.map((o) => ({ value: o.value, label: o.label }))}
                  value={presetFor(presets, draft.provider, draft.baseUrl)}
                  onChange={(v: string) => {
                    const preset = presets.find((x) => x.value === v);
                    if (!preset) return;
                    // Discovered models belong to the old host.
                    setFound(({ [ep.id]: _drop, ...rest }) => rest);
                    setProviderDraft({ ...draft, provider: preset.provider, baseUrl: preset.baseUrl }, ep.api_key_set);
                  }}
                />
                {asksKey(draft.provider, draft.baseUrl, ep.api_key_set) && (
                  <VStack gap={1}>
                    <TextInput
                      label={t("node.ai.apiKey")}
                      type="password"
                      value={draft.key}
                      placeholder={ep.api_key_set ? t("node.ai.keepKey") : t("node.ai.keyNotSet")}
                      onChange={(v: string) => setDraft({ ...draft, key: v })}
                    />
                    <StoredSecret
                      onFile={ep.api_key_set ? keyOnFile(ep.api_key_fingerprint) : null}
                      removed={draftKeyCleared}
                      onRemove={() => setDraftKeyCleared(true)}
                      removeLabel={t("node.ai.removeKey")}
                      removedNote={t("node.ai.keyRemovedOnSave")}
                    />
                  </VStack>
                )}
                <HStack gap={2} vAlign="end">
                  <StackItem size="fill">
                    {found[ep.id]?.length ? (
                      <MultiSelector
                        label={t("node.ai.modelsOffered")}
                        width="100%"
                        options={modelOptions(found[ep.id]!, modelIds(draft.models))}
                        value={modelIds(draft.models)}
                        hasSearch
                        onChange={(ids: string[]) => setDraft({ ...draft, models: withSelectedModels(draft.models, ids) })}
                      />
                    ) : (
                      <TextInput
                        label={t("node.ai.modelsOffered")}
                        width="100%"
                        value={draft.models}
                        placeholder="gpt-4.1=GPT-4.1, o3-mini=o3 mini" // i18n-exempt: model ids, the format typed
                        onChange={(v: string) => setDraft({ ...draft, models: v })}
                      />
                    )}
                  </StackItem>
                  <Button label={t("node.ai.fetchModels")} variant="secondary" size="sm" isLoading={fetching === ep.id} onClick={() => void discover(draft)} />
                </HStack>
                <Collapsible trigger={t("node.ai.advanced")} defaultIsOpen={presetFor(presets, draft.provider, draft.baseUrl) === "custom"}>
                  <VStack gap={3}>
                    <Selector label={t("node.ai.apiProtocol")} options={PROVIDERS} value={draft.provider} onChange={(v: string) => setProviderDraft({ ...draft, provider: v }, ep.api_key_set)} />
                    <TextInput label={t("node.ai.baseUrl")} value={draft.baseUrl} placeholder={baseUrls[draft.provider]} onChange={(v: string) => setProviderDraft({ ...draft, baseUrl: v }, ep.api_key_set)} />
                  </VStack>
                </Collapsible>
                <HStack gap={2}>
                  <Button label={t("common.save")} variant="primary" size="sm" isLoading={busy === "save-provider"} onClick={() => void saveProvider()} />
                  <Button label={t("node.ai.test")} variant="secondary" size="sm" isLoading={busy === "test-provider"} onClick={() => void testProvider()} />
                  <Button
                    label={t("common.cancel")}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      clearOutcome();
                      setDraft(null);
                    }}
                  />
                </HStack>
                {outcome("chat")}
              </VStack>
            </Card>
          ) : (
            <ServiceRow
              key={ep.id}
              title={labels[ep.id] ?? ep.base_url}
              detail={[ep.models.map((m) => m.name).join(", ") || t("node.ai.noModelsOffered"), ep.api_key_stale ? t("node.ai.keyFileMissing") : null].filter(Boolean).join(" · ")}
            >
              <Button label={t("node.ai.edit")} variant="ghost" size="sm" onClick={() => edit(ep.id)} />
              <Button
                label={t("common.remove")}
                variant="destructive"
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
              <ConnectForm half="chat" settings={settings} onConnected={(r) => connected("chat", r)} onCancel={() => setAdding(false)} />
            </Card>
          ) : (
            <HStack>
              <Button
                label={t("node.ai.connectAnother")}
                variant="secondary"
                size="sm"
                onClick={() => {
                  clearOutcome();
                  setDraft(null);
                  setAdding(true);
                }}
              />
            </HStack>
          ))}

        {offered.length > 1 && (
          <Selector
            label={t("node.ai.defaultModel")}
            options={modelOptions(offered, settings.chat.default_model)}
            value={settings.chat.default_model}
            hasSearch
            isDisabled={busy === "default"}
            onChange={(v: string) => v !== settings.chat.default_model && void saveDefault(v)}
          />
        )}
        {!draft && outcome("chat")}
      </VStack>

      <Divider />

      <VStack gap={3}>
        <HalfHead
          {...HALF_COPY.search}
          toggle={
            searchSetUp && (
              <OnOffSwitch label={HALF_COPY.search.title} value={settings.embed.enabled} isDisabled={busy === "search-switch"} onChange={(v) => void setSearchOn(v)} />
            )
          }
        />

        {!searchSetUp &&
          (settingUpSearch ? (
            <Card>
              <ConnectForm half="search" settings={settings} onConnected={(r) => connected("search", r)} onCancel={() => setSettingUpSearch(false)} />
            </Card>
          ) : (
            <NotSetUp
              note={t("node.ai.searchNotSetUp")}
              onSetUp={() => {
                clearOutcome();
                setSettingUpSearch(true);
              }}
            />
          ))}

        {searchSetUp && banner && (
          <Banner
            status={banner.status}
            title={banner.title}
            description={banner.description}
            endContent={banner.retry ? <Button label={t("node.ai.measureAgain")} variant="secondary" size="sm" isLoading={busy === "measure"} onClick={() => void measureAgain()} /> : undefined}
          />
        )}

        {searchSetUp && !editingSearch && (
          <ServiceRow
            title={endpointLabel(presets, settings.embed.provider, settings.embed.base_url)}
            detail={[settings.embed.model, searchServiceDetail(settings), settings.embed.api_key_stale ? t("node.ai.keyFileMissing") : null].filter(Boolean).join(" · ")}
          >
            <Button label={t("node.ai.edit")} variant="ghost" size="sm" onClick={editSearch} />
            <Button label={t("common.remove")} variant="destructive" size="sm" isLoading={busy === "remove-search"} onClick={() => setConfirm({ kind: "remove-search" })} />
          </ServiceRow>
        )}

        {searchSetUp && editingSearch && (
          <Card variant="muted">
            <VStack gap={3}>
              <Selector
                label={t("node.ai.service")}
                options={presets.filter((o) => o.embeddings).map((o) => ({ value: o.value, label: o.label }))}
                value={presetFor(presets, form.embedProvider, form.embedBaseUrl)}
                onChange={(v: string) => {
                  const preset = presets.find((x) => x.value === v);
                  if (!preset) return;
                  setFoundEmbed([]);
                  setSearchForm({ ...form, embedProvider: preset.provider, embedBaseUrl: preset.baseUrl });
                }}
              />
              {asksKey(form.embedProvider, form.embedBaseUrl, settings.embed.api_key_set) && (
                <VStack gap={1}>
                  <TextInput
                    label={t("node.ai.apiKey")}
                    type="password"
                    value={form.embedKey}
                    placeholder={settings.embed.api_key_set ? t("node.ai.keepKey") : t("node.ai.keyNotSet")}
                    onChange={(v: string) => setForm({ ...form, embedKey: v })}
                  />
                  <StoredSecret
                    onFile={settings.embed.api_key_set ? keyOnFile(settings.embed.api_key_fingerprint) : null}
                    removed={embedKeyCleared}
                    onRemove={() => setEmbedKeyCleared(true)}
                    removeLabel={t("node.ai.removeKey")}
                    removedNote={t("node.ai.keyRemovedOnSave")}
                  />
                </VStack>
              )}
              <HStack gap={2} vAlign="end">
                <StackItem size="fill">
                  {foundEmbed.length > 0 ? (
                    <Selector
                      label={t("node.ai.model")}
                      width="100%"
                      placeholder={t("node.ai.chooseModel")}
                      options={modelOptions(foundEmbed, form.embedModel)}
                      value={form.embedModel}
                      hasSearch
                      onChange={(v: string) => setForm({ ...form, embedModel: v })}
                    />
                  ) : (
                    <TextInput label={t("node.ai.model")} width="100%" value={form.embedModel} onChange={(v: string) => setForm({ ...form, embedModel: v })} />
                  )}
                </StackItem>
                <Button label={t("node.ai.fetchModels")} variant="secondary" size="sm" isLoading={fetching === "embed"} onClick={() => void discoverEmbed()} />
              </HStack>
              {/* Strictness and the address have working defaults, so they wait behind Advanced. */}
              <Collapsible trigger={t("node.ai.advanced")} defaultIsOpen={presetFor(presets, form.embedProvider, form.embedBaseUrl) === "custom" || !!warning}>
                <VStack gap={3}>
                  <VStack gap={1}>
                    <Text type="label">{t("node.ai.strictness.label")}</Text>
                    <Text type="supporting" color="secondary">
                      {t("node.ai.strictness.about")}
                    </Text>
                    <SegmentedControl
                      label={t("node.ai.strictness.label")}
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
                              {t("node.ai.measureAgain")}
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
                  </VStack>
                  <Selector
                    label={t("node.ai.apiProtocol")}
                    options={PROVIDERS.filter((o) => o.value !== "anthropic")}
                    value={form.embedProvider}
                    onChange={(v: string) => setSearchForm({ ...form, embedProvider: v })}
                  />
                  <TextInput label={t("node.ai.baseUrl")} value={form.embedBaseUrl} placeholder={baseUrls[form.embedProvider]} onChange={(v: string) => setSearchForm({ ...form, embedBaseUrl: v })} />
                </VStack>
              </Collapsible>
              <HStack gap={2}>
                <Button
                  label={t("common.save")}
                  variant="primary"
                  size="sm"
                  isLoading={busy === "save-search"}
                  onClick={() => (embeddingChanged() ? setConfirm({ kind: "reembed" }) : void saveSearch())}
                />
                <Button label={t("node.ai.test")} variant="secondary" size="sm" isLoading={busy === "test-search"} onClick={() => void testSearch()} />
                <Button
                  label={t("common.cancel")}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearOutcome();
                    setEditingSearch(false);
                  }}
                />
              </HStack>
              {outcome("search")}
            </VStack>
          </Card>
        )}
        {!editingSearch && outcome("search")}
      </VStack>

      <Divider />

      <VStack gap={3}>
        <HalfHead
          {...HALF_COPY.rerank}
          toggle={
            rerankSetUp && (
              <OnOffSwitch label={HALF_COPY.rerank.title} value={settings.rerank.enabled} isDisabled={busy === "rerank-switch"} onChange={(v) => void setRerankOn(v)} />
            )
          }
        />

        {!rerankSetUp && !rerankDraft && <NotSetUp note={chatReranks ? t("node.ai.rerankNotSetUpChat") : t("node.ai.rerankNotSetUpOrder")} onSetUp={editRerank} />}

        {rerankSetUp && !rerankDraft && (
          <ServiceRow
            title={rerankLabel(settings.rerank.base_url)}
            detail={[settings.rerank.model, settings.rerank.api_key_stale ? t("node.ai.keyFileMissing") : null].filter(Boolean).join(" · ")}
          >
            <Button label={t("node.ai.edit")} variant="ghost" size="sm" onClick={editRerank} />
            <Button label={t("common.remove")} variant="destructive" size="sm" isLoading={busy === "remove-rerank"} onClick={() => setConfirm({ kind: "remove-rerank" })} />
          </ServiceRow>
        )}

        {rerankDraft && (
          <Card variant="muted">
            <VStack gap={3}>
              <Selector
                label={t("node.ai.service")}
                options={RERANK_PRESETS.map((o) => ({ value: o.value, label: o.label }))}
                value={rerankPresetFor(rerankDraft.baseUrl)}
                onChange={(v: string) => {
                  const preset = RERANK_PRESETS.find((x) => x.value === v);
                  if (preset) setRerankDraft({ ...rerankDraft, baseUrl: preset.baseUrl, model: preset.model });
                }}
              />
              <VStack gap={1}>
                <TextInput
                  label={t("node.ai.apiKey")}
                  type="password"
                  value={rerankDraft.key}
                  placeholder={settings.rerank.api_key_set ? t("node.ai.keepKey") : t("node.ai.keyNotSet")}
                  onChange={(v: string) => setRerankDraft({ ...rerankDraft, key: v })}
                />
                <StoredSecret
                  onFile={settings.rerank.api_key_set ? keyOnFile(settings.rerank.api_key_fingerprint) : null}
                  removed={rerankKeyCleared}
                  onRemove={() => setRerankKeyCleared(true)}
                  removeLabel={t("node.ai.removeKey")}
                  removedNote={t("node.ai.keyRemovedOnSave")}
                />
                {rerankKeyUrl && <KeyLink url={rerankKeyUrl.url} label={t("nodeAccess.connect.getKey", { service: rerankKeyUrl.label })} />}
              </VStack>
              <TextInput label={t("node.ai.model")} value={rerankDraft.model} onChange={(v: string) => setRerankDraft({ ...rerankDraft, model: v })} />
              <Collapsible trigger={t("node.ai.advanced")} defaultIsOpen={rerankPresetFor(rerankDraft.baseUrl) === "custom"}>
                <TextInput label={t("node.ai.baseUrl")} value={rerankDraft.baseUrl} onChange={(v: string) => setRerankDraft({ ...rerankDraft, baseUrl: v })} />
              </Collapsible>
              <HStack gap={2}>
                <Button label={t("common.save")} variant="primary" size="sm" isLoading={busy === "save-rerank"} onClick={() => void saveRerank()} />
                <Button label={t("node.ai.test")} variant="secondary" size="sm" isLoading={busy === "test-rerank"} onClick={() => void testRerank()} />
                <Button
                  label={t("common.cancel")}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearOutcome();
                    setRerankDraft(null);
                  }}
                />
              </HStack>
              {outcome("rerank")}
            </VStack>
          </Card>
        )}
        {!rerankDraft && outcome("rerank")}
      </VStack>

      <AlertDialog
        isOpen={removingProvider !== null}
        title={
          removingProvider && labels[removingProvider]
            ? t("node.ai.removeProviderNamed", { name: labels[removingProvider] })
            : t("node.ai.removeProviderThis")
        }
        description={providers.length === 1 ? t("node.ai.removeLastProvider") : t("node.ai.removeProviderBody")}
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel={t("common.remove")}
        onAction={() => {
          const id = removingProvider;
          setConfirm(null);
          if (id) void removeProvider(id);
        }}
      />
      <AlertDialog
        isOpen={confirm?.kind === "remove-search"}
        title={t("node.ai.removeSearchTitle")}
        description={t("node.ai.removeSearchBody")}
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel={t("common.remove")}
        onAction={() => {
          setConfirm(null);
          void removeSearch();
        }}
      />
      <AlertDialog
        isOpen={confirm?.kind === "remove-rerank"}
        title={t("node.ai.removeRerankTitle")}
        description={chatReranks ? t("node.ai.removeRerankBodyChat") : t("node.ai.removeRerankBodyOrder")}
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel={t("common.remove")}
        onAction={() => {
          setConfirm(null);
          void removeRerank();
        }}
      />
      <AlertDialog
        isOpen={confirm?.kind === "reembed"}
        title={t("node.ai.reembedTitle")}
        description={t("node.ai.reembedBody")}
        onOpenChange={(open) => !open && setConfirm(null)}
        actionLabel={t("node.ai.reembedAction")}
        onAction={() => {
          setConfirm(null);
          void saveSearch();
        }}
      />
    </>
  );
}
