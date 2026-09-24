/**
 * The ⌘K palette: search documents and run quick actions. Mounted once inside
 * the router; the open flag lives in CommandPaletteProvider so a page's search
 * control can open it. Document hits are a preview of six; "Search all
 * documents" hands the query to the library.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Docs, Folders, Me, Workspaces, type SearchResult } from "../../api";
import { pageParentLabel, usePageParents } from "../../database/model/row-ref";
import { useCommandPalette } from "./context";
import { Dialog } from "@astryxdesign/core/Dialog";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Item } from "@astryxdesign/core/Item";
import { Text } from "@astryxdesign/core/Text";
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
  ScrollText,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Users, ListChecks } from "lucide-react";
import { errorMessage } from "../../lib/http/client";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  /** Words it matches besides its label. */
  terms?: string[];
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const { isOpen: open, setOpen } = useCommandPalette();
  const [q, setQ] = useState("");
  const [docs, setDocs] = useState<SearchResult[]>([]);
  /**
   * The highlighted command by id, not position: debounced document hits land
   * above "Search all documents" and would shift an index under a pending Enter.
   * Null is the top of the list.
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

  useEffect(() => {
    if (!open || !q.trim()) {
      setDocs([]);
      return;
    }
    const t = setTimeout(() => {
      Docs.search(q).then((r) => setDocs(r.results.slice(0, 6))).catch(() => setDocs([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const actions = useMemo<Cmd[]>(
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
        label: "Your own AI",
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

  const needle = q.toLowerCase();
  const filteredActions = useMemo(
    () =>
      actions.filter(
        (a) => a.label.toLowerCase().includes(needle) || (a.terms ?? []).some((t) => t.includes(needle)),
      ),
    [actions, needle],
  );
  // A row's page is offered under its database, as on the results page.
  const parentsVersion = usePageParents(docs.map((d) => d.page_of));
  const docCmds = useMemo<Cmd[]>(
    () =>
      docs.map((d) => ({
        id: `doc-${d.doc_id}`,
        label: d.page_of ? `${pageParentLabel(d.page_of)} › ${d.title || "Untitled"}` : d.title || "Untitled",
        hint: "Open",
        icon: <FileText size={16} />,
        run: () => nav(`/doc/${d.doc_id}`),
      })),
    [docs, nav, parentsVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Last, below the hits it goes beyond.
  const trimmed = q.trim();
  const searchAll = useMemo<Cmd[]>(() => {
    if (!trimmed) return [];
    const sp = new URLSearchParams(libraryParams ?? "");
    sp.set("q", trimmed);
    return [
      {
        id: "search-all",
        label: `Search all documents for “${trimmed}”`,
        hint: "Search",
        icon: <Search size={16} />,
        run: () => nav(`/?${sp}`),
      },
    ];
  }, [trimmed, libraryParams, nav]);
  // Stable unless its content changes: the highlight effect below keys off it.
  const all = useMemo(() => [...filteredActions, ...docCmds, ...searchAll], [filteredActions, docCmds, searchAll]);

  // The highlight stays on a command that survived a list change, else returns to the top.
  useEffect(() => {
    setActiveId((cur) => (cur !== null && all.some((c) => c.id === cur) ? cur : (all[0]?.id ?? null)));
  }, [all]);

  const activeIndex = Math.max(
    0,
    all.findIndex((c) => c.id === activeId),
  );
  // Focus stays in the input; the highlighted row is its active descendant, so a screen reader follows the arrows.
  const listId = useId();
  const optionId = (c: Cmd) => `${listId}-${c.id}`;

  async function runAt(i: number) {
    const cmd = all[i];
    if (!cmd) return;
    setOpen(false);
    await cmd.run();
  }

  return (
    <>
      {/* `position` turns off the dialog's centring, so the start offset is half its width. */}
      <Dialog isOpen={open} onOpenChange={setOpen} purpose="info" width={560} position={{ top: "12vh", start: "calc(50% - 280px)" }}>
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
            aria-activedescendant={all[activeIndex] ? optionId(all[activeIndex]) : undefined}
            value={q}
            onChange={(v) => {
              setQ(v);
              setActiveId(null);
            }}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveId(all[Math.min(activeIndex + 1, all.length - 1)]?.id ?? null);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveId(all[Math.max(activeIndex - 1, 0)]?.id ?? null);
              } else if (e.key === "Enter") {
                e.preventDefault();
                void runAt(activeIndex);
              }
            }}
          />
          <div className="cmdk-list" id={listId} role="listbox" aria-label="Results">
            {all.map((c, i) => (
              <Item
                as="div"
                key={c.id}
                role="option"
                id={optionId(c)}
                density="compact"
                startContent={c.icon}
                label={c.label}
                isHighlighted={i === activeIndex}
                endContent={c.hint ? <Text type="supporting" color="secondary">{c.hint}</Text> : undefined}
                onClick={() => void runAt(i)}
              />
            ))}
          </div>
          {all.length === 0 && <div className="cmdk-empty">No results.</div>}
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
