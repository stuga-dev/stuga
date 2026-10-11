/**
 * The ⌘K palette: search documents and run quick actions. Mounted once inside
 * the router; the open flag lives in CommandPaletteProvider so a page's search
 * control can open it. Empty, it offers the documents opened lately. Document
 * hits are a preview of six, each with the passage that matched: keyword hits
 * first, then the hybrid search once typing pauses. "Search all documents"
 * hands the query to the library.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Docs, Folders, Me, Workspaces, type DocSummary, type SearchResult } from "../../api";
import { pageParentLabel, usePageParents } from "../../database/model/row-ref";
import { useCommandPalette } from "./context";
import { Dialog } from "@astryxdesign/core/Dialog";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Item } from "@astryxdesign/core/Item";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { Kbd } from "@astryxdesign/core/Kbd";
import { CommandPaletteFooter, CommandPaletteGroup } from "@astryxdesign/core/CommandPalette";
import { useAnnounce } from "@astryxdesign/core/hooks";
import { useToast } from "../../ui/use-toast";
import { NewFolderDialog } from "../../library/NewFolderDialog";
import { ImportMarkdownDialog } from "../../library/ImportMarkdownDialog";
import { openKeyboardShortcuts } from "../KeyboardShortcuts";
import {
  Database,
  FilePlus,
  FileText,
  FileUp,
  Files,
  FolderPlus,
  Gauge,
  Keyboard,
  Palette,
  Plug,
  RotateCw,
  ScrollText,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Users, ListChecks } from "lucide-react";
import { errorMessage } from "../../lib/http/client";
import { HitDescription, Marked, foundByMeaning, hitHref, markTerms, queryTerms } from "../../lib/snippet";
import { absoluteTime, relativeTime } from "../../lib/format";
import { forgetRecentDoc, recentDocIds } from "../../lib/recent-docs";
import { getActiveWorkspace } from "../../lib/session/workspace-pointer";
import { isComposingKey } from "../../lib/ime";
import { selectOnFocus } from "../../ui/select-on-focus";
import { t, type MessageKey } from "../../i18n/i18n";
import { EN } from "../../i18n/en";

interface Cmd {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  icon: ReactNode;
  /** Words it matches besides its label, in English. */
  terms?: string[];
  /** Runs without closing the palette. */
  keepsOpen?: boolean;
  run: () => void | Promise<void>;
}

const DOC_HITS = 6;
const RECENT_SHOWN = 5;
/** Keyword hits come back fast and cost no provider call; the hybrid search follows once typing pauses. */
const KEYWORD_DELAY_MS = 120;
const HYBRID_DELAY_MS = 450;
/** Characters of context kept before a snippet's first hit, so the hit shows in two lines. */
const SNIPPET_LEAD = 40;
/** The dialog's inline start: centred while 640px fit, else the window's 16px margin. */
export const PALETTE_START = "max(16px, calc(50% - 320px))";

/** While loading, the previous query's hits stay on screen, dimmed and out of reach of Enter. */
type DocSearch =
  | { status: "idle" }
  | { status: "loading"; hits: SearchResult[] }
  | { status: "done"; hits: SearchResult[]; degraded: boolean }
  | { status: "error" };

/** `label` in the interface language, `english` as the catalog writes it, so either finds the action. */
type Action = Cmd & { label: string; english: string };

/** An action from its catalog key: shown translated, matched in both languages. */
function action(key: MessageKey, cmd: Omit<Action, "label" | "english">): Action {
  return { ...cmd, label: t(key), english: EN[key] ?? key };
}

/**
 * An action matches where its translated label contains the query (a language written without
 * spaces has no word starts), or where a word of its English label or terms starts with it.
 */
function matchesAction(cmd: Action, needle: string): boolean {
  if (cmd.label !== cmd.english && cmd.label.toLowerCase().includes(needle)) return true;
  return [cmd.english, ...(cmd.terms ?? [])].some((text) => {
    const hay = text.toLowerCase();
    return hay.startsWith(needle) || hay.includes(` ${needle}`);
  });
}

