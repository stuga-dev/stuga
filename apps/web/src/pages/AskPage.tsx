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
import type { CitationDetail } from "../ai/citations";
import { AskThreadList } from "../ai/ask/AskThreadList";
import { CollectionEditor } from "../library/CollectionEditor";
import { PromptDialog } from "../ui/PromptDialog";
import { AskTrace } from "../ai/ask/AskTrace";
import { AskSources } from "../ai/ask/AskSources";
import { AccountMenu } from "../shell/AccountMenu";
import { NotificationsBell } from "../shell/NotificationsBell";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector, type SelectorOptionType } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowDown, ArrowLeft, Files, Library, Plus, Settings2, Sparkles } from "lucide-react";
import { LoadFailed } from "../ui/LoadFailed";
import { Brand } from "../shell/Brand";
import { takeStored, writeStored } from "../lib/storage";
import { useAiChat } from "../state/model-options";
import { AiSetupNotice } from "../ai/AiSetupNotice";
import "../styles/ask.css";

function AskTurnView({
  turn,
  onCitationClick,
  onRetry,
}: {
  turn: AskUiTurn;
  onCitationClick: (e: React.MouseEvent, citations: AiCitation[]) => void;
  /** Only the last turn: retrying replaces it. */
  onRetry?: () => void;
}) {
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
          {onRetry && <Button label="Try again" variant="secondary" size="sm" onClick={onRetry} />}
        </div>
      )}
      {turn.notice && <div className="ask-notice">{turn.notice}</div>}

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
    { value: "", label: "All documents in this workspace", icon: <Files size={15} /> },
    ...(collections.length
      ? [
          {
            type: "section" as const,
            title: "Collections",
            options: collections.map((c) => ({
              value: c.collection_id,
              label: c.name,
              icon: <Library size={15} />,
            })),
          },
        ]
      : []),
    { type: "divider" as const },
    { value: NEW_COLLECTION, label: "New collection…", icon: <Plus size={15} /> },
    ...(collections.length
      ? [{ value: MANAGE_COLLECTIONS, label: "Manage collections…", icon: <Settings2 size={15} /> }]
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
              <Text type="display-3" as="h1">
                Ask your documents
              </Text>
              <Text color="secondary" as="p">
                {scopeName
                  ? `Ask about the documents in “${scopeName}”. Answers can link back to the documents they use.`
                  : "Ask a question about your documents. Answers can link back to the documents they use."}
              </Text>
              <Text type="supporting" color="secondary" as="p">
                Documents hidden from search aren’t included.
              </Text>
            </div>
          )}
          {loading && turns.length === 0 && (
            <div style={{ display: "flex", justifyContent: "center", padding: "3rem 0" }}>
              <Spinner label="Loading this conversation…" />
            </div>
          )}
          {loadError && (
            <LoadFailed
              title="Couldn’t load this conversation"
                description="Your answers are still saved."
              icon={<Sparkles size={28} />}
              onRetry={retryLoad}
            />
          )}
          {turns.map((t, i) => (
            <AskTurnView
              key={`${threadId ?? "new"}-${i}`}
              turn={t}
              onCitationClick={onCitationClick}
              onRetry={i === turns.length - 1 && !!t.error && !streaming ? () => void retryLast() : undefined}
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
                label="Jump to latest"
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
              label="Question"
              isLabelHidden
              rows={2}
              value={input}
              onChange={setInput}
              placeholder={turns.length ? "Ask a follow-up…" : "Ask a question across your documents…"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="ask-composer__foot">
              <Selector
                label="Search scope"
                isLabelHidden
                size="sm"
                variant="ghost"
                // The composer is pinned to the viewport's bottom, where a downward list would clip.
                placement="above"
                value={scope}
                onChange={onScopeChange}
                options={scopeOptions}
                isDisabled={turns.length > 0}
                disabledMessage="Scope is fixed for this conversation. Start a new one to change it."
              />
              <HStack gap={2} vAlign="center">
                <Text type="supporting" color="secondary" as="span" className="ask-composer__hint">
                  Enter to send, Shift + Enter for a new line
                </Text>
                {streaming ? (
                  <Button label="Stop" variant="secondary" size="sm" onClick={stop} />
                ) : (
                  <Button
                    label="Ask"
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
        title="New collection"
        label="Collection name"
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

  const topNav = (
    <TopNav
      label="Ask"
      startContent={
        <HStack gap={2} vAlign="center">
          <IconButton label="All documents" variant="ghost" icon={<ArrowLeft size={18} />} onClick={() => nav("/")} />
          <div className="brand">
            <Brand />
            <Heading level={1}>Ask your documents</Heading>
          </div>
        </HStack>
      }
      endContent={
        <HStack gap={1} vAlign="center">
          <NotificationsBell />
          <AccountMenu />
        </HStack>
      }
    />
  );

  return (
    <AskProvider threadId={threadId ?? null} onNavigate={(id) => nav(id ? `/ask/${id}` : "/ask", { replace: !id })}>
      <AppShell topNav={topNav} contentPadding={0} sideNav={<AskThreadList />}>
        <AskConversation />
      </AppShell>
    </AskProvider>
  );
}
