import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Text } from "@astryxdesign/core/Text";
import { FileText, Files, Zap } from "lucide-react";
import type { AiCitation, AiCrossDocProposal } from "@stuga/protocol/wire/doc-socket";
import { renderAssistantHtml } from "./render-markdown";
import { useCitationPopover } from "./CitationPopover";
import { t } from "../i18n/i18n";
import { crossDocErrorText } from "./turn-text";

export interface ChatTurn {
  role: "user" | "assistant";
  /** What the model receives as this turn, in history too. */
  text: string;
  /** User turns: what the transcript shows instead of `text`, which is then English written for the model. */
  shown?: string;
  /** User turns: the passage the turn was scoped to. */
  quote?: string;
  /** User turns: images sent with the message. */
  images?: { url: string; name: string }[];
  /** Assistant turns: what the agent is doing while it has no prose yet, worded. */
  status?: string;
  /** Assistant turns: cited documents, one per document. */
  sources?: { doc_id: string; title: string }[];
  /** Assistant turns: the citations behind the `[n]` markers in the prose. */
  citations?: AiCitation[];
  /** Assistant turns: how many changes the turn proposed on the item on screen. */
  staged?: number;
  /** Assistant turns: how many changes the turn applied at once on the item on screen. */
  applied?: number;
  /** Assistant turns: proposals raised in other documents. */
  crossDocs?: AiCrossDocProposal[];
  /** Assistant turns: the reply finished but its edits could not be proposed, worded. */
  proposeError?: string;
  /** Assistant turns: the turn ended early; anything it made is kept. Worded. */
  notice?: string;
}

/** Where a turn's proposed changes are reviewed: in the document, or in the banner above a database grid. */
export type ReviewPlace = "document" | "grid";

/** Distance from the bottom within which new content keeps the thread scrolled to the end. */
const FOLLOW_PX = 48;

export function ChatTranscript({
  turns,
  streaming,
  empty,
  reviewIn = "document",
}: {
  turns: ChatTurn[];
  streaming: boolean;
  /** Shown while the thread is empty. */
  empty: ReactNode;
  /** Where proposed changes are reviewed. */
  reviewIn?: ReviewPlace;
}) {
  const nav = useNavigate();
  const { onChipClick, popover } = useCitationPopover();
  const threadRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // The panel re-renders on every editor tick; markdown is parsed only when the turns change.
  const rendered = useMemo(
    () => turns.map((turn) => (turn.role === "assistant" && turn.text ? renderAssistantHtml(turn.text, turn.citations) : null)),
    [turns],
  );

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  return (
    <div
      ref={threadRef}
      className="ai-thread"
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
      }}
    >
      {turns.length === 0 && (
        <Text type="supporting" color="secondary">
          {empty}
        </Text>
      )}
      {turns.map((turn, i) => (
        <div key={i} className={`ai-turn ai-turn-${turn.role}`}>
          {turn.quote && (
            <div className="ai-turn-quote" dir="auto" title={turn.quote}>
              {turn.quote}
            </div>
          )}
          {turn.images && turn.images.length > 0 && (
            <div className="ai-turn-images">
              {turn.images.map((img) => (
                <img key={img.url} className="ai-attachment__thumb" src={img.url} alt={img.name} title={img.name} />
              ))}
            </div>
          )}
          {turn.role === "user" ? (
            (turn.shown ?? turn.text)
          ) : turn.text ? (
            <div
              className="ai-md"
              onClick={(e) => onChipClick(e, turn.citations)}
              dangerouslySetInnerHTML={{ __html: rendered[i] ?? "" }}
            />
          ) : streaming && i === turns.length - 1 ? (
            <div className="ai-activity">
              <span className="ai-activity__dot" />
              <span className="ai-activity__label">{turn.status || t("ai.status.working")}</span>
            </div>
          ) : null}
          {turn.sources && turn.sources.length > 0 && (
            <div className="ai-sources">
              <span className="ai-sources-label">{t("ai.transcript.sources")}</span>
              {turn.sources.map((s) => (
                <button key={s.doc_id} className="ai-source" title={t("ai.transcript.openDoc", { title: s.title || t("common.untitled") })} onClick={() => nav(`/doc/${s.doc_id}`)}>
                  <FileText size={12} />
                  <span className="ai-source__title">{s.title || t("common.untitled")}</span>
                </button>
              ))}
            </div>
          )}
          {turn.staged !== undefined && turn.staged > 0 && (
            <div className="ai-staged">
              <Zap size={13} aria-hidden />
              <Text type="supporting" color="secondary">
                {reviewIn === "grid"
                  ? t("ai.transcript.stagedInGrid", { count: turn.staged })
                  : t("ai.transcript.stagedInDocument", { count: turn.staged })}
              </Text>
            </div>
          )}
          {turn.applied !== undefined && turn.applied > 0 && (
            <div className="ai-staged">
              <Zap size={13} aria-hidden />
              <Text type="supporting" color="secondary">
                {t("ai.transcript.applied", { count: turn.applied })}
              </Text>
            </div>
          )}
          {turn.crossDocs?.map((d) =>
            d.mode === "error" ? (
              <div key={d.doc_id} className="ai-staged ai-staged--error">
                <Text type="supporting" color="secondary">
                  {crossDocErrorText(d.error, d.title || t("common.untitled"))}
                </Text>
              </div>
            ) : (
              <button
                key={d.doc_id}
                className="ai-staged ai-staged--crossdoc"
                title={
                  d.mode === "applied"
                    ? t("ai.transcript.openDoc", { title: d.title || t("common.untitled") })
                    : t("ai.transcript.openDocToReview", { title: d.title || t("common.untitled") })
                }
                onClick={() => nav(`/doc/${d.doc_id}`)}
              >
                <Files size={13} aria-hidden />
                <Text type="supporting" color="secondary">
                  {d.mode === "applied"
                    ? t("ai.transcript.crossDocApplied", { count: d.staged, title: d.title || t("common.untitled") })
                    : t("ai.transcript.crossDocProposed", { count: d.staged, title: d.title || t("common.untitled") })}
                </Text>
              </button>
            ),
          )}
          {turn.proposeError && (
            <div className="ai-staged ai-staged--error">
              <Text type="supporting" color="secondary">
                {turn.proposeError}
              </Text>
            </div>
          )}
          {/* Not the error style: whatever the turn proposed before it stopped is real. */}
          {turn.notice && (
            <div className="ai-staged">
              <Text type="supporting" color="secondary">
                {turn.notice}
              </Text>
            </div>
          )}
        </div>
      ))}
      {popover}
    </div>
  );
}
