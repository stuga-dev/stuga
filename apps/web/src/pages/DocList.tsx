import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Docs, Folders, type DocSummary, type SearchResult } from "../api";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { useFavorites } from "../state/favorites";
import { FileExplorer, TableSkeleton } from "../library/FileExplorer";
import { DocTable, docRow, type LibraryRow, type LibrarySort } from "../library/DocTable";
import { TrashList } from "../library/TrashList";
import { FolderPicker } from "../ui/FolderPicker";
import { CollectionsPane } from "../library/CollectionsPane";
import { ImportMarkdownDialog } from "../library/ImportMarkdownDialog";
import { ShareDialog, shareKindOfDoc, type ShareKind } from "../library/ShareDialog";
import { AccountMenu } from "../shell/AccountMenu";
import { NotificationsBell } from "../shell/NotificationsBell";
import { NewFolderDialog } from "../library/NewFolderDialog";
import { WorkspaceSwitcher } from "../shell/WorkspaceSwitcher";
import { LibraryNav, type LibraryView } from "../library/LibraryNav";
import { useDocStateMenu } from "../library/doc-state";
import { useInstructionsDialog } from "../library/use-instructions-dialog";
import { pageParentLabel, usePageParents } from "../database/model/row-ref";
import { useCommandPalette } from "../shell/command-palette/context";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Item } from "@astryxdesign/core/Item";
import { LinkProvider } from "@astryxdesign/core/Link";
import { List } from "@astryxdesign/core/List";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useToast } from "@astryxdesign/core/Toast";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Brand, nodeName } from "../shell/Brand";
import { VStack } from "@astryxdesign/core/VStack";
import { Database, FileText, Files, Search, Users as UsersIcon, Star, Share2, ExternalLink } from "lucide-react";
import { errorMessage } from "../lib/http/client";
import { Marked, Snippet, hitHref, markTerms, queryTerms } from "../lib/snippet";
import { readStored, writeStored } from "../lib/storage";
import { fmtInt } from "../lib/format";
import { formatLocale, t } from "../i18n/i18n";
import "../styles/library.css";

/** Results asked for at first and added by each Show more, up to the server's cap. */
const SEARCH_PAGE = 20;
const SEARCH_MAX = 100;

/**
 * How deep Show more took a search, kept in its history entry's state rather than
 * the URL: Back from a document asks for that many again, while a new query (the
 * palette copies the library's URL keys) or a shared link starts at the first page.
 */
function savedDepth(state: unknown): number {
  const depth = (state as { searchDepth?: unknown } | null)?.searchDepth;
  if (typeof depth !== "number" || !Number.isInteger(depth)) return SEARCH_PAGE;
  return Math.min(SEARCH_MAX, Math.max(SEARCH_PAGE, depth));
}

/** sessionStorage: the history entry of the search results last left, and how far down they were scrolled. */
const SEARCH_SCROLL_KEY = "stuga_search_scroll";

/** The shell's content area, which scrolls the results. */
const resultsScroller = (list: HTMLElement | null) => list?.closest<HTMLElement>("[role=main]") ?? null;

function savedScroll(entry: string): number {
  try {
    const saved: unknown = JSON.parse(readStored("session", SEARCH_SCROLL_KEY) ?? "null");
    const { key, top } = (saved ?? {}) as { key?: unknown; top?: unknown };
    return key === entry && typeof top === "number" && top > 0 ? top : 0;
  } catch {
    return 0;
  }
}

