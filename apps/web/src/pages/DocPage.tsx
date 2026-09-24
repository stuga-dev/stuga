import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { StugaProvider } from "../sync/stuga-provider";
import { Editor } from "../editor/Editor";
import { ShareDialog } from "../library/ShareDialog";
import { DocDock, useDocDock } from "../document/DocDock";
import { DockToggle } from "../ui/Dock";
import { ItemOptionsMenu } from "../library/ItemOptionsMenu";
import { ItemTitle, useTitleRename } from "./ItemTitle";
import { EditorProvider } from "../editor/editor-context";
import { CitationJump } from "../editor/use-citation-jump";
import { CommentsProvider } from "../comments/comments-context";
import { AiCoauthorProvider } from "../ai/ai-coauthor-context";
import { AgentRunsProvider } from "../review/agent-runs-context";
import { AgentRunBar } from "../review/AgentRunBar";
import { AgentCatchUpCard } from "../review/AgentCatchUpCard";
import { PresenceStack } from "../document/PresenceStack";
import { ConnectionStatus } from "../document/ConnectionStatus";
import { useLinkHealth } from "../sync/use-link-health";
import { AccountMenu } from "../shell/AccountMenu";
import { NotificationsBell } from "../shell/NotificationsBell";
import { Outline } from "../document/Outline";
import { ResizeHandle, usePanelWidth } from "../ui/ResizeHandle";
import { useIsCompact } from "../ui/narrow";
import { useKeepReadingPosition } from "../editor/use-keep-reading-position";
import { useRefreshAfterIndexing } from "../document/use-refresh-after-indexing";
import { Docs, type DocSummary } from "../api";
import { getDisplayName } from "../lib/http/client";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { readStored, writeStored } from "../lib/storage";
import { DocStateChips } from "../library/DocStateChips";
import { DocViewControl, WIDTH_ORDER, ZOOM_DEFAULT, ZOOM_PRESETS, type WidthKey } from "../document/DocViewControl";
import { pageRefOf, parseRowRef, rowHref } from "../database/model/row-ref";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { useToast } from "@astryxdesign/core/Toast";
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
      .then((d) => !cancelled && setCrumb({ database_id: d.doc_id, title: d.title || "Untitled" }))
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
  const rawName = getDisplayName() ?? "you";
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

  /** Set by an ACL write refusal: this caller lacks write access. */
  const [readOnly, setReadOnly] = useState(false);
  const [locked, setLocked] = useState(!!doc.locked);
  const [searchHidden, setSearchHidden] = useState(!!doc.search_hidden);
  const [agentMode, setAgentMode] = useState<ReviewMode>(doc.agent_mode);

  useEffect(() => {
    const p = new StugaProvider(docId, alias, {
      // "open" alone never turns the indicator green; a completed handshake does.
      onStatus: (s) => {
        if (s === "open") connSignals.onSocketOpen();
        else if (s === "revoked") connSignals.onRevoked();
        else connSignals.onSocketDown();
      },
      onSyncDone: connSignals.onSyncDone,
      onSynced: () => setHasSynced(true),
      onLocalUpdateDropped: connSignals.onLocalUpdateDropped,
      onLocalUpdatesAcked: connSignals.onLocalUpdatesAcked,
      // Only the indicator reacts: the actor keeps the edits and owns the retry, so editing stays on.
      onPersistDegraded: ({ degraded }) => connSignals.onPersistDegraded(degraded),
      onWriteRejected: (payload) => {
        connSignals.onWriteRejected();
        if (payload.kind === "acl") setReadOnly(true);
        // A lock sets only `locked`, so unlocking restores editing without a reload.
        if (payload.kind === "locked") setLocked(true);
        // One refused update; the document stays editable. "epoch" is already reloading the page.
        if (payload.kind === "table-cap" || payload.kind === "structural-rate") {
          toast({ body: payload.message, type: "error" });
        }
      },
    });
    setProvider(p);
    return () => {
      p.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useRefreshAfterIndexing(docId, provider?.doc ?? null, setDocMeta);

  const editorReadOnly = readOnly || locked;
  const dock = useDocDock(editorReadOnly);
  const rename = useTitleRename(docId, docMeta.title, editorReadOnly);
  // A compact window has no room beside the reading column: no outline or page-width controls, and the dock overlays the page.
  const isCompact = useIsCompact();

  return (
    <EditorProvider>
      <CitationJump />
      <CommentsProvider docId={docId} ydoc={provider?.doc ?? null} onReveal={() => dock.open("comments")}>
      <AiCoauthorProvider provider={provider} docId={docId} onRequestOpen={() => dock.open("ai")}>
      <AgentRunsProvider provider={provider} docId={docId}>
      <div className="doc-page" data-show-citations={showCitations ? "true" : "false"} data-doc-width={width} style={{ ["--doc-width" as string]: WIDTHS[width], ["--doc-zoom" as string]: zoom === 100 ? undefined : String(zoom / 100) }}>
        <TopNav
          label="Document"
          className="item-nav"
          startContent={
            <HStack gap={2} vAlign="center">
              <button className="brand brand--link" onClick={() => nav("/")} title="All documents" aria-label="All documents">
                <Brand />
              </button>
              {rowRef && crumb && crumb.database_id === rowRef.database_id && (
                <button className="doc-crumb" onClick={() => nav(rowHref(rowRef))} title={`Back to ${crumb.title}`} aria-label={`Back to ${crumb.title}`}>
                  <Text type="body" color="secondary" maxLines={1}>{crumb.title}</Text>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              )}
              <ItemTitle rename={rename} readOnly={editorReadOnly} label="Document title" />
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
                    label="Outline"
                    tooltip="Outline"
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
              <DockToggle isPressed={dock.state.visible} onToggle={dock.toggle} tooltip="Side panels — AI co-author, comments, versions, sources" />
              {!isCompact && <Divider orientation="vertical" />}
              <ItemOptionsMenu
                doc={{ ...docMeta, locked, search_hidden: searchHidden, agent_mode: agentMode }}
                readOnly={editorReadOnly}
                // A row's page goes back to its row, where the panel offers to restore it or start a new one.
                afterTrash={ownRow ? rowHref(ownRow) : undefined}
                onRename={rename.startEditing}
                onStateChanged={(next) => {
                  setDocMeta(next);
                  setLocked(!!next.locked);
                  setSearchHidden(!!next.search_hidden);
                  setAgentMode(next.agent_mode);
                }}
              />
              <Button label="Share" variant="secondary" icon={<Share2 size={16} />} isIconOnly={isCompact} onClick={() => setShowShare(true)} />
              <NotificationsBell />
              <AccountMenu />
            </HStack>
          }
        />
        <AgentRunBar />
        <AgentCatchUpCard docId={docId} ydoc={provider?.doc ?? null} />
        <div className="doc-body">
          {showOutline && !isCompact && (
            <>
              <Outline width={outlineW} />
              <ResizeHandle width={outlineW} onResize={setOutlineW} dir={1} label="Resize outline panel" />
            </>
          )}
          <main className="doc-main">
            {provider ? (
              <Editor provider={provider} alias={alias} label={rawName} docId={docId} readOnly={editorReadOnly} hasSynced={hasSynced} autoFocus={autoFocus} />
            ) : (
              <VStack gap={2} hAlign="center" style={{ paddingTop: "18vh" }}>
                <Spinner label="Loading document…" />
              </VStack>
            )}
          </main>
          {dock.state.visible && dock.state.active && (
            <DocDock dock={dock} docId={docId} ydoc={provider?.doc ?? null} provider={provider} width={dockW} onResize={setDockW} />
          )}
        </div>
        {showShare && <ShareDialog docId={docId} onClose={() => setShowShare(false)} />}
        {connStatus.phase === "revoked" && <div className="toast">You no longer have access to this document.</div>}
      </div>
      </AgentRunsProvider>
      </AiCoauthorProvider>
      </CommentsProvider>
    </EditorProvider>
  );
}
