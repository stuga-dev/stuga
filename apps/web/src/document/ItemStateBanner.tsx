/**
 * The states that stop work on an open item, under its top bar: in the trash,
 * or syncing over for good (access withdrawn, deleted, membership ended). The
 * item stays on screen, read-only, so nothing typed is lost from view.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { useToast } from "../ui/use-toast";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { Docs, type DocSummary } from "../api";
import { errorMessage, holdForEnding } from "../lib/http/client";
import { copyText } from "../lib/clipboard";
import { noteMembershipEnded } from "../lib/session/endings";
import { getActiveWorkspace, setActiveWorkspace, workspaceName } from "../lib/session/workspace-pointer";
import type { SyncEnding } from "../sync/stuga-provider";
import { t, type MessageKey } from "../i18n/i18n";

/** A document in the trash: Restore for someone who may write it. */
export function TrashedBanner({
  docId,
  canRestore,
  onRestored,
}: {
  docId: string;
  canRestore: boolean;
  onRestored: (doc: DocSummary) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    try {
      onRestored(await Docs.trash(docId, false));
    } catch (e) {
      toast({ body: errorMessage(e, t("document.trashed.restoreFailed")), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Banner
      status="warning"
      title={t("document.trashed.title")}
      description={t("document.trashed.body", { days: TRASH_RETENTION_DAYS })}
      endContent={
        canRestore ? (
          <Button
            label={busy ? t("document.trashed.restoring") : t("document.trashed.restore")}
            variant="secondary"
            size="sm"
            isDisabled={busy}
            onClick={() => void restore()}
          />
        ) : undefined
      }
    />
  );
}

const DELETED_TITLE: Record<"document" | "database", MessageKey> = {
  document: "document.ended.deleted",
  database: "document.ended.deletedDatabase",
};

/**
 * Syncing ended for good. A document offers its text to copy; leaving a
 * workspace one is no longer a member of reloads, so every view starts from the
 * memberships left.
 */
export function EndedBanner({
  why,
  noun,
  textToCopy,
}: {
  why: SyncEnding;
  noun: "document" | "database";
  /** The document's text as it stands on screen; none for a database. */
  textToCopy?: () => string;
}) {
  const nav = useNavigate();
  const toast = useToast();
  // A removed member's other requests now answer "no workspace": the page stays until they leave it.
  useEffect(() => {
    if (why !== "removed") return;
    holdForEnding(true);
    return () => holdForEnding(false);
  }, [why]);
  const active = getActiveWorkspace();
  const workspace = active ? workspaceName(active) : null;
  const title =
    why === "revoked"
      ? t("document.ended.revoked")
      : why === "deleted"
        ? t(DELETED_TITLE[noun])
        : workspace
          ? t("document.ended.removed", { workspace })
          : t("document.ended.removedUnnamed");

  async function copy() {
    if (!textToCopy) return;
    const ok = await copyText(textToCopy());
    toast(ok ? { body: t("document.ended.copied"), type: "info" } : { body: t("document.ended.copyFailed"), type: "error" });
  }

  function leave() {
    if (why !== "removed") {
      nav("/");
      return;
    }
    noteMembershipEnded();
    setActiveWorkspace(null);
    window.location.assign("/");
  }

  return (
    <Banner
      status="error"
      title={title}
      description={noun === "document" ? t("document.ended.body") : t("document.ended.bodyDatabase")}
      endContent={
        <HStack gap={2}>
          {textToCopy && <Button label={t("document.ended.copy")} variant="secondary" size="sm" onClick={() => void copy()} />}
          <Button label={t("common.allDocuments")} variant="secondary" size="sm" onClick={leave} />
        </HStack>
      }
    />
  );
}
