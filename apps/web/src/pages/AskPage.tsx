/**
 * Ask your documents. The server searches, reads and searches again until it can
 * answer, so the page shows that work (a live activity line, the trace, the
 * sources) and keeps each conversation as a saved thread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AskProvider, useAsk, type AskUiTurn } from "../ai/ask-context";
import { Collections, type CollectionSummary } from "../api";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import { denseFootnoteMap } from "@stuga/crdt-ops";
import { renderAssistantHtml } from "../ai/render-markdown";
import { CitationPopover } from "../ai/CitationPopover";
import { answerText, type CitationDetail } from "../ai/citations";
import { AskThreadList } from "../ai/ask/AskThreadList";
import { CollectionEditor } from "../library/CollectionEditor";
import { PromptDialog } from "../ui/PromptDialog";
import { AskTrace } from "../ai/ask/AskTrace";
import { AskSources } from "../ai/ask/AskSources";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Selector, type SelectorOptionType } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowDown, Check, Copy, Files, Library, Plus, Settings2, Sparkles } from "lucide-react";
import { LoadFailed } from "../ui/LoadFailed";
import { takeStored, writeStored } from "../lib/storage";
import { isComposingKey } from "../lib/ime";
import { copyText } from "../lib/clipboard";
import { useAiChat } from "../state/model-options";
import { AiSetupNotice } from "../ai/AiSetupNotice";
import { t } from "../i18n/i18n";
import { AppTopNav } from "../shell/AppTopNav";
import "../styles/ask.css";

function AskTurnView({
  turn,
  onCitationClick,
  onRetry,
}: {
  turn: AskUiTurn;
  onCitationClick: (e: React.MouseEvent, citations: AiCitation[]) => void;
  /** Only the last turn, when it failed or stopped. */
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  // The renderer derives the same map, so the cards and the chips in the prose agree on numbers.
  const renumber = useMemo(() => denseFootnoteMap(turn.answer, 1), [turn.answer]);
  // Memoized: a streaming turn re-renders on every token. Citations arrive only at the end, so markers stay inert until then.
  const html = useMemo(
    () => renderAssistantHtml(turn.answer, turn.citations, { pending: !!turn.streaming }),
    [turn.answer, turn.citations, turn.streaming],
  );

  return (
    <article className="ask-turn">
      <h2 className="ask-turn__question">{turn.question}</h2>

      {turn.steps.length > 0 && <AskTrace steps={turn.steps} isWorking={turn.streaming} />}

      {turn.streaming && turn.status && (
        <div className="ai-activity">
          <span className="ai-activity__dot" />
          <span className="ai-activity__label">{turn.status}</span>
        </div>
      )}

      {(turn.answer || turn.streaming) && (
        <div className="ask-turn__answer">
          <div className="ai-md" onClick={(e) => onCitationClick(e, turn.citations)} dangerouslySetInnerHTML={{ __html: html }} />
          {turn.streaming && <span className="ask-cursor">▌</span>}
        </div>
      )}

      {turn.error && (
        <div className="ask-turn__error" style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span>{turn.error}</span>
          {onRetry && <Button label={t("pages.ask.tryAgain")} variant="secondary" size="sm" onClick={onRetry} />}
        </div>
      )}
      {turn.notice && (
        <div className="ask-turn__notice">
          <span className="ask-notice">{turn.notice}</span>
          {onRetry && turn.stopped && <Button label={t("pages.ask.tryAgain")} variant="secondary" size="sm" onClick={onRetry} />}
        </div>
      )}

      {turn.answer && !turn.streaming && (
        <div className="ask-turn__actions">
          <Button
            label={copied ? t("common.copied") : t("pages.ask.copyAnswer")}
            variant="ghost"
            size="sm"
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            onClick={() => void copyText(answerText(turn.answer)).then(setCopied)}
          />
        </div>
      )}

      <AskSources citations={turn.citations} renumber={renumber} />
    </article>
  );
}

// The scope "" means every document; these action rows cannot collide with `col_` ids.
const NEW_COLLECTION = "__new__";
const MANAGE_COLLECTIONS = "__manage__";

/** Within this many pixels of the bottom, the transcript follows the answer. */
const FOLLOW_SLACK_PX = 80;

/** Where a composer draft waits while the user is off managing Collections. */
const draftKey = (threadId: string | null) => `ask-draft:${threadId ?? "new"}`;


