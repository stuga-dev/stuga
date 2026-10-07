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
import { Kbd } from "@astryxdesign/core/Kbd";
import { CommandPaletteFooter, CommandPaletteGroup } from "@astryxdesign/core/CommandPalette";
import { useAnnounce } from "@astryxdesign/core/hooks";
import { useToast } from "@astryxdesign/core/Toast";
import { NewFolderDialog } from "../../library/NewFolderDialog";
import { ImportMarkdownDialog } from "../../library/ImportMarkdownDialog";
import {
  Database,
  FilePlus,
  FileText,
  FileUp,
  Files,
  FolderPlus,
  Gauge,
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
import { Marked, Snippet, hitHref, markTerms, queryTerms } from "../../lib/snippet";
import { forgetRecentDoc, recentDocIds } from "../../lib/recent-docs";
import { getActiveWorkspace } from "../../lib/session/workspace-pointer";

interface Cmd {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  hint?: string;
  icon: ReactNode;
  /** Words it matches besides its label. */
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

/** While loading, the previous query's hits stay on screen, dimmed and out of reach of Enter. */
type DocSearch =
  | { status: "idle" }
  | { status: "loading"; hits: SearchResult[] }
  | { status: "done"; hits: SearchResult[]; degraded: boolean }
  | { status: "error" };

type Action = Cmd & { label: string };

/** An action matches where one of its words, or its terms' words, starts with the query. */
function matchesAction(cmd: Action, needle: string): boolean {
  return [cmd.label, ...(cmd.terms ?? [])].some((t) => {
    const hay = t.toLowerCase();
    return hay.startsWith(needle) || hay.includes(` ${needle}`);
  });
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
  useEffect(() => {
    let alive = true;
    Me.whoami()
      .then((me) => alive && setIsNodeAdmin(me.node_admin))
      .catch(() => {});
    Workspaces.list()
      .then(({ workspaces, active }) => {
        const role = workspaces.find((w) => w.workspace_id === active)?.role;
        if (alive) setCanSeeLedger(role === "owner" || role === "admin");
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

  useEffect(() => {
    if (open) {
      setQ(liveQuery);
      setActiveId(null);
    }
  }, [open, liveQuery]);

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
          announce(n ? `${n} documents found` : "No documents found");
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

  const actions = useMemo<Action[]>(
    () => [
      {
        id: "new-doc",
        label: "New document",
        hint: "Create",
        icon: <FilePlus size={16} />,
        run: async () => {
          const d = await Docs.create("Untitled");
          nav(`/doc/${d.doc_id}`, { state: { focusEditor: true } });
        },
      },
      {
        id: "new-database",
        label: "New database",
        hint: "Create",
        icon: <Database size={16} />,
        terms: ["table", "grid", "rows", "spreadsheet"],
        // The palette has no folder context, so what it creates lands at the top level.
        run: async () => {
          const d = await Docs.create("Untitled", undefined, "database");
          nav(`/doc/${d.doc_id}`);
        },
      },
      {
        id: "new-folder",
        label: "New folder",
        hint: "Create",
        icon: <FolderPlus size={16} />,
        run: () => setShowNewFolder(true),
      },
      {
        id: "import-markdown",
        label: "Import from Markdown",
        hint: "Create",
        icon: <FileUp size={16} />,
        run: () => setShowImport(true),
      },
      {
        id: "ask",
        label: "Ask your documents",
        hint: "Navigate",
        icon: <Sparkles size={16} />,
        run: () => nav("/ask"),
      },
      {
        id: "home",
        label: "All documents",
        hint: "Navigate",
        icon: <Files size={16} />,
        terms: ["home", "my documents", "library"],
        run: () => nav("/"),
      },
      {
        id: "agents",
        label: "Your AI agents",
        hint: "Navigate",
        icon: <Plug size={16} />,
        terms: ["agents", "connect", "mcp", "claude", "codex", "antigravity", "subscription"],
        run: () => nav("/settings/agents"),
      },
      {
        id: "review",
        label: "Review AI edits",
        hint: "Navigate",
        icon: <ListChecks size={16} />,
        terms: ["inbox", "runs", "proposals", "approve", "pending", "agent edits"],
        run: () => nav("/review"),
      },
      {
        id: "settings",
        label: "Settings",
        hint: "Navigate",
        icon: <Settings size={16} />,
        terms: ["preferences", "account", "profile", "name", "avatar", "email"],
        run: () => nav("/settings/profile"),
      },
      {
        id: "appearance",
        label: "Appearance",
        hint: "Navigate",
        icon: <Palette size={16} />,
        terms: ["theme", "dark mode", "light mode", "colour", "color"],
        run: () => nav("/settings/appearance"),
      },
      {
        id: "workspace-settings",
        label: "Workspace settings",
        hint: "Navigate",
        icon: <SlidersHorizontal size={16} />,
        terms: ["rename workspace", "default access", "delete workspace", "tenant"],
        run: () => nav("/settings/workspace"),
      },
      {
        id: "workspace-members",
        label: "Members",
        hint: "Navigate",
        icon: <Users size={16} />,
        terms: ["invite", "invite people", "people", "team", "roles", "remove member"],
        run: () => nav("/settings/workspace/members"),
      },
      ...(canSeeLedger
        ? [
            {
              id: "audit-log",
              label: "Audit log",
              hint: "Navigate",
              icon: <ScrollText size={16} />,
              terms: ["history", "who did what", "audit", "ledger"],
              run: () => nav("/settings/workspace/audit"),
            },
            {
              id: "ai-usage",
              label: "AI usage",
              hint: "Navigate",
              icon: <Gauge size={16} />,
              terms: ["tokens", "usage", "spend", "cost"],
              run: () => nav("/settings/workspace/usage"),
            },
          ]
        : []),
      ...(isNodeAdmin
        ? [
            {
              id: "node-settings",
              label: "Node settings",
              hint: "Navigate",
              icon: <Server size={16} />,
              terms: ["model", "provider", "api key", "embedding", "branding", "smtp", "admin", "machine"],
              run: () => nav("/settings/node"),
            },
          ]
        : []),
    ],
    [nav, canSeeLedger, isNodeAdmin],
  );

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
                {d.title || "Untitled"}
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
          <Marked parts={markTerms(d.title || "Untitled", terms)} />
        </span>
      ),
      description: d.snippet ? <Snippet text={d.snippet} lead={SNIPPET_LEAD} className="cmdk-snippet" /> : undefined,
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
              label: "Search again",
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
        label: <span className="bidi-line">Search all documents for “{trimmed}”</span>,
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
      toast({ body: errorMessage(e, "That didn’t work. Please try again."), type: "error" });
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
  if (docSearch.status === "loading" && docCmds.length === 0) docStatus = "Searching…";
  else if (docSearch.status === "done" && docSearch.hits.length === 0) docStatus = "No documents match.";
  else if (docSearch.status === "done" && docSearch.degraded) docStatus = "Matching words only: semantic search is unavailable.";
  else if (docSearch.status === "error") docStatus = "Couldn’t search documents.";

  return (
    <>
      {/* `position` turns off the dialog's centring, so the start offset is half its width. */}
      <Dialog isOpen={open} onOpenChange={setOpen} purpose="info" width={640} position={{ top: "12vh", start: "calc(50% - 320px)" }}>
        <div className="cmdk">
          <TextInput
            label="Search documents or run a command"
            isLabelHidden
            hasAutoFocus
            placeholder="Search documents or run a command…"
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
              if (e.nativeEvent.isComposing) return;
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
          <div className="cmdk-list" id={listId} role="listbox" aria-label="Results" aria-busy={isLoading}>
            {trimmed ? (
              <>
                {filteredActions.length > 0 && (
                  <CommandPaletteGroup heading="Actions">{filteredActions.map(option)}</CommandPaletteGroup>
                )}
                <CommandPaletteGroup heading="Documents">
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
                <CommandPaletteGroup heading="Recent">{recentCmds.map(option)}</CommandPaletteGroup>
                <CommandPaletteGroup heading="Actions">{filteredActions.map(option)}</CommandPaletteGroup>
              </>
            ) : (
              filteredActions.map(option)
            )}
          </div>
          <CommandPaletteFooter className="cmdk-footer">
            <span className="cmdk-hint">
              <Kbd keys="up" />
              <Kbd keys="down" />
              Move
            </span>
            <span className="cmdk-hint">
              <Kbd keys="enter" />
              Open
            </span>
            {trimmed && (
              <span className="cmdk-hint">
                <Kbd keys="mod+enter" />
                Search all
              </span>
            )}
            <span className="cmdk-hint">
              <Kbd keys="esc" />
              Close
            </span>
          </CommandPaletteFooter>
        </div>
      </Dialog>
      <NewFolderDialog
        isOpen={showNewFolder}
        onSubmit={async (title, instructions) => {
          try {
            await Folders.create(title, null, instructions);
          } catch (e) {
            toast({ body: errorMessage(e, "Couldn’t create that folder."), type: "error" });
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
