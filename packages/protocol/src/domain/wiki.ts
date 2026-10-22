/**
 * The wiki a workspace's pages make, as the node answers about it: what links to a page and what it
 * cites that changed since, the Index, the Log of decided AI changes, and the check. Every answer is
 * one reader's: it names and counts only pages, folders and changes that reader can open.
 */

/**
 * Who changed or decided something, as the wiki names them: a person by their name; an agent, or the
 * AI co-author in someone's panel, by the person it worked for (`name`); the sample workspaces' agent,
 * which works for nobody, by its own name.
 */
export interface AuthorRef {
  kind: "person" | "agent" | "coauthor" | "sample";
  name: string;
}

/** How a page names another: a link in its text, or a footnote citing it. */
export type WikiLinkKind = "link" | "citation";

/** A page the reader opens that links to or cites the page asked about. */
export interface LinkingPageEntry {
  doc_id: string;
  title: string;
  doc_type: "prose" | "database";
  kinds: WikiLinkKind[];
  /** Its folders, root first: [] at the top level, null in a folder the reader cannot open. */
  path: string[] | null;
}

/** A page another cites, which the reader opens, whose text changed after the citing passages were approved. */
export interface ChangedSource {
  doc_id: string;
  title: string;
  changed_at: string;
}

/** `GET /api/docs/:id/links`. */
export interface DocWikiLinks {
  linked_from: LinkingPageEntry[];
  /** More pages the reader opens link to it than are listed. */
  linked_from_truncated: boolean;
  /** What it cites that changed since: it needs checking. */
  needs_checking: ChangedSource[];
  /** The reader may mark it checked: a person who can edit it, when something needs checking. */
  can_mark_checked: boolean;
}

export interface IndexEntry {
  doc_id: string;
  title: string;
  doc_type: "prose" | "database";
  /** Its opening paragraph, plain and short. */
  summary: string;
  /** When its approved text last changed, and who changed it then. */
  changed_at: string;
  changed_by: AuthorRef[];
  needs_checking: boolean;
}

export interface IndexSection {
  /** null for the top level, and for pages in folders the reader cannot open (`elsewhere`). */
  folder_id: string | null;
  /** The folder's path, root first; "…" stands for a folder above it the reader cannot open. */
  path: string[];
  /** In the reader's own My notes. */
  my_notes?: true;
  /** Pages shared with the reader whose folder they cannot open. */
  elsewhere?: true;
  pages: IndexEntry[];
}

/** `GET /api/wiki/index`. */
export interface WikiIndex {
  sections: IndexSection[];
  /** More pages than one index lists: read it a folder at a time. */
  truncated: boolean;
}

export interface LogPage {
  doc_id: string;
  title: string;
  doc_kind: "prose" | "database";
  run_id: string;
  approved: number;
  declined: number;
  /** Applied at once, where AI edits apply directly. */
  applied: number;
  reverted: boolean;
}

export type LogOutcome = "approved" | "declined" | "partly" | "applied" | "reverted";

export interface WikiLogEntry {
  /** A change, one piece of work across pages; or a run, one page's, in none. */
  kind: "change" | "run";
  id: string;
  /** The change's title, for whoever asked for it or decided some of it; otherwise null. */
  title: string | null;
  /** When it was last decided. */
  at: string;
  outcome: LogOutcome;
  /** The person who asked the AI. */
  asked_by: AuthorRef | null;
  /** The AI, as the run records it. */
  agent: { name: string; alias: string; client: string | null; source: string };
  /** Who approved or declined its changes. */
  decided_by: AuthorRef[];
  /** Its pages the reader opens. */
  pages: LogPage[];
}

/** `GET /api/wiki/log`. */
export interface WikiLog {
  entries: WikiLogEntry[];
  /** Pass as `before` for the entries older than these; null at the end. */
  next: string | null;
}

export interface LintPage {
  doc_id: string;
  title: string;
  path: string[] | null;
}

export interface LintBrokenLink {
  /** The address as the page's text writes it, so it can be found there. */
  href: string;
  kind: WikiLinkKind;
  /** `in_trash`: a page the reader opens is in the trash; `not_found`: it is gone, or not one the reader can open. */
  reason: "in_trash" | "not_found";
  /** The page's title, for one in the trash. */
  title?: string;
}

/** `GET /api/wiki/lint`. */
export interface WikiLint {
  /** Pages citing a page that changed after they were approved. */
  needs_checking: Array<LintPage & { sources: ChangedSource[] }>;
  /** Pages in a folder that no other page the reader opens links to. */
  orphans: LintPage[];
  broken_links: Array<LintPage & { links: LintBrokenLink[] }>;
  /** Some list holds more than one check returns: check a folder at a time. */
  truncated: boolean;
}
