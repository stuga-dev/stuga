import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Text } from "@astryxdesign/core/Text";
import { FileText, Files, Zap } from "lucide-react";
import type { AiCitation, AiCrossDocProposal } from "@stuga/protocol/wire/doc-socket";
import { renderAssistantHtml } from "./render-markdown";
import { useCitationPopover } from "./CitationPopover";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  /** User turns: the passage the turn was scoped to. */
  quote?: string;
  /** User turns: images sent with the message. */
  images?: { url: string; name: string }[];
  /** Assistant turns: what the agent is doing while it has no prose yet. */
  status?: string;
  /** Assistant turns: cited documents, one per document. */
  sources?: { doc_id: string; title: string }[];
  /** Assistant turns: the citations behind the `[n]` markers in the prose. */
  citations?: AiCitation[];
  /** Assistant turns: how many changes the turn proposed on the item on screen. */
  staged?: number;
  /** Assistant turns: proposals raised in other documents. */
  crossDocs?: AiCrossDocProposal[];
  /** Assistant turns: the reply finished but its edits could not be proposed. */
  proposeError?: string;
  /** Assistant turns: the turn ended early; anything it proposed is still reviewable. */
  notice?: string;
}

/** Distance from the bottom within which new content keeps the thread scrolled to the end. */
const FOLLOW_PX = 48;

export function ChatTranscript({
  turns,
  streaming,
  empty,
  reviewWhere,
}: {
  turns: ChatTurn[];
  streaming: boolean;
  /** Shown while the thread is empty. */
  empty: ReactNode;
  /** Where proposed changes are reviewed, e.g. "in the document". */
  reviewWhere: string;
}) {
  const nav = useNavigate();
  const { onChipClick, popover } = useCitationPopover();
  const threadRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // The panel re-renders on every editor tick; markdown is parsed only when the turns change.
  const rendered = useMemo(
    () => turns.map((t) => (t.role === "assistant" && t.text ? renderAssistantHtml(t.text, t.citations) : null)),
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
      {turns.map((t, i) => (
        <div key={i} className={`ai-turn ai-turn-${t.role}`}>
          {t.quote && (
            <div className="ai-turn-quote" dir="auto" title={t.quote}>
              {t.quote}
            </div>
          )}
          {t.images && t.images.length > 0 && (
            <div className="ai-turn-images">
              {t.images.map((img) => (
                <img key={img.url} className="ai-attachment__thumb" src={img.url} alt={img.name} title={img.name} />
              ))}
            </div>
          )}
          {t.role === "user" ? (
            t.text
          ) : t.text ? (
            <div
              className="ai-md"
              onClick={(e) => onChipClick(e, t.citations)}
              dangerouslySetInnerHTML={{ __html: rendered[i] ?? "" }}
            />
          ) : streaming && i === turns.length - 1 ? (
            <div className="ai-activity">
              <span className="ai-activity__dot" />
              <span className="ai-activity__label">{t.status || "Working…"}</span>
            </div>
          ) : null}
          {t.sources && t.sources.length > 0 && (
            <div className="ai-sources">
              <span className="ai-sources-label">Sources</span>
              {t.sources.map((s) => (
                <button key={s.doc_id} className="ai-source" title={`Open “${s.title}”`} onClick={() => nav(`/doc/${s.doc_id}`)}>
                  <FileText size={12} />
                  <span className="ai-source__title">{s.title || "Untitled"}</span>
                </button>
              ))}
            </div>
          )}
          {t.staged !== undefined && t.staged > 0 && (
            <div className="ai-staged">
              <Zap size={13} aria-hidden />
              <Text type="supporting" color="secondary">
                Proposed {t.staged} change{t.staged === 1 ? "" : "s"} — review {t.staged === 1 ? "it" : "them"} {reviewWhere}.
              </Text>
            </div>
          )}
          {t.crossDocs?.map((d) =>
            d.mode === "error" ? (
              <div key={d.doc_id} className="ai-staged ai-staged--error">
                <Text type="supporting" color="secondary">
                  Couldn’t propose changes in “{d.title || "Untitled"}”{d.message ? ` — ${d.message}` : "."}
                </Text>
              </div>
            ) : (
              <button
                key={d.doc_id}
                className="ai-staged ai-staged--crossdoc"
                title={`Open “${d.title || "Untitled"}” to review`}
                onClick={() => nav(`/doc/${d.doc_id}`)}
              >
                <Files size={13} aria-hidden />
                <Text type="supporting" color="secondary">
                  Proposed {d.staged} change{d.staged === 1 ? "" : "s"} in “{d.title || "Untitled"}” — open it to review.
                </Text>
              </button>
            ),
          )}
          {t.proposeError && (
            <div className="ai-staged ai-staged--error">
              <Text type="supporting" color="secondary">
                {t.proposeError}
              </Text>
            </div>
          )}
          {/* Not the error style: whatever the turn proposed before it stopped is real. */}
          {t.notice && (
            <div className="ai-staged">
              <Text type="supporting" color="secondary">
                {t.notice}
              </Text>
            </div>
          )}
        </div>
      ))}
      {popover}
    </div>
  );
}
