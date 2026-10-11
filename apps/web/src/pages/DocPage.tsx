import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { StugaProvider } from "../sync/stuga-provider";
import { Editor } from "../editor/Editor";
import { ShareDialog } from "../library/ShareDialog";
import { useShareRequested } from "../library/share-request";
import { MentionScopeProvider } from "../mentions/mention-scope";
import { DocDock, useDocDock } from "../document/DocDock";
import { DockToggle } from "../ui/Dock";
import { ItemOptionsMenu } from "../library/ItemOptionsMenu";
import { useDocFileActions } from "../library/doc-file-actions";
import { ItemTitle, useTitleRename } from "./ItemTitle";
import { usePageTitle } from "../state/branding";
import { EditorProvider } from "../editor/editor-context";
import { CitationJump } from "../editor/use-citation-jump";
import { CommentsProvider } from "../comments/comments-context";
import { CommentDeepLink } from "../comments/CommentDeepLink";
import { AiCoauthorProvider } from "../ai/ai-coauthor-context";
import { AgentRunsProvider } from "../review/agent-runs-context";
import { AgentRunBar } from "../review/AgentRunBar";
import { AgentCatchUpCard } from "../review/AgentCatchUpCard";
import { PresenceStack } from "../document/PresenceStack";
import { ConnectionStatus } from "../document/ConnectionStatus";
import { useLinkHealth } from "../sync/use-link-health";
import { hasUnsentEdits } from "../sync/link-health";
import { LeaveUnsentGuard } from "../document/LeaveUnsentGuard";
import { AccountMenu } from "../shell/AccountMenu";
import { NotificationsBell } from "../shell/NotificationsBell";
import { Outline } from "../document/Outline";
import { ResizeHandle, usePanelWidth } from "../ui/ResizeHandle";
import { useIsCompact } from "../ui/narrow";
import { useKeepReadingPosition } from "../editor/use-keep-reading-position";
import { useRefreshAfterIndexing } from "../document/use-refresh-after-indexing";
import { useFirstLine } from "../document/first-line";
import { takeRestore } from "../document/restore-notice";
import { versionLabel } from "../lib/format";
import { Docs, type DocSummary } from "../api";
import { getDisplayName } from "../lib/http/client";
import { MAX_TABLE_COLS, MAX_TABLE_ROWS } from "@stuga/protocol/domain/limits";
import { t } from "../i18n/i18n";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { readStored, writeStored } from "../lib/storage";
import { DocStateChips } from "../library/DocStateChips";
import { EndedBanner, TrashedBanner } from "../document/ItemStateBanner";
import { useLockedTypingHint } from "../document/use-locked-typing-hint";
import type { SyncEnding } from "../sync/stuga-provider";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { DocViewControl, WIDTH_ORDER, ZOOM_DEFAULT, ZOOM_PRESETS, type WidthKey } from "../document/DocViewControl";
import { pageRefOf, parseRowRef, rowHref } from "../database/model/row-ref";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useToast } from "../ui/use-toast";
import { Text } from "@astryxdesign/core/Text";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Brand } from "../shell/Brand";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ChevronRight, Share2, TableOfContents } from "lucide-react";

const WIDTHS: Record<WidthKey, string> = {
  narrow: "640px",
  medium: "740px",
  wide: "960px",
  full: "100%",
};

