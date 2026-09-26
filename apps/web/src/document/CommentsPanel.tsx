/**
 * The dock's Comments panel, reading the same comments context that paints the
 * editor highlights. The resolved filter and the composer sit outside the
 * scrolling list, so neither scrolls away.
 */
import { useEffect, useRef, useState } from "react";
import { Docs, type Comment } from "../api";
import { useComments } from "../comments/comments-context";
import { importedAuthor } from "../lib/format";
import { authorLabel, nameLoading, useUserNames } from "../state/identity";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { ChevronRight, MessageSquareText } from "lucide-react";
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
    reload();
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
            {showResolved ? "Hide" : "Show"} {resolvedCount} resolved
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
              title={resolvedCount > 0 ? "No open comments" : "No comments yet"}
              description={
                resolvedCount > 0
                  ? "Every thread on this document has been resolved."
                  : "Select text in the document to comment on it."
              }
            />
          </div>
        )}
      </div>

      <div className="comment-add">
        <MentionTextArea
          label="Add a general comment"
          isLabelHidden
          placement="above"
          value={draft}
          onChange={setDraft}
          rows={2}
          placeholder="Add a general comment… Type @ to mention someone"
        />
        <Button label="Comment" variant="primary" size="sm" onClick={addGeneralComment} isDisabled={!draft.trim()} />
      </div>

      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleteCopy(deleting).title}
        description={deleteCopy(deleting).description}
        actionLabel="Delete"
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
    return { title: "Delete this reply?", description: "The reply is removed for everyone. This can’t be undone." };
  }
  if (target && target.replies > 0) {
    const n = target.replies;
    return {
      title: `Delete this comment and its ${n} ${n === 1 ? "reply" : "replies"}?`,
      description: "Deleting the first comment in a thread removes the whole thread for everyone. This can’t be undone.",
    };
  }
  return { title: "Delete this comment?", description: "The comment is removed for everyone. This can’t be undone." };
}

/**
 * A blank while the name loads, rather than the raw alias, so the heading keeps its height. An
 * imported author's name is isolated, so no direction mark in it can reorder the marker after it.
 */
function AuthorName({ author }: { author: string }) {
  if (nameLoading(`user:${author}`)) return "\u00a0";
  const imported = importedAuthor(author);
  if (imported === null) return authorLabel(author);
  return (
    <>
      <bdi>{imported}</bdi> · imported
    </>
  );
}

/** The alias behind the name, which tells two of one name apart; none for an imported author, whose name is all there is. */
function authorTitle(author: string): string | undefined {
  return importedAuthor(author) === null ? author : undefined;
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
        <button className="comment-quote" dir="auto" title="Jump to highlighted text" onClick={onJump}>
          “{root.anchor_quote}”
        </button>
      )}
      <div className="comment-head">
        <strong title={authorTitle(root.author)}>
          <AuthorName author={root.author} />
        </strong>
        <span className="comment-actions">
          <Button label={root.resolved ? "Reopen" : "Resolve"} variant="ghost" size="sm" onClick={onResolve} />
          <Button label="Delete" variant="ghost" size="sm" onClick={() => onDelete(root.num)} tooltip="Delete comment" />
        </span>
      </div>
      <CommentText body={root.body} mentions={root.mentions} />

      {replies.length > 0 && (
        <ul className="comment-replies">
          {replies.map((r) => (
            <li key={r.num} className="comment-reply">
              <div className="comment-head">
                <strong title={authorTitle(r.author)}>
                  <AuthorName author={r.author} />
                </strong>
                <span className="comment-actions">
                  <Button label="Delete" variant="ghost" size="sm" onClick={() => onDelete(r.num)} tooltip="Delete reply" />
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
            label="Reply"
            isLabelHidden
            value={draft}
            placeholder="Reply…"
            rows={1}
            onChange={setDraft}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitReply();
              }
            }}
          />
          <Button label="Reply" variant="secondary" size="sm" onClick={() => void submitReply()} isDisabled={!draft.trim() || busy} />
        </div>
      )}
    </li>
  );
}