/** A key's glyphs, named for a screen reader in the reader's language (Kbd's own name is English). */
function KeyHint({ keys, spoken }: { keys: string; spoken: string }) {
  return (
    <>
      <Kbd keys={keys} aria-hidden="true" />
      <VisuallyHidden>{spoken}</VisuallyHidden>
    </>
  );
}

/** Whether the mod key is Command, as Kbd decides it. */
function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function CommandPalette() {
  const { isOpen: open, setOpen } = useCommandPalette();
  const [q, setQ] = useState("");
  const [docSearch, setDocSearch] = useState<DocSearch>({ status: "idle" });
  const [searchRun, setSearchRun] = useState(0);
  const [recent, setRecent] = useState<DocSummary[]>([]);
  const announce = useAnnounce();
  /**
   * The highlighted command by id, not position: debounced document hits land
   * above "Search all documents" and would shift an index under a pending Enter.
   * Null is the top of the list, so the first hit takes it when hits arrive.
   */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  // The gated settings pages are offered only to those the server lets in; a failed check hides them.
  const [canSeeLedger, setCanSeeLedger] = useState(false);
  const [isNodeAdmin, setIsNodeAdmin] = useState(false);
  // A guest creates nothing in the workspace, so the create commands are left out.
  const [isGuest, setIsGuest] = useState(false);
  useEffect(() => {
    let alive = true;
    Me.whoami()
      .then((me) => alive && setIsNodeAdmin(me.node_admin))
      .catch(() => {});
    Workspaces.list()
      .then(({ workspaces, active }) => {
        const role = workspaces.find((w) => w.workspace_id === active)?.role;
        if (!alive) return;
        setCanSeeLedger(role === "owner" || role === "admin");
        setIsGuest(role === "guest");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  /**
   * The library's current query and URL keys. Opening over search results starts
   * from that query, and a new search keeps the library's other keys so its way
   * back can restore them. Elsewhere a search starts from a clean library.
   */
  const libraryParams = loc.pathname === "/" ? loc.search : null;
  const liveQuery = (new URLSearchParams(libraryParams ?? "").get("q") ?? "").trim();

  // A window listener, so the shortcut works with focus in an editor or a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // Seeded while rendering, so the input holds the query by the time it takes focus and selects it.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQ(liveQuery);
      setActiveId(null);
    }
  }

  // Asked of the server at each opening: titles stay current, and what the person can no longer read drops out.
  const openDocId = /^\/doc\/([^/]+)/.exec(loc.pathname)?.[1];
  useEffect(() => {
    if (!open) return;
    const workspace = getActiveWorkspace();
    const ids = recentDocIds(workspace)
      .filter((id) => id !== openDocId)
      .slice(0, RECENT_SHOWN);
    let alive = true;
    void Promise.allSettled(ids.map((id) => Docs.get(id))).then((answers) => {
      if (!alive) return;
      const shown: DocSummary[] = [];
      answers.forEach((a, i) => {
        if (a.status === "fulfilled") {
          if (!a.value.trashed) shown.push(a.value);
        } else if ([403, 404].includes((a.reason as { status?: number }).status ?? 0)) {
          forgetRecentDoc(workspace, ids[i]!);
        }
      });
      setRecent(shown);
    });
    return () => {
      alive = false;
    };
  }, [open, openDocId]);

  const trimmed = q.trim();
  useEffect(() => {
    if (!open || !trimmed) {
      setDocSearch({ status: "idle" });
      return;
    }
    setDocSearch((s) => ({ status: "loading", hits: "hits" in s ? s.hits : [] }));
    // An overtaken query's requests are cancelled, and an answer that lands anyway is ignored.
    const abort = new AbortController();
    let current = true;
    let keywordShown = false;
    let hybridShown = false;
    const show = (hits: SearchResult[], degraded: boolean) =>
      setDocSearch({ status: "done", hits: hits.slice(0, DOC_HITS), degraded });
    const keyword = setTimeout(() => {
      Docs.search(trimmed, { keywordOnly: true, signal: abort.signal })
        .then((r) => {
          if (!current || hybridShown) return;
          keywordShown = true;
          show(r.results, false);
        })
        // The hybrid search reports a failure.
        .catch(() => {});
    }, KEYWORD_DELAY_MS);
    const hybrid = setTimeout(() => {
      Docs.search(trimmed, { signal: abort.signal })
        .then((r) => {
          if (!current) return;
          hybridShown = true;
          show(r.results, r.degraded);
          const n = Math.min(r.results.length, DOC_HITS);
          announce(t("shell.palette.found", { count: n }));
        })
        // With keyword hits on screen, a failed second pass leaves them be.
        .catch(() => current && !keywordShown && setDocSearch({ status: "error" }));
    }, HYBRID_DELAY_MS);
    return () => {
      current = false;
      abort.abort();
      clearTimeout(keyword);
      clearTimeout(hybrid);
    };
  }, [trimmed, open, searchRun, announce]);

  const actions = useMemo<Action[]>(() => {
    const create = t("shell.palette.hintCreate");
    const navigate = t("shell.palette.hintNavigate");
    return [
      ...(isGuest
        ? []
        : [
          action("shell.palette.newDocument", {
            id: "new-doc",
            hint: create,
            icon: <FilePlus size={16} />,
            run: async () => {
              // No title: the page shows "Untitled" until the first line or a rename names it.
              const d = await Docs.create("");
              nav(`/doc/${d.doc_id}`, { state: { focusEditor: true } });
            },
          }),
          action("shell.palette.newDatabase", {
            id: "new-database",
            hint: create,
            icon: <Database size={16} />,
            terms: ["table", "grid", "rows", "spreadsheet"],
            // The palette has no folder context, so what it creates lands at the top level.
            run: async () => {
              const d = await Docs.create("", undefined, "database");
              nav(`/doc/${d.doc_id}`);
            },
          }),
          action("shell.palette.newFolder", {
            id: "new-folder",
            hint: create,
            icon: <FolderPlus size={16} />,
            run: () => setShowNewFolder(true),
          }),
          action("shell.palette.importMarkdown", {
            id: "import-markdown",
            hint: create,
            icon: <FileUp size={16} />,
            run: () => setShowImport(true),
          }),
        ]),
      action("shell.palette.ask", {
        id: "ask",
        hint: navigate,
        icon: <Sparkles size={16} />,
        run: () => nav("/ask"),
      }),
      action("common.allDocuments", {
        id: "home",
        hint: navigate,
        icon: <Files size={16} />,
        terms: ["home", "my documents", "library"],
        run: () => nav("/"),
      }),
      action("common.yourAiAgents", {
        id: "agents",
        hint: navigate,
        icon: <Plug size={16} />,
        terms: ["agents", "connect", "mcp", "claude", "codex", "antigravity", "subscription"],
        run: () => nav("/settings/agents"),
      }),
      action("common.reviewAiEdits", {
        id: "review",
        hint: navigate,
        icon: <ListChecks size={16} />,
        terms: ["inbox", "runs", "proposals", "approve", "pending", "agent edits"],
        run: () => nav("/review"),
      }),
      action("common.settings", {
        id: "settings",
        hint: navigate,
        icon: <Settings size={16} />,
        terms: ["preferences", "account", "profile", "name", "avatar", "email"],
        run: () => nav("/settings/profile"),
      }),
      action("shell.palette.appearance", {
        id: "appearance",
        hint: navigate,
        icon: <Palette size={16} />,
        terms: ["theme", "dark mode", "light mode", "colour", "color"],
        run: () => nav("/settings/appearance"),
      }),
      action("shell.shortcuts.title", {
        id: "shortcuts",
        icon: <Keyboard size={16} />,
        terms: ["keys", "hotkeys", "keyboard", "help"],
        run: openKeyboardShortcuts,
      }),
      action("shell.palette.workspaceSettings", {
        id: "workspace-settings",
        hint: navigate,
        icon: <SlidersHorizontal size={16} />,
        terms: ["rename workspace", "default access", "delete workspace", "tenant"],
        run: () => nav("/settings/workspace"),
      }),
      action("shell.palette.members", {
        id: "workspace-members",
        hint: navigate,
        icon: <Users size={16} />,
        terms: ["invite", "invite people", "people", "team", "roles", "remove member"],
        run: () => nav("/settings/workspace/members"),
      }),
      ...(canSeeLedger
        ? [
            action("shell.palette.auditLog", {
              id: "audit-log",
              hint: navigate,
              icon: <ScrollText size={16} />,
              terms: ["history", "who did what", "audit", "ledger"],
              run: () => nav("/settings/workspace/audit"),
            }),
            action("shell.palette.aiUsage", {
              id: "ai-usage",
              hint: navigate,
              icon: <Gauge size={16} />,
              terms: ["tokens", "usage", "spend", "cost"],
              run: () => nav("/settings/workspace/usage"),
            }),
          ]
        : []),
      ...(isNodeAdmin
        ? [
            action("shell.palette.nodeSettings", {
              id: "node-settings",
              hint: navigate,
              icon: <Server size={16} />,
              terms: ["model", "provider", "api key", "embedding", "branding", "smtp", "admin", "machine"],
              run: () => nav("/settings/node"),
            }),
          ]
        : []),
    ];
  }, [nav, canSeeLedger, isNodeAdmin, isGuest]);

  const needle = trimmed.toLowerCase();
  const filteredActions = useMemo(() => actions.filter((a) => matchesAction(a, needle)), [actions, needle]);
  const shownHits = docSearch.status === "done" || docSearch.status === "loading" ? docSearch.hits : [];
  // A row's page is offered under its database, as on the results page.
  const parentsVersion = usePageParents([...shownHits, ...recent].map((d) => d.page_of));
  const recentCmds = useMemo<Cmd[]>(
    () =>
      trimmed
        ? []
        : recent.map((d) => ({
            id: `recent-${d.doc_id}`,
            label: (
              <span className="bidi-line">
                {d.page_of && <span className="cmdk-parent">{pageParentLabel(d.page_of)} › </span>}
                {d.title || t("common.untitled")}
              </span>
            ),
            icon: d.doc_type === "database" ? <Database size={16} /> : <FileText size={16} />,
            run: () => nav(`/doc/${d.doc_id}`),
          })),
    [recent, trimmed, nav, parentsVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const docCmds = useMemo<Cmd[]>(() => {
    const terms = queryTerms(trimmed);
    return shownHits.map((d) => ({
      id: `doc-${d.doc_id}`,
      label: (
        <span className="bidi-line">
          {d.page_of && <span className="cmdk-parent">{pageParentLabel(d.page_of)} › </span>}
          <Marked parts={markTerms(d.title || t("common.untitled"), terms)} />
        </span>
      ),
      description:
        d.snippet || foundByMeaning(d, trimmed) ? (
          <HitDescription hit={d} query={trimmed} lead={SNIPPET_LEAD} className="cmdk-snippet" />
        ) : undefined,
      // When it last changed, which tells two hits with one title apart.
      hint: <time dateTime={d.updated_at} title={absoluteTime(d.updated_at)}>{relativeTime(d.updated_at)}</time>,
      icon: d.doc_type === "database" ? <Database size={16} /> : <FileText size={16} />,
      // Opens at the passage that matched. Offered hits always answer `trimmed`, never an earlier query.
      // A fresh `jump` lands again on the passage already open, whose URL is unchanged (see CitationJump).
      run: () => nav(hitHref(d.doc_id, d, trimmed), { state: { jump: Date.now() } }),
    }));
  }, [shownHits, trimmed, nav, parentsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = useMemo<Cmd[]>(
    () =>
      docSearch.status === "error"
        ? [
            {
              id: "retry-search",
              label: t("shell.palette.searchAgain"),
              icon: <RotateCw size={16} />,
              keepsOpen: true,
              run: () => setSearchRun((n) => n + 1),
            },
          ]
        : [],
    [docSearch.status],
  );
  // Last, below the hits it goes beyond.
  const searchAll = useMemo<Cmd[]>(() => {
    if (!trimmed) return [];
    const sp = new URLSearchParams(libraryParams ?? "");
    sp.set("q", trimmed);
    return [
      {
        id: "search-all",
        label: <span className="bidi-line">{t("shell.palette.searchAll", { query: trimmed })}</span>,
        icon: <Search size={16} />,
        run: () => nav(`/?${sp}`),
      },
    ];
  }, [trimmed, libraryParams, nav]);
  const isLoading = docSearch.status === "loading";
  // Hits left over from the previous query are shown, not offered.
  const offeredDocs = isLoading ? [] : docCmds;
  const docItems = useMemo(() => [...offeredDocs, ...retry, ...searchAll], [offeredDocs, retry, searchAll]);
  // Stable unless its content changes: the highlight effect below keys off it.
  const all = useMemo(() => [...recentCmds, ...filteredActions, ...docItems], [recentCmds, filteredActions, docItems]);

  // The highlight stays on a command that survived a list change, else returns to the top.
  useEffect(() => {
    setActiveId((cur) => (cur !== null && all.some((c) => c.id === cur) ? cur : null));
  }, [all]);

  const activeIndex = Math.max(
    0,
    all.findIndex((c) => c.id === activeId),
  );
  // Focus stays in the input; the highlighted row is its active descendant, so a screen reader follows the arrows.
  const listId = useId();
  const optionId = (c: Cmd) => `${listId}-${c.id}`;
  const activeOptionId = all[activeIndex] ? optionId(all[activeIndex]) : undefined;
  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  async function run(cmd: Cmd | undefined) {
    if (!cmd) return;
    if (!cmd.keepsOpen) setOpen(false);
    try {
      await cmd.run();
    } catch (e) {
      toast({ body: errorMessage(e, t("shell.palette.runFailed")), type: "error" });
    }
  }

  const option = (c: Cmd) => {
    const i = all.indexOf(c);
    return (
      <Item
        as="div"
        key={c.id}
        role="option"
        id={optionId(c)}
        aria-selected={i === activeIndex}
        density="compact"
        align={c.description ? "start" : "center"}
        startContent={c.icon}
        label={typeof c.label === "string" ? <span className="bidi-line">{c.label}</span> : c.label}
        description={c.description}
        descriptionLines={2}
        isHighlighted={i === activeIndex}
        endContent={c.hint ? <Text type="supporting" color="secondary">{c.hint}</Text> : undefined}
        onClick={() => void run(c)}
      />
    );
  };

  let docStatus: string | null = null;
  if (docSearch.status === "loading" && docCmds.length === 0) docStatus = t("shell.palette.searching");
  else if (docSearch.status === "done" && docSearch.hits.length === 0) docStatus = t("shell.palette.noMatch");
  else if (docSearch.status === "done" && docSearch.degraded) docStatus = t("shell.palette.degraded");
  else if (docSearch.status === "error") docStatus = t("shell.palette.searchFailed");

  return (
    <>
      {/* `position` turns off the dialog's centring, so the start offset is half its width; on a
          narrow screen, where the dialog shrinks to the window less a margin, it is that margin. */}
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        purpose="info"
        width={640}
        position={{ top: "12vh", start: PALETTE_START }}
        aria-label={t("shell.palette.input")}
      >
        <div className="cmdk">
          <TextInput
            label={t("shell.palette.input")}
            isLabelHidden
            hasAutoFocus
            // Typing replaces the query it reopened with.
            onFocus={selectOnFocus}
            placeholder={t("shell.palette.placeholder")}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={all.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeOptionId}
            value={q}
            onChange={(v) => {
              setQ(v);
              setActiveId(null);
            }}
            onKeyDown={(e: React.KeyboardEvent) => {
              // Enter confirms an input method's composition, not a command.
              if (isComposingKey(e)) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveId(all[Math.min(activeIndex + 1, all.length - 1)]?.id ?? null);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveId(all[Math.max(activeIndex - 1, 0)]?.id ?? null);
              } else if (e.key === "Enter") {
                e.preventDefault();
                void run(e.metaKey || e.ctrlKey ? (searchAll[0] ?? all[activeIndex]) : all[activeIndex]);
              }
            }}
          />
          <div className="cmdk-list" id={listId} role="listbox" aria-label={t("shell.palette.results")} aria-busy={isLoading}>
            {trimmed ? (
              <>
                {filteredActions.length > 0 && (
                  <CommandPaletteGroup heading={t("shell.palette.actions")}>{filteredActions.map(option)}</CommandPaletteGroup>
                )}
                <CommandPaletteGroup heading={t("shell.palette.documents")}>
                  {isLoading &&
                    docCmds.map((c) => (
                      <Item
                        as="div"
                        key={c.id}
                        aria-hidden
                        className="cmdk-stale"
                        density="compact"
                        align="start"
                        startContent={c.icon}
                        label={c.label}
                        description={c.description}
                        descriptionLines={2}
                      />
                    ))}
                  {offeredDocs.map(option)}
                  {docStatus && (
                    <Text type="supporting" color="secondary" className="cmdk-status">
                      {docStatus}
                    </Text>
                  )}
                  {[...retry, ...searchAll].map(option)}
                </CommandPaletteGroup>
              </>
            ) : recentCmds.length > 0 ? (
              <>
                <CommandPaletteGroup heading={t("shell.palette.recent")}>{recentCmds.map(option)}</CommandPaletteGroup>
                <CommandPaletteGroup heading={t("shell.palette.actions")}>{filteredActions.map(option)}</CommandPaletteGroup>
              </>
            ) : (
              filteredActions.map(option)
            )}
          </div>
          <CommandPaletteFooter className="cmdk-footer">
            <span className="cmdk-hint">
              <KeyHint keys="up" spoken={t("shell.palette.keyUp")} />
              <KeyHint keys="down" spoken={t("shell.palette.keyDown")} />
              {t("shell.palette.keyMove")}
            </span>
            <span className="cmdk-hint">
              <KeyHint keys="enter" spoken={t("shell.palette.keyEnter")} />
              {t("common.open")}
            </span>
            {trimmed && (
              <span className="cmdk-hint">
                <KeyHint keys="mod+enter" spoken={t("shell.palette.keyModEnter", { mod: isMac() ? "mac" : "other" })} />
                {t("shell.palette.keySearchAll")}
              </span>
            )}
            <span className="cmdk-hint">
              <KeyHint keys="esc" spoken={t("shell.palette.keyEscape")} />
              {t("common.close")}
            </span>
          </CommandPaletteFooter>
        </div>
      </Dialog>
      <NewFolderDialog
        isOpen={showNewFolder}
        onSubmit={async (title) => {
          try {
            await Folders.create(title, null);
          } catch (e) {
            toast({ body: errorMessage(e, t("shell.palette.folderFailed")), type: "error" });
            return;
          }
          nav("/");
        }}
        onClose={() => setShowNewFolder(false)}
      />
      <ImportMarkdownDialog
        isOpen={showImport}
        parentId={null}
        onImported={(docs, complete) => {
          // After a partial failure the dialog stays open to list what failed.
          if (complete && docs[0]) nav(`/doc/${docs[0].doc_id}`);
        }}
        onClose={() => setShowImport(false)}
      />
    </>
  );
}