export function DocList() {
  const palette = useCommandPalette();
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // A row's page is listed under its database ("Tasks › Fix the login").
  usePageParents((results ?? []).map((r) => r.page_of));
  const [searchDegraded, setSearchDegraded] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Apart from `results === null`, so a Retry can spin without unmounting its banner. */
  const [isSearching, setIsSearching] = useState(false);
  /** The limit the shown results were asked for with, and whether the answer filled it, so more may exist. */
  const [searchPage, setSearchPage] = useState({ limit: SEARCH_PAGE, full: false });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  /** Bumped per request; only the newest may write. */
  const searchGenRef = useRef(0);
  /** The previous effect run's query, telling an entry into search from a replacement. */
  const lastQueryRef = useRef("");
  const [explorerKey, setExplorerKey] = useState(0);
  // One row's move and a multi-selection's share this list and the picker's exclusion rules.
  const [moving, setMoving] = useState<Array<{ kind: "doc" | "folder"; id: string }> | null>(null);
  const [sharingFolder, setSharingFolder] = useState<string | null>(null);
  const [sharingDoc, setSharingDoc] = useState<{ id: string; kind: ShareKind } | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showImport, setShowImport] = useState(false);
  /** Bumped when a move through the dialog completes, so FileExplorer prunes its selection. */
  const [movedAway, setMovedAway] = useState(0);
  const nav = useNavigate();
  const location = useLocation();
  const toast = useToast();

  // Navigation lives in the URL (/?folder=<id>/<id>&sel=<docId>&trash=1), so Back steps through folders.
  const [searchParams, setSearchParams] = useSearchParams();
  const trashed = searchParams.get("trash") === "1";
  const sharedView = searchParams.get("shared") === "1";
  const favoritesView = searchParams.get("fav") === "1";
  const collectionsView = searchParams.get("coll") === "1";
  const selectedCollectionId = searchParams.get("cid");
  const path = (searchParams.get("folder") ?? "").split("/").filter(Boolean);
  const selectedDocId = searchParams.get("sel");
  /** The full-corpus search, in the URL so it is linkable and the ⌘K palette can hand a query over. Blank is no search. */
  const query = (searchParams.get("q") ?? "").trim();
  // Read when the query's search runs; a Show more writing a new depth must not start one.
  const depthRef = useRef(SEARCH_PAGE);
  depthRef.current = savedDepth(location.state);
  const sortKeyParam = searchParams.get("sort");
  const sort: LibrarySort = {
    key: sortKeyParam === "title" || sortKeyParam === "created_at" ? sortKeyParam : "updated_at",
    direction: searchParams.get("order") === "asc" ? "ascending" : "descending",
  };
  const view: LibraryView = collectionsView
    ? "collections"
    : trashed
      ? "trash"
      : sharedView
        ? "shared"
        : favoritesView
          ? "favorites"
          : "browse";
  // Where new documents and folders are created; null is the top level.
  const currentFolder = path.at(-1) ?? null;

  /** Write the explorer's URL keys, dropping empty ones; pushes history unless `replace`. */
  const setExplorerParams = useCallback(
    (
      next: {
        folder?: string[];
        sel?: string | null;
        trash?: boolean;
        shared?: boolean;
        fav?: boolean;
        coll?: boolean;
        cid?: string | null;
        sort?: LibrarySort;
      },
      replace = false,
    ) => {
      const sp = new URLSearchParams();
      const folder = (next.folder ?? path).join("/");
      const sel = next.sel === undefined ? selectedDocId : next.sel;
      const trash = next.trash === undefined ? trashed : next.trash;
      const shared = next.shared === undefined ? sharedView : next.shared;
      const fav = next.fav === undefined ? favoritesView : next.fav;
      const coll = next.coll === undefined ? collectionsView : next.coll;
      const cid = next.cid === undefined ? selectedCollectionId : next.cid;
      const s = next.sort ?? sort;
      if (folder) sp.set("folder", folder);
      if (sel) sp.set("sel", sel);
      if (trash) sp.set("trash", "1");
      if (shared) sp.set("shared", "1");
      if (fav) sp.set("fav", "1");
      if (coll) sp.set("coll", "1");
      if (coll && cid) sp.set("cid", cid);
      if (s.key !== "updated_at") sp.set("sort", s.key);
      if (s.direction === "ascending") sp.set("order", "asc");
      // `q` is dropped: every caller is asking for the explorer back, which leaves search.
      setSearchParams(sp, { replace });
    },
    [
      path,
      selectedDocId,
      trashed,
      sharedView,
      favoritesView,
      collectionsView,
      selectedCollectionId,
      sort,
      setSearchParams,
    ],
  );

  /** Leave search for the explorer underneath. */
  const clearSearch = useCallback(() => setExplorerParams({}), [setExplorerParams]);

  /** Views are exclusive and reset the folder path and selection. */
  const goToView = useCallback(
    (next: LibraryView) => {
      setExplorerParams({
        trash: next === "trash",
        shared: next === "shared",
        fav: next === "favorites",
        coll: next === "collections",
        folder: [],
        sel: null,
      });
    },
    [setExplorerParams],
  );

  // Flat: a shared document may sit in a folder the caller cannot see.
  const [sharedDocs, setSharedDocs] = useState<DocSummary[] | null>(null);
  useEffect(() => {
    if (!sharedView) return;
    setSharedDocs(null);
    Docs.sharedWithMe().then((r) => setSharedDocs(r.docs)).catch(() => setSharedDocs([]));
  }, [sharedView, explorerKey]);

  const favorites = useFavorites(explorerKey);

  async function newFolder(title: string, instructions: string) {
    try {
      await Folders.create(title, currentFolder, instructions);
      setExplorerKey((k) => k + 1);
    } catch (e) {
      toast({ body: errorMessage(e, t("pages.docList.createFolderFailed")), type: "error" });
    }
  }

  async function doMove(dest: string | null) {
    const items = moving;
    setMoving(null);
    if (!items?.length) return;
    // The picker offers no such destination, but a folder must never move into itself.
    const legal = items.filter((i) => !(i.kind === "folder" && dest === i.id));
    const results = await Promise.allSettled(
      legal.map((i) => (i.kind === "folder" ? Folders.move(i.id, dest) : Docs.move(i.id, dest))),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === legal.length && failed > 0) {
      const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      toast({ body: errorMessage(first?.reason, t("pages.docList.moveFailed")), type: "error" });
    } else if (failed > 0) {
      toast({
        body: t("pages.docList.movePartial", { moved: legal.length - failed, total: legal.length, failed }),
        type: "error",
      });
    } else if (legal.length > 1) {
      toast({ body: t("pages.docList.moved", { count: legal.length }), type: "info" });
    }
    setMovedAway((k) => k + 1);
    setExplorerKey((k) => k + 1);
  }

  /** Outside the debounce, so Retry runs at once. */
  const runSearch = useCallback((q: string, limit: number) => {
    // Nothing aborts an overtaken request, so only the newest may land.
    const gen = ++searchGenRef.current;
    if (!q.trim()) {
      setResults(null);
      setSearchDegraded(false);
      setSearchError(null);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    Docs.search(q, { limit })
      .then((r) => {
        if (gen !== searchGenRef.current) return;
        setResults(r.results);
        setSearchPage({ limit, full: r.results.length >= limit });
        setSearchDegraded(r.degraded);
        setSearchError(null);
        setIsSearching(false);
      })
      .catch((e: unknown) => {
        if (gen !== searchGenRef.current) return;
        // A failure is not zero matches.
        setResults([]);
        setSearchPage({ limit, full: false });
        setSearchDegraded(false);
        setSearchError(errorMessage(e, t("pages.docList.searchFailed")));
        setIsSearching(false);
      });
  }, []);

  /**
   * Asks again with a deeper limit. A deeper candidate pool can reorder the fused
   * ranking, so the rows on screen stay where they are and only documents not yet
   * shown join the end.
   */
  function showMore() {
    const gen = ++searchGenRef.current;
    const limit = Math.min(searchPage.limit + SEARCH_PAGE, SEARCH_MAX);
    setIsLoadingMore(true);
    Docs.search(query, { limit })
      .then((r) => {
        if (gen !== searchGenRef.current) return;
        setResults((cur) => {
          const shown = new Set((cur ?? []).map((x) => x.doc_id));
          return [...(cur ?? []), ...r.results.filter((x) => !shown.has(x.doc_id))];
        });
        setSearchPage({ limit, full: r.results.length >= limit });
        setSearchDegraded((d) => d || r.degraded);
        setIsLoadingMore(false);
        // Replace, not push: a deeper list is not navigation for Back to undo.
        setSearchParams(searchParams, { replace: true, state: { searchDepth: limit } });
      })
      .catch((e: unknown) => {
        if (gen !== searchGenRef.current) return;
        // The rows already found stay; the button stays to try again.
        setIsLoadingMore(false);
        toast({ body: errorMessage(e, t("pages.docList.loadMoreFailed")), type: "error" });
      });
  }

  /**
   * Run the URL's query, as deep as its history entry went: at once when entering
   * search or repeating a query, and debounced when one query replaces another
   * (holding Back through `?q=` values), since each search is an uncached database query.
   */
  useEffect(() => {
    const previous = lastQueryRef.current;
    lastQueryRef.current = query;
    // An answer still out for the previous query, a first page or a Show more, must not land under this one.
    searchGenRef.current++;
    setResults(null);
    setSearchPage({ limit: SEARCH_PAGE, full: false });
    setIsLoadingMore(false);
    if (!query || !previous || previous === query) {
      runSearch(query, depthRef.current);
      return;
    }
    const timer = setTimeout(() => runSearch(query, depthRef.current), 400);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  // An answer still out when the page goes, a Show more's above all, must not write the URL from under a document.
  useEffect(() => () => void searchGenRef.current++, []);

  const listRef = useRef<HTMLDivElement>(null);
  // The entry being left: the page unmounts without rendering the document's location.
  const entryRef = useRef(location.key);
  entryRef.current = location.key;
  const [restoreTop] = useState(() => savedScroll(location.key));
  const scrollRestoredRef = useRef(false);

  // Back to results left for a document lands where the reader was, once the rows are in.
  useLayoutEffect(() => {
    if (scrollRestoredRef.current || results === null) return;
    scrollRestoredRef.current = true;
    const scroller = resultsScroller(listRef.current);
    if (scroller && restoreTop > 0) scroller.scrollTop = restoreTop;
  }, [results, restoreTop]);

  // On the way out, while the list is still in the page.
  useLayoutEffect(
    () => () => {
      const scroller = resultsScroller(listRef.current);
      if (!scroller) return;
      writeStored("session", SEARCH_SCROLL_KEY, JSON.stringify({ key: entryRef.current, top: scroller.scrollTop }));
    },
    [],
  );

  async function createItem(docType: "prose" | "database") {
    try {
      const doc = await Docs.create(t("common.untitled"), currentFolder, docType);
      nav(`/doc/${doc.doc_id}`, docType === "prose" ? { state: { focusEditor: true } } : undefined);
    } catch (e) {
      toast({ body: errorMessage(e, t("pages.docList.createFailed")), type: "error" });
    }
  }
  const create = () => createItem("prose");

  /** One clean import opens; a batch, or a run with failures still on screen, is revealed in place. */
  function afterImport(docs: DocSummary[], single: boolean) {
    if (single && docs.length === 1 && docs[0]) {
      nav(`/doc/${docs[0].doc_id}`);
      return;
    }
    setExplorerKey((k) => k + 1);
    if (docs[0]) setExplorerParams({ sel: docs[0].doc_id });
  }

  const topNav = (
    <TopNav
      label={t("pages.docList.nav")}
      startContent={
        <HStack gap={3} vAlign="center">
          <div className="brand">
            <Brand />
            <Heading level={1}>{nodeName()}</Heading>
          </div>
          <span className="topnav__sep" aria-hidden="true" />
          <WorkspaceSwitcher />
        </HStack>
      }
      /* A button that opens the ⌘K palette, not a second search box. */
      centerContent={
        <div className="topnav__search">
          {/* The Kbd is hidden from the accessible name, which would otherwise
              change with the OS; the palette answers both modifiers everywhere. */}
          <Button
            label={t("pages.docList.searchAll")}
            icon={<Search size={16} />}
            endContent={<Kbd keys="mod+k" aria-hidden="true" />}
            aria-keyshortcuts="Meta+K Control+K"
            variant="secondary"
            width="100%"
            onClick={palette.open}
          />
        </div>
      }
      endContent={
        <HStack gap={1} vAlign="center">
          <NotificationsBell />
          <AccountMenu />
        </HStack>
      }
    />
  );

  const VIEW_HEADERS: Record<LibraryView, { title: string; description: string }> = {
    browse: { title: t("common.allDocuments"), description: t("pages.docList.view.browseNote") },
    favorites: { title: t("pages.docList.view.favorites"), description: t("pages.docList.view.favoritesNote") },
    shared: { title: t("pages.docList.view.shared"), description: t("pages.docList.view.sharedNote") },
    collections: {
      title: t("pages.docList.view.collections"),
      description: t("pages.docList.view.collectionsNote"),
    },
    trash: {
      title: t("pages.docList.view.trash"),
      description: t("pages.docList.view.trashNote", { days: TRASH_RETENTION_DAYS }),
    },
  };
  const header = VIEW_HEADERS[view];

  /** Browse has no title bar: its breadcrumb already names the place. */
  const contentHeader =
    view === "browse" ? null : (
      <div className="view-head">
        <HStack gap={2} vAlign="center">
          <Heading level={2} type="display-3">
            {header.title}
          </Heading>
          {view === "trash" && <Badge variant="warning" label={t("pages.docList.trashRetention", { days: TRASH_RETENTION_DAYS })} />}
        </HStack>
      </div>
    );

  return (
    <AppShell
      topNav={topNav}
      contentPadding={0}
      sideNav={
        <LibraryNav
          // No view is current while search results replace the explorer.
          view={query ? null : view}
          onViewChange={goToView}
          onNewDoc={create}
          onNewDatabase={() => createItem("database")}
          onNewFolder={() => setShowNewFolder(true)}
          onImport={() => setShowImport(true)}
          onAsk={() => nav("/ask")}
          onReview={() => nav("/review")}
          // The library is always inside a workspace, so its Settings opens that workspace's settings.
          onSettings={() => nav("/settings/workspace")}
          sharedCount={sharedDocs?.length ?? null}
          favoriteCount={favorites.count || null}
        />
      }
    >
      {query ? (
        // Gated on the query, not the results, so a `?q=` link never paints the explorer first.
        <div className="doc-list" ref={listRef}>
          <header className="doc-list-head">
            <div className="doc-list-head__title">
              <Heading level={1} type="display-3">{t("pages.docList.search.title")}</Heading>
              <span className="doc-list-head__query">
                <Text type="supporting" color="secondary">{t("pages.docList.search.forQuery", { query })}</Text>
              </span>
              {results && results.length > 0 && (
                // A full answer is the top of a longer list, not a total.
                <Badge variant="neutral" label={searchPage.full ? t("pages.docList.search.top", { count: results.length }) : fmtInt(results.length)} />
              )}
            </div>
            {/* The way out: a shared `?q=` link has no history to go Back through. */}
            <Button label={t("common.allDocuments")} icon={<Files size={16} />} variant="ghost" size="sm" onClick={clearSearch} />
          </header>
          <VStack gap={2}>
            {results === null ? (
              <Spinner label={t("pages.docList.search.searching")} />
            ) : (
              <>
                {searchError && (
                  <Banner
                    status="error"
                    title={t("pages.docList.search.failedTitle")}
                    description={searchError}
                    // Spins on the button: swapping the banner for the page spinner would drop focus.
                    endContent={
                      <Button
                        label={t("common.retry")}
                        variant="ghost"
                        size="sm"
                        isLoading={isSearching}
                        onClick={() => runSearch(query, searchPage.limit)}
                      />
                    }
                  />
                )}
                {searchDegraded && (
                  <Banner
                    status="warning"
                    title={t("pages.docList.search.degradedTitle")}
                    description={t("pages.docList.search.degradedBody")}
                  />
                )}
                {/* Rows are links, so one opens in a new tab or copies its link; a plain click stays in the app. */}
                <LinkProvider component={RouterLink}>
                  <List hasDividers>
                    {results.map((r) => (
                      <Item
                        as="li"
                        key={r.doc_id}
                        className="search-result"
                        align="start"
                        label={
                          <span className="bidi-line search-hit">
                            {r.page_of && `${pageParentLabel(r.page_of)} › `}
                            <Marked parts={markTerms(r.title || t("common.untitled"), queryTerms(query))} />
                          </span>
                        }
                        description={<Snippet text={r.snippet} />}
                        startContent={r.doc_type === "database" ? <Database size={16} /> : <FileText size={16} />}
                        // Opens at the passage that matched.
                        href={hitHref(r.doc_id, r, query)}
                      />
                    ))}
                  </List>
                </LinkProvider>
                {searchPage.full && searchPage.limit < SEARCH_MAX && !searchError && (
                  <HStack hAlign="center">
                    <Button label={t("pages.docList.search.showMore")} variant="secondary" size="sm" isLoading={isLoadingMore} onClick={showMore} />
                  </HStack>
                )}
                {results.length === 0 && !searchError && (
                  <EmptyState
                    title={t("pages.docList.search.noMatches")}
                    description={t("pages.docList.search.noMatchesHint")}
                    icon={<FileText size={28} />}
                  />
                )}
              </>
            )}
          </VStack>
        </div>
      ) : (
        <div className="explorer-shell">
          {contentHeader}
          {collectionsView ? (
            <CollectionsPane
              selectedId={selectedCollectionId}
              onSelect={(id) => setExplorerParams({ coll: true, cid: id })}
            />
          ) : sharedView ? (
            <FlatDocTable
              docs={sharedDocs}
              favorites={favorites}
              sort={sort}
              onSortChange={(next) => setExplorerParams({ sort: next })}
              onOpen={(id) => nav(`/doc/${id}`)}
              onShare={(id, kind) => setSharingDoc({ id, kind })}
              emptyState={
                <EmptyState
                  title={t("pages.docList.shared.emptyTitle")}
                  description={t("pages.docList.shared.emptyBody")}
                  icon={<UsersIcon size={26} />}
                />
              }
            />
          ) : favoritesView ? (
            <FlatDocTable
              docs={favorites.docs}
              favorites={favorites}
              sort={sort}
              onSortChange={(next) => setExplorerParams({ sort: next })}
              onOpen={(id) => nav(`/doc/${id}`)}
              onShare={(id, kind) => setSharingDoc({ id, kind })}
              emptyState={
                <EmptyState
                  title={t("pages.docList.favorites.emptyTitle")}
                  description={t("pages.docList.favorites.emptyBody")}
                  icon={<Star size={26} />}
                />
              }
            />
          ) : trashed ? (
            <TrashList key={explorerKey} />
          ) : (
            <FileExplorer
              refreshKey={explorerKey}
              movedAway={movedAway}
              path={path}
              selectedDocId={selectedDocId}
              sort={sort}
              onSortChange={(next) => setExplorerParams({ sort: next })}
              onPathChange={(next) => setExplorerParams({ folder: next, sel: null })}
              // Replace, not push: a selection is not navigation for Back to undo.
              onSelectDoc={(docId) => setExplorerParams({ sel: docId }, true)}
              onMoveDoc={(id) => setMoving([{ kind: "doc", id }])}
              onMoveFolder={(id) => setMoving([{ kind: "folder", id }])}
              onMoveMany={(items) => setMoving(items)}
              onShareFolder={(id) => setSharingFolder(id)}
              onShareDoc={(id, kind) => setSharingDoc({ id, kind })}
              onCreateDoc={create}
              onCreateDatabase={() => createItem("database")}
              onCreateFolder={() => setShowNewFolder(true)}
              onImport={() => setShowImport(true)}
            />
          )}
        </div>
      )}

      {moving && (
        <FolderPicker
          // No folder being moved may land inside its own subtree.
          excludeSubtreeOf={new Set(moving.filter((i) => i.kind === "folder").map((i) => i.id))}
          onPick={doMove}
          onClose={() => setMoving(null)}
        />
      )}
      {sharingDoc && (
        <ShareDialog docId={sharingDoc.id} kind={sharingDoc.kind} onClose={() => setSharingDoc(null)} />
      )}
      {sharingFolder && (
        <ShareDialog
          docId={sharingFolder}
          kind="folder"
          onClose={() => {
            setSharingFolder(null);
            setExplorerKey((k) => k + 1);
          }}
        />
      )}
      <ImportMarkdownDialog
        isOpen={showImport}
        parentId={currentFolder}
        onImported={afterImport}
        onClose={() => setShowImport(false)}
      />
      <NewFolderDialog isOpen={showNewFolder} parentId={currentFolder} onSubmit={newFolder} onClose={() => setShowNewFolder(false)} />
    </AppShell>
  );
}

const NO_SELECTION: ReadonlySet<string> = new Set();

/** Shared with me and Favorites. Sorted here: both endpoints return the complete set, not a capped window. */
function FlatDocTable({
  docs,
  favorites,
  sort,
  onSortChange,
  onOpen,
  onShare,
  emptyState,
}: {
  docs: DocSummary[] | null;
  favorites: ReturnType<typeof useFavorites>;
  sort: LibrarySort;
  onSortChange: (next: LibrarySort) => void;
  onOpen: (docId: string) => void;
  onShare: (docId: string, kind: ShareKind) => void;
  emptyState: React.ReactNode;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  const stateMenu = useDocStateMenu();
  const instructions = useInstructionsDialog();
  /** State changes from a row menu, overlaid on the fetched rows until a fresh list arrives. */
  const [stateEdits, setStateEdits] = useState<Record<string, DocSummary>>({});
  useEffect(() => {
    setStateEdits((cur) => (Object.keys(cur).length > 0 ? {} : cur));
  }, [docs]);
  const rows = useMemo<LibraryRow[]>(() => {
    const mapped = (docs ?? []).map((raw) => docRow(stateEdits[raw.doc_id] ?? raw));
    const dir = sort.direction === "ascending" ? 1 : -1;
    const locale = formatLocale();
    return mapped.sort((a, b) => {
      let order: number;
      if (sort.key === "title") order = a.title.localeCompare(b.title, locale);
      else {
        const va = sort.key === "created_at" ? (a.created_at ?? "") : a.updated_at;
        const vb = sort.key === "created_at" ? (b.created_at ?? "") : b.updated_at;
        order = va < vb ? -1 : va > vb ? 1 : 0;
      }
      return order !== 0 ? order * dir : a.id.localeCompare(b.id);
    });
  }, [docs, sort.key, sort.direction, stateEdits]);

  if (docs === null) return <TableSkeleton />;
  return (
    <div className="flat-table">
      <DocTable
        rows={rows}
        // Arrow keys click the next row, so a click selects and activation opens.
        selectedIds={selected}
        onSelectionChange={(ids) => setSelected(new Set(ids))}
        favorites={favorites.ids}
        sort={sort}
        onSortChange={onSortChange}
        onActivate={(r) => onOpen(r.id)}
        onToggleFavorite={(id) => void favorites.toggle(id)}
        rowActions={(r) => [
          { label: t("common.open"), icon: <ExternalLink size={15} />, onClick: () => onOpen(r.id) },
          { label: t("pages.docList.row.share"), icon: <Share2 size={15} />, onClick: () => onShare(r.id, shareKindOfDoc(r.doc)) },
          ...(r.doc
            ? [
                {
                  type: "section" as const,
                  title: r.doc.doc_type === "database" ? t("common.database") : t("common.document"),
                  items: [
                    ...stateMenu(r.doc, (next) => setStateEdits((cur) => ({ ...cur, [next.doc_id]: next }))),
                    instructions.item({ kind: r.doc.doc_type === "database" ? "database" : "document", id: r.id, title: r.title }),
                  ],
                },
              ]
            : []),
        ]}
        emptyState={emptyState}
      />
      {instructions.dialog}
    </div>
  );
}
