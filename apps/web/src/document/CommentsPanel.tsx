/**
 * The dock's Comments panel, reading the same comments context that paints the
 * editor highlights. The resolved filter and the composer sit outside the
 * scrolling list, so neither scrolls away. A reply can go to the person's own
 * AI co-author, which answers in the thread; how that turn stands shows under
 * the thread, and the dock stays here.
 */
import { useEffect, useRef, useState } from "react";
import { Docs, type Comment, type CommentAgents } from "../api";
import { useComments } from "../comments/comments-context";
import { useOptionalAiCoauthor, type ThreadTurn } from "../ai/ai-coauthor-context";
import { t, type MessageKey } from "../i18n/i18n";
import { tRich } from "../i18n/rich";
import { absoluteTime, importedAuthor, principalHuman, relativeTime } from "../lib/format";
import { getAlias } from "../lib/http/client";
import { isComposingKey } from "../lib/ime";
import { authorLabel, nameLoading, principalLabel, useUserNames } from "../state/identity";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { ChevronRight, MessageSquareText, Trash2 } from "lucide-react";
import { CommentText } from "../mentions/CommentText";
import { MentionTextArea } from "../mentions/MentionTextArea";

export function CommentsPanel({
  docId,
  canAskAi = false,
}: {
  docId: string;
  /** This page's co-author can take a turn: the person can write here. */
  canAskAi?: boolean;
}) {
  const { comments, agents, canManage, activeNum, clickComment, resolve, del, reply, reload } = useComments();
  const coauthor = useOptionalAiCoauthor();
  // Send to AI is offered only where the co-author can answer.
  const ai = canAskAi && coauthor?.available ? coauthor : null;
  const [draft, setDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  // Deleting a thread's root deletes its replies, which the confirmation says.
  const [deleting, setDeleting] = useState<{ num: number; isRoot: boolean; replies: number } | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  // A click in the editor can activate a resolved thread, which must be unhidden before it is scrolled to.
  const activeComment = activeNum === null ? null : comments.find((c) => c.num === activeNum);
  const activeRootNum = activeComment ? (activeComment.parent_num ?? activeComment.num) : null;
  const activeIsResolved = !!comments.find((c) => c.num === activeRootNum)?.resolved;
  useEffect(() => {
    if (activeIsResolved) setShowResolved(true);
  }, [activeRootNum, activeIsResolved]);

  async function addGeneralComment() {
    const body = draft.trim();
    if (!body) return;
    await Docs.addComment(docId, body);
    setDraft("");
    void reload();
  }

  // Threads: roots with their replies in order. A resolved root hides its whole thread.
  const repliesByRoot = new Map<number, Comment[]>();
  for (const c of comments) {
    if (c.parent_num === null) continue;
    const list = repliesByRoot.get(c.parent_num) ?? [];
    list.push(c);
    repliesByRoot.set(c.parent_num, list);
  }
  for (const list of repliesByRoot.values()) list.sort((a, b) => a.num - b.num);
  const roots = comments
    .filter((c) => c.parent_num === null)
    .filter((c) => showResolved || !c.resolved)
    .sort((a, b) => a.num - b.num);
  const resolvedCount = comments.filter((c) => c.parent_num === null && c.resolved).length;

  // Runs on the row count too, for a thread just unhidden.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeRootNum, roots.length]);

  // A co-author's or an agent's comment is named with its person, whose name is looked up.
  useUserNames(comments.flatMap((c) => nameSource(c.author, agents) ?? []));

  // A thread turn reads as working until its answer is in the list; then it is done with. A turn
  // whose connection dropped may still have answered: any later reply by the co-author in the thread.
  const threadTurns = coauthor?.threadTurns;
  const clearThread = coauthor?.clearThread;
  const posted = new Set(comments.map((c) => c.num));
  const me = getAlias();
  const answerShows = (num: number, turn: ThreadTurn): boolean =>
    turn.replied !== undefined
      ? posted.has(turn.replied)
      : turn.state === "dropped" && me !== null && comments.some((c) => c.parent_num === num && c.author === `panel:${me}` && c.num > turn.replyNum);
  const answered = threadTurns ? [...threadTurns].filter(([num, turn]) => answerShows(num, turn)) : [];
  const answeredKey = answered.map(([num, turn]) => `${num}:${turn.replyNum}`).join(",");
  useEffect(() => {
    for (const [num, turn] of answered) clearThread?.(num, turn.replyNum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answeredKey, clearThread]);
  const aiTurnOf = (num: number): ThreadTurn | undefined => {
    const turn = threadTurns?.get(num);
    return turn && !answered.some(([n]) => n === num) ? turn : undefined;
  };

  return (
    <>
      {resolvedCount > 0 && (
        <div className="comment-toolbar">
          <button
            type="button"
            className={`resolved-toggle${showResolved ? " is-on" : ""}`}
            aria-expanded={showResolved}
            onClick={() => setShowResolved((s) => !s)}
          >
            <ChevronRight size={13} className="resolved-toggle__caret" aria-hidden="true" />
            {showResolved
              ? t("document.comments.hideResolved", { count: resolvedCount })
              : t("document.comments.showResolved", { count: resolvedCount })}
          </button>
        </div>
      )}

      <div className="side-body">
        {roots.length > 0 ? (
          <ul className="comment-list">
            {roots.map((c) => (
              <CommentThread
                key={c.num}
                ref={c.num === activeRootNum ? activeRef : undefined}
                root={c}
                replies={repliesByRoot.get(c.num) ?? []}
                agents={agents}
                canManage={canManage}
                active={c.num === activeNum}
                onJump={() => clickComment(c.num)}
                onResolve={() => resolve(c.num, !c.resolved)}
                onDelete={(num) =>
                  setDeleting({ num, isRoot: num === c.num, replies: repliesByRoot.get(c.num)?.length ?? 0 })
                }
                onReply={async (body, toAi) => {
                  const saved = await reply(c.num, body);
                  if (saved && toAi) ai?.answerInThread(c.num, saved.num, body, c.anchor_quote);
                  return saved !== null;
                }}
                canAskAi={ai !== null}
                aiTurn={aiTurnOf(c.num)}
                onShowAi={() => coauthor?.showPanel()}
                onRetryAi={() => coauthor?.retryThread(c.num)}
              />
            ))}
          </ul>
        ) : (
          <div className="comment-empty">
            <EmptyState
              isCompact
              icon={<MessageSquareText size={22} aria-hidden="true" />}
              title={resolvedCount > 0 ? t("document.comments.noOpen") : t("document.comments.none")}
              description={resolvedCount > 0 ? t("document.comments.noOpenNote") : t("document.comments.noneNote")}
            />
          </div>
        )}
      </div>

      <div className="comment-add">
        <MentionTextArea
          label={t("document.comments.general")}
          isLabelHidden
          placement="above"
          value={draft}
          onChange={setDraft}
          rows={2}
          placeholder={t("document.comments.generalPlaceholder")}
        />
        <Button label={t("common.comment")} variant="primary" size="sm" onClick={addGeneralComment} isDisabled={!draft.trim()} />
      </div>

      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleteCopy(deleting).title}
        description={deleteCopy(deleting).description}
        actionLabel={t("common.delete")}
        onAction={() => {
          if (deleting) del(deleting.num);
          setDeleting(null);
        }}
      />
    </>
  );
}

/** Called with null while the dialog animates out, so it always answers. */
function deleteCopy(target: { isRoot: boolean; replies: number } | null): { title: string; description: string } {
  if (target && !target.isRoot) {
    return { title: t("document.comments.deleteReplyTitle"), description: t("document.comments.deleteReplyBody") };
  }
  if (target && target.replies > 0) {
    return {
      title: t("document.comments.deleteThreadTitle", { count: target.replies }),
      description: t("document.comments.deleteThreadBody"),
    };
  }
  return { title: t("document.comments.deleteCommentTitle"), description: t("document.comments.deleteCommentBody") };
}

/**
 * The principal whose name heads an author's comments: a co-author's or an agent's person, else the
 * author; null for an agent whose person the node cannot say, which is named with no lookup.
 */
function nameSource(author: string, agents: CommentAgents): string | null {
  const person = Object.hasOwn(agents, author) ? (agents[author] ?? null) : (principalHuman(author) ?? author);
  return person === null ? null : `user:${person}`;
}

/**
 * A blank while the name loads, rather than the raw alias, so the heading keeps its height. An
 * imported author's name and a co-author's or an agent's person are isolated, so no direction mark
 * in them can reorder the words around them. An agent is named by its person, never by a name it chose.
 */
function AuthorName({ author, agents }: { author: string; agents: CommentAgents }) {
  const source = nameSource(author, agents);
  if (source !== null && nameLoading(source)) return "\u00a0";
  const bdi = (chunks: React.ReactNode[]) => <bdi>{chunks}</bdi>;
  if (Object.hasOwn(agents, author)) {
    return source === null ? t("ui.author.agent") : tRich("ui.author.agentOf", { name: principalLabel(source), bdi });
  }
  const person = principalHuman(author);
  if (person !== null) return tRich("ui.author.coauthor", { name: authorLabel(person), bdi });
  const imported = importedAuthor(author);
  if (imported === null) return authorLabel(author);
  return tRich("document.comments.importedAuthor", { name: imported, bdi });
}

/**
 * The alias behind the name, which tells two of one name apart: a co-author's person's, an agent's
 * own id; none for an imported author, whose name is all there is.
 */
function authorTitle(author: string): string | undefined {
  if (importedAuthor(author) !== null) return undefined;
  return principalHuman(author) ?? author;
}

/**
 * Whether the reader may resolve or delete a comment, as the node decides: they or their co-author
 * wrote it, or they manage the document.
 */
function mayChange(author: string, me: string | null, canManage: boolean): boolean {
  return canManage || (me !== null && (author === me || author === `panel:${me}`));
}

const AI_TURN_WORDS: Record<ThreadTurn["state"], MessageKey> = {
  queued: "document.comments.aiQueued",
  working: "ai.status.working",
  failed: "document.comments.aiFailed",
  dropped: "document.comments.aiDropped",
};

/** The words of a thread turn's line, which the thread's live region speaks too. */
function aiTurnWords(turn: ThreadTurn): string {
  return turn.message ?? t(AI_TURN_WORDS[turn.state]);
}

/**
 * How a reply sent to the AI stands, quietly under its thread; nothing once the answer is in. The
 * thread's live region speaks it, so this line isn't one.
 */
function AiThreadStatus({ turn, onShow, onRetry }: { turn: ThreadTurn; onShow: () => void; onRetry: () => void }) {
  if (turn.state === "working") {
    // Its transcript and Stop are in the AI tab.
    return (
      <HStack className="comment-ai-status">
        <Button label={t("ai.status.working")} variant="ghost" size="sm" icon={<span className="ai-activity__dot" aria-hidden="true" />} onClick={onShow} />
      </HStack>
    );
  }
  return (
    <HStack className="comment-ai-status" gap={2} vAlign="center" wrap="wrap">
      <Text type="supporting" color="secondary">
        {aiTurnWords(turn)}
      </Text>
      {turn.retry && <Button label={t("common.retry")} variant="ghost" size="sm" onClick={onRetry} />}
    </HStack>
  );
}

/** When a comment was written, beside its author; the exact time on hover. */
function CommentTime({ at }: { at: string }) {
  return (
    <time className="comment-time" dateTime={at} title={absoluteTime(at)}>
      {relativeTime(at)}
    </time>
  );
}

/** Delete, apart from Resolve and quieter than it: an icon that names itself on hover. */
function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <IconButton label={label} tooltip={label} variant="ghost" size="sm" icon={<Trash2 size={14} aria-hidden="true" />} onClick={onClick} />;
}

