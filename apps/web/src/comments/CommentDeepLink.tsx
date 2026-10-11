/**
 * `?comment=<num>`, the link a comment's notification opens: the comments are
 * read afresh, the thread opens in the Comments panel and its passage is shown,
 * or the page says the comment is gone. The parameter is then dropped, so a
 * reload does not do it again.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../ui/use-toast";
import { t } from "../i18n/i18n";
import { useComments } from "./comments-context";

/** `ready`: the document has synced, so the passage can be found and scrolled to. */
export function CommentDeepLink({ ready }: { ready: boolean }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("comment");
  const wanted = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const { comments, reload, clickComment } = useComments();
  const toast = useToast();
  /** The comment whose fresh read is in, and whether the read worked. */
  const [read, setRead] = useState<{ num: number; ok: boolean } | null>(null);

  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    setRead(null);
    void reload().then((ok) => live && setRead({ num: wanted, ok }));
    return () => {
      live = false;
    };
  }, [wanted, reload]);

  useEffect(() => {
    if (wanted === null || read?.num !== wanted || !ready) return;
    const c = comments.find((x) => x.num === wanted);
    // A reply opens its thread, which holds the passage. On the next frame, once the editor's
    // highlights hold the comments just read: an imported comment is found through them.
    if (c) requestAnimationFrame(() => clickComment(c.parent_num ?? c.num));
    // A failed read cannot tell a deleted comment from one not loaded.
    else if (read.ok) toast({ body: t("document.comments.linkGone"), type: "info" });
    // Spent: a later link to the same comment reads afresh.
    setRead(null);
    setParams(
      (p) => {
        p.delete("comment");
        return p;
      },
      { replace: true },
    );
  }, [wanted, read, ready, comments, clickComment, toast, setParams]);

  return null;
}
