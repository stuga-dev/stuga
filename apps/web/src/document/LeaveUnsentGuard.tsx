/**
 * Asks before a page with unsent edits is left. Until the node confirms them
 * they live only in this page's memory (they are not kept in browser storage),
 * so closing, reloading or opening another page would drop them. Staying is
 * enough: the next handshake sends them.
 */
import { useCallback, useEffect } from "react";
import { useBlocker, type BlockerFunction } from "react-router-dom";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { t } from "../i18n/i18n";
import { isForcedReload } from "../sync/forced-reload";

export function LeaveUnsentGuard({ unsent }: { unsent: boolean }) {
  // Closing the tab or reloading: the browser asks, in its own words.
  useEffect(() => {
    if (!unsent) return;
    const ask = (e: BeforeUnloadEvent) => {
      // The node rolled the document back: these edits cannot be kept, and staying would leave a page that never sends.
      if (isForcedReload()) return;
      e.preventDefault();
      // Safari still asks only when returnValue is set.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [unsent]);

  // Another page of the app, by a link or Back. A query change on this page (a comment, a row) stays put.
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => unsent && currentLocation.pathname !== nextLocation.pathname,
    [unsent],
  );
  const blocker = useBlocker(shouldBlock);

  // They arrived while the question was up: leaving loses nothing now.
  useEffect(() => {
    if (blocker.state === "blocked" && !unsent) blocker.proceed();
  }, [blocker, unsent]);

  return (
    <AlertDialog
      isOpen={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset();
      }}
      title={t("document.leaveUnsent.title")}
      description={t("document.leaveUnsent.body")}
      cancelLabel={t("document.leaveUnsent.stay")}
      actionLabel={t("document.leaveUnsent.leave")}
      onAction={() => {
        if (blocker.state === "blocked") blocker.proceed();
      }}
    />
  );
}