function AskConversation() {
  const { turns, streaming, loading, loadError, retryLoad, scope, setScope, send, retryLast, stop, threadId } = useAsk();
  const chat = useAiChat();
  const nav = useNavigate();
  const [input, setInput] = useState("");
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  // Two steps: a Collection must exist before the membership picker has an id to work with.
  const [naming, setNaming] = useState(false);
  const [filling, setFilling] = useState<CollectionSummary | null>(null);
  const [popover, setPopover] = useState<{
    citation: CitationDetail;
    anchor: { top: number; left: number; anchorTop: number };
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** Whether the transcript is still following the answer. */
  const followRef = useRef(true);
  const [detached, setDetached] = useState(false);

  const loadCollections = useCallback(
    () =>
      Collections.list()
        .then((r) => setCollections(r.collections))
        .catch(() => {}),
    [],
  );
  useEffect(() => void loadCollections(), [loadCollections]);

  useEffect(() => {
    const saved = takeStored("session", draftKey(threadId));
    if (saved) setInput(saved);
  }, [threadId]);

  const jumpToLatest = useCallback(() => {
    followRef.current = true;
    setDetached(false);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, []);

  // Follow the stream only while the reader is at the bottom. An open citation
  // card holds the transcript still, since the card closes on any scroll.
  useEffect(() => {
    if (!followRef.current || popover) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, popover]);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    followRef.current = near;
    setDetached((d) => (d === !near ? d : !near));
  }

  function submit(text?: string) {
    const q = (text ?? input).trim();
    if (!q || streaming) return;
    setInput("");
    followRef.current = true;
    setDetached(false);
    void send(q);
  }

  // Chips live inside the rendered HTML, so their clicks are delegated from the turn.
  function onCitationClick(e: React.MouseEvent, citations: AiCitation[]) {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".citation-ref");
    if (!el) return;
    const raw = Number(el.dataset.citeRaw);
    const display = Number(el.dataset.citeDisplay) || raw;
    const cite = citations.find((c) => c.n === raw);
    if (!cite) return;
    const r = el.getBoundingClientRect();
    // Both edges: the card flips above the chip when there is no room below.
    setPopover({
      citation: { ...cite, n: display },
      anchor: { top: r.bottom + 4, left: r.left + r.width / 2, anchorTop: r.top - 4 },
    });
  }

  /** Opens the picker at once: an empty Collection would answer every question with no sources. */
  async function createCollection(name: string) {
    const c = await Collections.create(name).catch(() => null);
    await loadCollections();
    if (c) setFilling(c);
  }

  const scopeOptions: SelectorOptionType[] = [
    // Not "my documents": retrieval reads every document the viewer may open, a teammate's included.
    { value: "", label: t("pages.ask.scope.all"), icon: <Files size={15} /> },
    ...(collections.length
      ? [
          {
            type: "section" as const,
            title: t("pages.ask.scope.collections"),
            options: collections.map((c) => ({
              value: c.collection_id,
              label: c.name,
              icon: <Library size={15} />,
            })),
          },
        ]
      : []),
    { type: "divider" as const },
    { value: NEW_COLLECTION, label: t("pages.ask.scope.newCollection"), icon: <Plus size={15} /> },
    ...(collections.length
      ? [{ value: MANAGE_COLLECTIONS, label: t("pages.ask.scope.manage"), icon: <Settings2 size={15} /> }]
      : []),
  ];

  /** The action rows run and leave the scope where it was. */
  function onScopeChange(value: string) {
    if (value === NEW_COLLECTION) return setNaming(true);
    if (value === MANAGE_COLLECTIONS) {
      // Leaving the page: park the question for the way back.
      if (input.trim()) writeStored("session", draftKey(threadId), input);
      return nav("/?coll=1");
    }
    setScope(value);
  }

  const scopeName = collections.find((c) => c.collection_id === scope)?.name ?? "";
  const empty = turns.length === 0 && !loading && !loadError;

  return (
    <div className="ask-page">
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div className="ask-page__thread" ref={threadRef} onScroll={onThreadScroll}>
          {empty && (
            <div className="ask-empty">
              <Sparkles size={22} aria-hidden />
              <Text type="display-3" as="h2">
                {t("pages.ask.empty.title")}
              </Text>
              <Text color="secondary" as="p">
                {scopeName ? t("pages.ask.empty.bodyScoped", { name: scopeName }) : t("pages.ask.empty.body")}
              </Text>
              <Text type="supporting" color="secondary" as="p">
                {t("pages.ask.empty.hiddenNote")}
              </Text>
            </div>
          )}
          {loading && turns.length === 0 && (
            <div style={{ display: "flex", justifyContent: "center", padding: "3rem 0" }}>
              <Spinner label={t("pages.ask.loadingThread")} />
            </div>
          )}
          {loadError && (
            <LoadFailed
              title={t("pages.ask.loadFailed")}
              description={t("pages.ask.loadFailedNote")}
              icon={<Sparkles size={28} />}
              onRetry={retryLoad}
            />
          )}
          {turns.map((turn, i) => (
            <AskTurnView
              key={`${threadId ?? "new"}-${i}`}
              turn={turn}
              onCitationClick={onCitationClick}
              onRetry={i === turns.length - 1 && (!!turn.error || !!turn.stopped) && !streaming ? () => void retryLast() : undefined}
            />
          ))}
          <div ref={bottomRef} />
        </div>
        {streaming && detached && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: "0.75rem",
              display: "flex",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <span style={{ pointerEvents: "auto" }}>
              <Button
                label={t("pages.ask.jumpToLatest")}
                variant="secondary"
                size="sm"
                icon={<ArrowDown size={14} />}
                onClick={jumpToLatest}
              />
            </span>
          </div>
        )}
      </div>

      {/* While the node's AI chat is off, the notice stands in for the composer; nothing until the node answers. */}
      {chat === "off" ? (
        <div className="ask-composer">
          <div className="ask-composer__notice">
            <AiSetupNotice />
          </div>
        </div>
      ) : chat === "on" ? (
        <div className="ask-composer">
          <div className="ask-composer__box">
            <TextArea
              label={t("pages.ask.question")}
              isLabelHidden
              rows={2}
              value={input}
              onChange={setInput}
              placeholder={turns.length ? t("pages.ask.placeholderFollowUp") : t("pages.ask.placeholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="ask-composer__foot">
              <Selector
                label={t("pages.ask.scope.label")}
                isLabelHidden
                size="sm"
                variant="ghost"
                // The composer is pinned to the viewport's bottom, where a downward list would clip.
                placement="above"
                value={scope}
                onChange={onScopeChange}
                options={scopeOptions}
                isDisabled={turns.length > 0}
                disabledMessage={t("pages.ask.scope.fixed")}
              />
              <HStack gap={2} vAlign="center">
                <Text type="supporting" color="secondary" as="span" className="ask-composer__hint">
                  {t("pages.ask.hint")}
                </Text>
                {streaming ? (
                  <Button label={t("common.stop")} variant="secondary" size="sm" onClick={stop} />
                ) : (
                  <Button
                    label={t("pages.ask.send")}
                    variant="primary"
                    size="sm"
                    onClick={() => submit()}
                    isDisabled={!input.trim()}
                  />
                )}
              </HStack>
            </div>
          </div>
        </div>
      ) : null}

      <PromptDialog
        isOpen={naming}
        title={t("pages.ask.newCollection.title")}
        label={t("pages.ask.newCollection.label")}
        onSubmit={createCollection}
        onClose={() => setNaming(false)}
      />
      {/* The new Collection becomes the scope only once it has been filled. */}
      {filling && (
        <CollectionEditor
          collectionId={filling.collection_id}
          collectionName={filling.name}
          initialItems={[]}
          onClose={() => setFilling(null)}
          onApplied={() => {
            void loadCollections();
            setScope(filling.collection_id);
          }}
        />
      )}

      {popover && (
        <CitationPopover citation={popover.citation} anchor={popover.anchor} onClose={() => setPopover(null)} />
      )}
    </div>
  );
}

export default function AskPage() {
  const { threadId } = useParams();
  const nav = useNavigate();

  const topNav = <AppTopNav title={t("pages.ask.title")} />;

  return (
    <AskProvider threadId={threadId ?? null} onNavigate={(id) => nav(id ? `/ask/${id}` : "/ask", { replace: !id })}>
      <AppShell topNav={topNav} contentPadding={0} sideNav={<AskThreadList />}>
        <AskConversation />
      </AppShell>
    </AskProvider>
  );
}
