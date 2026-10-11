/**
 * The dock's Comments panel, reading the same comments context that paints the
 * editor highlights. The resolved filter and the composer sit outside the
 * scrolling list, so neither scrolls away.
 */
import { useEffect, useRef, useState } from "react";
import { Docs, type Comment } from "../api";
import { useComments } from "../comments/comments-context";
import { t } from "../i18n/i18n";
import { tRich } from "../i18n/rich";
import { absoluteTime, importedAuthor, relativeTime } from "../lib/format";
import { isComposingKey } from "../lib/ime";
import { authorLabel, nameLoading, useUserNames } from "../state/identity";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { ChevronRight, MessageSquareText, Trash2 } from "lucide-react";
import { CommentText } from "../mentions/CommentText";
import { MentionTextArea } from "../mentions/MentionTextArea";

export function CommentsPanel({ docId }: { docId: string }) {
  const { comments, activeNum, clickComment, resolve, del, reply, reload } = useComments();
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

  useUserNames(comments.map((c) => `user:${c.author}`));

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
                active={c.num === activeNum}
                onJump={() => clickComment(c.num)}
                onResolve={() => resolve(c.num, !c.resolved)}
                onDelete={(num) =>
                  setDeleting({ num, isRoot: num === c.num, replies: repliesByRoot.get(c.num)?.length ?? 0 })
                }
                onReply={(body) => reply(c.num, body)}
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
 * A blank while the name loads, rather than the raw alias, so the heading keeps its height. An
 * imported author's name is isolated, so no direction mark in it can reorder the marker after it.
 */
function AuthorName({ author }: { author: string }) {
  if (nameLoading(`user:${author}`)) return "\u00a0";
  const imported = importedAuthor(author);
  if (imported === null) return authorLabel(author);
  return tRich("document.comments.importedAuthor", { name: imported, bdi: (chunks) => <bdi>{chunks}</bdi> });
}

/** The alias behind the name, which tells two of one name apart; none for an imported author, whose name is all there is. */
function authorTitle(author: string): string | undefined {
  return importedAuthor(author) === null ? author : undefined;
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
  active,
  onJump,
  onResolve,
  onDelete,
  onReply,
}: {
  ref?: React.Ref<HTMLLIElement>;
  root: Comment;
  replies: Comment[];
  active: boolean;
  onJump: () => void;
  onResolve: () => void;
  onDelete: (num: number) => void;
  onReply: (body: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitReply() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await onReply(body);
    setBusy(false);
    if (ok) setDraft("");
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
            <AuthorName author={root.author} />
          </strong>
          <CommentTime at={root.created_at} />
        </span>
        <span className="comment-actions">
          <Button label={root.resolved ? t("document.comments.reopen") : t("document.comments.resolve")} variant="ghost" size="sm" onClick={onResolve} />
          <DeleteButton label={t("document.comments.deleteComment")} onClick={() => onDelete(root.num)} />
        </span>
      </div>
      <CommentText body={root.body} mentions={root.mentions} />

      {replies.length > 0 && (
        <ul className="comment-replies">
          {replies.map((r) => (
            <li key={r.num} className="comment-reply">
              <div className="comment-head">
                <span className="comment-byline">
                  <strong title={authorTitle(r.author)}>
                    <AuthorName author={r.author} />
                  </strong>
                  <CommentTime at={r.created_at} />
                </span>
                <span className="comment-actions">
                  <DeleteButton label={t("document.comments.deleteReply")} onClick={() => onDelete(r.num)} />
                </span>
              </div>
              <CommentText body={r.body} mentions={r.mentions} />
            </li>
          ))}
        </ul>
      )}

      {/* Reopen a resolved thread to reply to it. */}
      {!root.resolved && (
        <div className="comment-reply-box">
          <MentionTextArea
            label={t("document.comments.reply")}
            isLabelHidden
            value={draft}
            placeholder={t("document.comments.replyPlaceholder")}
            rows={1}
            onChange={setDraft}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e)) {
                e.preventDefault();
                void submitReply();
              }
            }}
          />
          <Button label={t("document.comments.reply")} variant="secondary" size="sm" onClick={() => void submitReply()} isDisabled={!draft.trim() || busy} />
        </div>
      )}
    </li>
  );
}