/** A prose document. Mounted once per document: ItemPage keys it on the id. */
export function DocPage({ doc }: { doc: DocSummary }) {
  const docId = doc.doc_id;
  const nav = useNavigate();
  const location = useLocation();
  const autoFocus = (location.state as { focusEditor?: boolean } | null)?.focusEditor === true;
  const toast = useToast();
  // The latest row, for the ⋯ menu and the title; `locked` also lives apart because a mid-session refusal flips it with no new row.
  const [docMeta, setDocMeta] = useState<DocSummary>(doc);
  // A row's page shows its database as a breadcrumb: from the row link's `?row=`, or from the page's own metadata.
  const [searchParams] = useSearchParams();
  const ownRow = pageRefOf(docMeta);
  const rowRef = parseRowRef(searchParams.get("row")) ?? ownRow;
  const [crumb, setCrumb] = useState<{ database_id: string; title: string } | null>(null);
  useEffect(() => {
    if (!rowRef) {
      setCrumb(null);
      return;
    }
    let cancelled = false;
    Docs.get(rowRef.database_id)
      .then((d) => !cancelled && setCrumb({ database_id: d.doc_id, title: d.title || t("common.untitled") }))
      // A database the reader cannot open gets no crumb; the page still opens.
      .catch(() => !cancelled && setCrumb(null));
    return () => {
      cancelled = true;
    };
  }, [rowRef?.database_id]);
  const [provider, setProvider] = useState<StugaProvider | null>(null);
  const [hasSynced, setHasSynced] = useState(false);
  const { status: connStatus, signals: connSignals } = useLinkHealth(docId);
  const [showShare, setShowShare] = useState(false);
  // An access request's notification opens the page with the Share dialog up.
  useShareRequested(() => setShowShare(true));
  const [showOutline, setShowOutline] = useState(false);
  // Stored preferences are validated, never cast: anything can write the key.
  const [width, setWidth] = useState<WidthKey>(() => {
    const raw = readStored("local", "stuga_doc_width");
    return WIDTH_ORDER.includes(raw as WidthKey) ? (raw as WidthKey) : "medium";
  });
  const [showCitations, setShowCitations] = useState<boolean>(
    () => readStored("local", "stuga_show_citations") !== "false",
  );
  const [zoom, setZoom] = useState<number>(() => {
    const raw = parseInt(readStored("local", "stuga_doc_zoom") ?? "", 10);
    return (ZOOM_PRESETS as readonly number[]).includes(raw) ? raw : ZOOM_DEFAULT;
  });
  const [outlineW, setOutlineW] = usePanelWidth("stuga_outline_w", 240, 160, 480);
  // At 330 the strip still fits its four tabs beside New chat and close; narrower, the last tab scrolls out of sight.
  const [dockW, setDockW] = usePanelWidth("stuga_dock_w", 360, 330, 720);
  // The name collaborators see on this cursor: the display name, an email cut to its local part.
  const rawName = getDisplayName() ?? t("pages.doc.cursorFallback");
  const alias = rawName.includes("@") ? rawName.slice(0, rawName.indexOf("@")) : rawName;
  const keepReadingPosition = useKeepReadingPosition();

  // Width and zoom reflow the document; keep the reader on the passage they were reading.
  function setWidthPref(next: WidthKey) {
    keepReadingPosition(() => {
      setWidth(next);
      writeStored("local", "stuga_doc_width", next);
    });
  }

  function setZoomPref(next: number) {
    keepReadingPosition(() => {
      setZoom(next);
      writeStored("local", "stuga_doc_zoom", String(next));
    });
  }

  function setCitationsPref(next: boolean) {
    setShowCitations(next);
    writeStored("local", "stuga_show_citations", next ? "true" : "false");
  }

  /** This caller lacks write access: from the server's state, or an ACL write refusal. */
  const [readOnly, setReadOnly] = useState(false);
  const [locked, setLocked] = useState(!!doc.locked);
  /** In the trash: from the row, then from the server's state, so a trash or restore elsewhere shows at once. */
  const [trashed, setTrashed] = useState(!!doc.trashed);
  /** The server has said what this caller may do, so Restore is offered only to someone who may write. */
  const [stateKnown, setStateKnown] = useState(false);
  const [searchHidden, setSearchHidden] = useState(!!doc.search_hidden);
  const [agentMode, setAgentMode] = useState<ReviewMode>(doc.agent_mode);

  // Titles arrive from row reads, this page's renames and pushed renames, in any order: the one
  // asked for (or pushed) last wins, so an answer to an older request cannot bring back an old title.
  const titleAsOf = useRef(0);
  const applyRow = useCallback((next: DocSummary, askedAt: number) => {
    const stale = askedAt < titleAsOf.current;
    titleAsOf.current = Math.max(titleAsOf.current, askedAt);
    setDocMeta((prev) => (stale ? { ...next, title: prev.title, title_source: prev.title_source } : next));
  }, []);
  /** Someone renamed it while open: the provider's handler is set once, so it reaches the hook through this. */
  const onTitleChanged = useRef<(title: string, by: string) => void>(() => {});
  /** Who chose each title pushed while open, to name them if their rename wins over this page's. */
  const pushedBy = useRef(new Map<string, string>());

  // A restore reloaded the page: say who brought back which version.
  useEffect(() => {
    const restored = takeRestore(docId);
    if (!restored) return;
    const version = versionLabel(restored.at);
    toast({
      body: restored.mine
        ? t("document.versions.restoredByYou", { version })
        : t("document.versions.restoredBy", { name: restored.by, version }),
      type: "info",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => {
    const p = new StugaProvider(docId, alias, {
      // "open" alone never turns the indicator green; a completed handshake does.
      onStatus: (s) => {
        if (s === "open") connSignals.onSocketOpen();
        else if (s === "connecting" || s === "reconnecting") connSignals.onSocketDown();
        else connSignals.onEnded(s);
      },
      // Levels, so an unlock, a restore or a new tier undoes what a refusal set.
      onDocState: (state) => {
        setStateKnown(true);
        setReadOnly(!state.can_write);
        setLocked(state.locked);
        setTrashed(state.trashed);
      },
      onSyncDone: connSignals.onSyncDone,
      onSynced: () => setHasSynced(true),
      onTitleChanged: ({ title, by }) => onTitleChanged.current(title, by),
      onLocalUpdateDropped: connSignals.onLocalUpdateDropped,
      onLocalUpdatesAcked: connSignals.onLocalUpdatesAcked,
      // Only the indicator reacts: the actor keeps the edits and owns the retry, so editing stays on.
      onPersistDegraded: ({ degraded }) => connSignals.onPersistDegraded(degraded),
      onWriteRejected: (payload) => {
        connSignals.onWriteRejected();
        if (payload.kind === "acl") setReadOnly(true);
        // A lock sets only `locked`, so unlocking restores editing without a reload.
        if (payload.kind === "locked") setLocked(true);
        if (payload.kind === "trashed") setTrashed(true);
        // One refused update; the document stays editable. "epoch" is already reloading the page.
        // The doc actor's sentence is English for agents; a person reads the same refusal from the catalog.
        if (payload.kind === "table-cap") {
          toast({ body: t("pages.doc.tableCap", { cols: MAX_TABLE_COLS, rows: MAX_TABLE_ROWS }), type: "error" });
        } else if (payload.kind === "structural-rate") {
          toast({ body: t("pages.doc.structuralRate"), type: "error" });
        }
      },
    });
    setProvider(p);
    return () => {
      p.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useRefreshAfterIndexing(docId, provider?.doc ?? null, applyRow);

  /** Why syncing stopped for good, or null while it goes on. */
  const ended: SyncEnding | null =
    connStatus.phase === "revoked" || connStatus.phase === "deleted" || connStatus.phase === "removed" ? connStatus.phase : null;
  const editorReadOnly = readOnly || locked || trashed || ended !== null;
  const mainRef = useRef<HTMLElement>(null);
  useLockedTypingHint(locked && ended === null, mainRef);
  const dock = useDocDock(editorReadOnly);
  // Until someone names it, the title is the first line: shown as it is typed, before the node derives the same.
  const followsFirstLine = docMeta.title_source === "heading";
  const firstLine = useFirstLine(provider?.doc ?? null, followsFirstLine);
  // What the header shows; a download or a copy is named after it, not after a title the node has yet to derive.
  const shownTitle = (followsFirstLine && firstLine) || docMeta.title;
  const rename = useTitleRename(docId, shownTitle, editorReadOnly, undefined, (row, sentAt) => {
    applyRow(row, sentAt);
    readTitle();
  });
  /** Two renames at once arrive in either order: a row read after both says which won. */
  function readTitle() {
    const askedAt = Date.now();
    Docs.get(docId).then(
      (row) => {
        applyRow(row, askedAt);
        const by = pushedBy.current.get(row.title);
        if (by !== undefined) rename.noteRenamedBy(row.title, by, askedAt);
      },
      () => {},
    );
  }
  onTitleChanged.current = (title, by) => {
    titleAsOf.current = Date.now();
    pushedBy.current.set(title, by);
    setDocMeta((prev) => ({ ...prev, title, title_source: "user" }));
    readTitle();
  };
  usePageTitle(rename.name);
  // A compact window has no room beside the reading column: no outline or page-width controls, and the dock overlays the page.
  const isCompact = useIsCompact();
  // A copy opens at once, as a new document does.
  const fileActions = useDocFileActions({ openCopy: true });

  // @mentions here ask about this document, and offer Share for someone who cannot open it.
  const mentionScope = useMemo(() => ({ docId, share: () => setShowShare(true) }), [docId]);

  return (
    <MentionScopeProvider value={mentionScope}>
    <EditorProvider>
      <CitationJump />
      <CommentsProvider docId={docId} ydoc={provider?.doc ?? null} provider={provider} onReveal={() => dock.open("comments")}>
      <CommentDeepLink ready={hasSynced} />
      <AiCoauthorProvider provider={provider} docId={docId} onRequestOpen={() => dock.open("ai")}>
      <AgentRunsProvider provider={provider} docId={docId}>
      <div className="doc-page" data-show-citations={showCitations ? "true" : "false"} data-doc-width={width} style={{ ["--doc-width" as string]: WIDTHS[width], ["--doc-zoom" as string]: zoom === 100 ? undefined : String(zoom / 100) }}>
        <TopNav
          label={t("common.document")}
          className="item-nav"
          startContent={
            <HStack gap={2} vAlign="center">
              <button className="brand brand--link" onClick={() => nav("/")} title={t("common.allDocuments")} aria-label={t("common.allDocuments")}>
                <Brand />
              </button>
              {rowRef && crumb && crumb.database_id === rowRef.database_id && (
                <button className="doc-crumb" onClick={() => nav(rowHref(rowRef))} title={t("pages.doc.backTo", { title: crumb.title })} aria-label={t("pages.doc.backTo", { title: crumb.title })}>
                  <Text type="body" color="secondary" maxLines={1}>{crumb.title}</Text>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              )}
              <ItemTitle
                rename={rename}
                readOnly={editorReadOnly}
                label={t("pages.doc.titleLabel")}
                hint={followsFirstLine ? t("pages.itemTitle.namedFromFirstLine") : undefined}
              />
              <DocStateChips
                locked={locked}
                searchHidden={searchHidden}
                agentAuto={agentMode === "auto"}
                readOnly={readOnly}
              />
              <ConnectionStatus status={connStatus} />
              {provider && <PresenceStack provider={provider} />}
            </HStack>
          }
          endContent={
            <HStack gap={1} vAlign="center">
              {!isCompact && (
                <>
                  <ToggleButton
                    label={t("pages.doc.outline")}
                    tooltip={t("pages.doc.outline")}
                    isIconOnly
                    icon={<TableOfContents size={18} />}
                    size="sm"
                    isPressed={showOutline}
                    onPressedChange={() => setShowOutline((s) => !s)}
                  />
                  <DocViewControl
                    zoom={zoom}
                    onZoom={setZoomPref}
                    width={width}
                    onWidth={setWidthPref}
                    showCitations={showCitations}
                    onShowCitations={setCitationsPref}
                  />
                </>
              )}
              <DockToggle isPressed={dock.state.visible} onToggle={dock.toggle} tooltip={t("pages.doc.dockTooltip")} />
              {!isCompact && <Divider orientation="vertical" />}
              <ItemOptionsMenu
                doc={{ ...docMeta, locked, search_hidden: searchHidden, agent_mode: agentMode }}
                readOnly={editorReadOnly}
                // A row's page goes back to its row, where the panel offers to restore it or start a new one.
                afterTrash={ownRow ? rowHref(ownRow) : undefined}
                onRename={rename.startEditing}
                extras={fileActions.items({ ...docMeta, title: shownTitle }, { print: true })}
                onStateChanged={(next) => {
                  setDocMeta(next);
                  setLocked(!!next.locked);
                  setSearchHidden(!!next.search_hidden);
                  setAgentMode(next.agent_mode);
                }}
              />
              <Button label={t("common.share")} variant="secondary" icon={<Share2 size={16} />} isIconOnly={isCompact} onClick={() => setShowShare(true)} />
              <NotificationsBell />
              <AccountMenu />
            </HStack>
          }
        />
        {ended ? (
          <EndedBanner
            why={ended}
            noun="document"
            textToCopy={provider ? () => yXmlFragmentToMarkdown(provider.doc.getXmlFragment("default")) : undefined}
          />
        ) : (
          trashed && (
            <TrashedBanner
              docId={docId}
              canRestore={stateKnown && !readOnly && !locked}
              onRestored={(next) => {
                setDocMeta(next);
                setTrashed(!!next.trashed);
              }}
            />
          )
        )}
        <div className="doc-body">
          {showOutline && !isCompact && (
            <>
              <Outline width={outlineW} />
              <ResizeHandle width={outlineW} onResize={setOutlineW} dir={1} label={t("pages.doc.resizeOutline")} />
            </>
          )}
          <div className="doc-main-wrap">
            <main className="doc-main" ref={mainRef}>
              {provider ? (
                <Editor provider={provider} alias={alias} label={rawName} docId={docId} readOnly={editorReadOnly} hasSynced={hasSynced} autoFocus={autoFocus} />
              ) : (
                <VStack gap={2} hAlign="center" style={{ paddingTop: "18vh" }}>
                  <Spinner label={t("pages.doc.loading")} />
                </VStack>
              )}
            </main>
            <div className="doc-review-float">
              <AgentRunBar locked={locked} />
              <AgentCatchUpCard docId={docId} ydoc={provider?.doc ?? null} />
            </div>
          </div>
          {dock.state.visible && dock.state.active && (
            <DocDock
              dock={dock}
              docId={docId}
              ydoc={provider?.doc ?? null}
              provider={provider}
              agentAuto={agentMode === "auto"}
              width={dockW}
              onResize={setDockW}
            />
          )}
        </div>
        {showShare && <ShareDialog docId={docId} onClose={() => setShowShare(false)} />}
        <LeaveUnsentGuard unsent={hasUnsentEdits(connStatus)} />
      </div>
      </AgentRunsProvider>
      </AiCoauthorProvider>
      </CommentsProvider>
    </EditorProvider>
    </MentionScopeProvider>
  );
}