/** A root comment, its replies, and a reply box. */
function CommentThread({
  ref,
  root,
  replies,
  agents,
  canManage,
  active,
  onJump,
  onResolve,
  onDelete,
  onReply,
  canAskAi,
  aiTurn,
  onShowAi,
  onRetryAi,
}: {
  ref?: React.Ref<HTMLLIElement>;
  root: Comment;
  replies: Comment[];
  agents: CommentAgents;
  /** The reader manages the document: Resolve and Delete on every comment. */
  canManage: boolean;
  active: boolean;
  onJump: () => void;
  onResolve: () => void;
  onDelete: (num: number) => void;
  /** Resolves true once the reply is saved; `toAi` also sends it to the co-author. */
  onReply: (body: string, toAi: boolean) => Promise<boolean>;
  /** Offer Send to AI. */
  canAskAi: boolean;
  aiTurn: ThreadTurn | undefined;
  onShowAi: () => void;
  onRetryAi: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  // Ticked by default when the person's own co-author spoke last: the reply most likely answers it.
  // The default is taken when the draft starts and kept until it is sent or emptied, so a comment
  // landing mid-draft can't change where the reply goes.
  const me = getAlias();
  const latest = replies.at(-1) ?? root;
  const liveDefault = me !== null && latest.author === `panel:${me}`;
  const [draftDefault, setDraftDefault] = useState<boolean | null>(null);
  const [toAiChoice, setToAiChoice] = useState<boolean | null>(null);
  const toAi = canAskAi && (toAiChoice ?? draftDefault ?? liveDefault);

  function changeDraft(next: string) {
    if (next === "") setDraftDefault(null);
    else if (draft === "") setDraftDefault(liveDefault);
    setDraft(next);
  }

  async function submitReply() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await onReply(body, toAi);
    setBusy(false);
    if (ok) {
      setDraft("");
      setDraftDefault(null);
      setToAiChoice(null);
    }
  }

  return (
    <li ref={ref} className={`comment-item${active ? " active" : ""}${root.resolved ? " resolved" : ""}`}>
      {root.anchor_quote && (
        <button className="comment-quote" dir="auto" title={t("document.comments.jumpToQuote")} onClick={onJump}>
          “{root.anchor_quote}”
        </button>
      )}
      <div className="comment-head">
        <span className="comment-byline">
          <strong title={authorTitle(root.author)}>
            <AuthorName author={root.author} agents={agents} />
          </strong>
          <CommentTime at={root.created_at} />
        </span>
        {mayChange(root.author, me, canManage) && (
          <span className="comment-actions">
            <Button label={root.resolved ? t("document.comments.reopen") : t("document.comments.resolve")} variant="ghost" size="sm" onClick={onResolve} />
            <DeleteButton label={t("document.comments.deleteComment")} onClick={() => onDelete(root.num)} />
          </span>
        )}
      </div>
      <CommentText body={root.body} mentions={root.mentions} />

      {replies.length > 0 && (
        <ul className="comment-replies">
          {replies.map((r) => (
            <li key={r.num} className="comment-reply">
              <div className="comment-head">
                <span className="comment-byline">
                  <strong title={authorTitle(r.author)}>
                    <AuthorName author={r.author} agents={agents} />
                  </strong>
                  <CommentTime at={r.created_at} />
                </span>
                {mayChange(r.author, me, canManage) && (
                  <span className="comment-actions">
                    <DeleteButton label={t("document.comments.deleteReply")} onClick={() => onDelete(r.num)} />
                  </span>
                )}
              </div>
              <CommentText body={r.body} mentions={r.mentions} />
            </li>
          ))}
        </ul>
      )}

      {/* Mounted before there is anything to say, so the first state is announced too. */}
      {canAskAi && (
        <VisuallyHidden as="div" role="status">
          {aiTurn ? aiTurnWords(aiTurn) : ""}
        </VisuallyHidden>
      )}
      {aiTurn && <AiThreadStatus turn={aiTurn} onShow={onShowAi} onRetry={onRetryAi} />}

      {/* Reopen a resolved thread to reply to it. Its actions show while the box is in use. */}
      {!root.resolved && (
        <div
          className="comment-reply-box"
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          <MentionTextArea
            label={t("document.comments.reply")}
            isLabelHidden
            value={draft}
            placeholder={t("document.comments.replyPlaceholder")}
            rows={1}
            onChange={changeDraft}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e)) {
                e.preventDefault();
                void submitReply();
              }
            }}
          />
          {(focused || draft !== "") && (
            <HStack
              gap={2}
              vAlign="center"
              hAlign={canAskAi ? "between" : "end"}
              // Keeps the box focused: a browser that doesn't focus a clicked checkbox would
              // otherwise blur it, hiding this row before the click lands.
              onMouseDown={(e) => e.preventDefault()}
            >
              {canAskAi && <CheckboxInput size="sm" label={t("document.comments.sendToAi")} value={toAi} onChange={(v) => setToAiChoice(v)} />}
              <Button label={t("document.comments.reply")} variant="secondary" size="sm" onClick={() => void submitReply()} isDisabled={!draft.trim() || busy} />
            </HStack>
          )}
        </div>
      )}
    </li>
  );
}
