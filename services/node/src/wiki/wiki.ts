/**
 * The wiki as one caller reads it: the pages linking to a page and the pages it cites that changed
 * since, the Index, the Log of decided AI changes, and the check. The REST routes and the agent tools
 * share these, so a person and their agent read the same wiki; each surface words the names itself.
 * Every read goes through the caller's own access (WikiReader): nothing names, or counts, a page, a
 * folder or a change they cannot open.
 */
import {
  authorRefs,
  brokenLinks,
  getFolderSubtreeIds,
  indexPages,
  logEntries,
  markCitationsChecked,
  orphanPages,
  pagesLinkingTo,
  readableFolders,
  rowLinks,
  staleCitations,
  stalePages,
  type AuthorRef,
  type DocRow,
  type IndexFolder,
  type LogCursor,
  type LogRun,
  type RowLink,
  type WikiReader,
} from "@stuga/db";
import type {
  ChangedSource,
  DocWikiLinks,
  IndexSection,
  LintBrokenLink,
  LintPage,
  LogOutcome,
  LogTable,
  WikiIndex,
  WikiLint,
  WikiLog,
} from "@stuga/protocol/domain/wiki";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canWriteDoc, personOf, scopeFolderIds } from "../authz/authz.js";
import { ROWS_READ_IDS_MAX } from "@stuga/protocol/databases/rows-read";
import { existingRows, readDatabaseRows } from "../databases/rows.js";
import { authorizedFolder } from "../documents/access.js";

/** Stands in a folder path for a folder above that the reader cannot open. */
export const HIDDEN_FOLDER = "…";

export function wikiReader(ctx: Ctx): WikiReader {
  return { workspaceId: ctx.workspaceId, principals: ctx.principals, scopeFolderIds: scopeFolderIds(ctx) };
}

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** Each folder's path as the reader reads it, the folder last; HIDDEN_FOLDER stands for a folder above they cannot open. */
function folderPaths(folders: readonly IndexFolder[]): Map<string, string[]> {
  const byId = new Map(folders.map((f) => [f.folder_id, f]));
  const out = new Map<string, string[]>();
  const pathOf = (id: string, depth: number): string[] => {
    const known = out.get(id);
    if (known) return known;
    const f = byId.get(id)!;
    const path = !f.parent_id || depth > 32 ? [f.title] : byId.has(f.parent_id) ? [...pathOf(f.parent_id, depth + 1), f.title] : [HIDDEN_FOLDER, f.title];
    out.set(id, path);
    return path;
  };
  for (const f of folders) pathOf(f.folder_id, 0);
  return out;
}

/** Where a page sits as the reader reads it: [] at the top level, null in a folder they cannot open. */
function pathOf(paths: Map<string, string[]>, parentId: string | null): string[] | null {
  if (parentId === null) return [];
  return paths.get(parentId) ?? null;
}

/** The folders a check or an index covers: a folder the reader opens and everything under it, or null for all. */
async function folderScope(ctx: Ctx, folderId: string | null | undefined): Promise<{ folderIds: Array<string | null> | null } | { error: string }> {
  if (!folderId) return { folderIds: null };
  const folder = await authorizedFolder(ctx, folderId);
  if (!folder) return { error: "folder not found" };
  const ids = await getFolderSubtreeIds(ctx.sql, folder.folder_id, ctx.workspaceId);
  const scope = scopeFolderIds(ctx);
  return { folderIds: scope ? ids.filter((id) => scope.includes(id)) : ids };
}

const NOT_FOUND = { error: "folder not found" } as const;

// ---- One page -----------------------------------------------------------------------------

/** The wiki around one page the caller opens; `paths: false` for a caller that shows no folder paths. */
export async function docWikiLinks(ctx: Ctx, doc: DocRow, opts: { limit?: number; paths?: boolean } = {}): Promise<DocWikiLinks> {
  const r = wikiReader(ctx);
  const limit = opts.limit ?? 200;
  const [linking, stale, folders] = await Promise.all([
    pagesLinkingTo(ctx.sql, r, doc.doc_id, limit + 1),
    staleCitations(ctx.sql, r, [doc.doc_id]),
    opts.paths === false ? [] : readableFolders(ctx.sql, r),
  ]);
  const paths = folderPaths(folders);
  const needs = stale.map((s) => ({ doc_id: s.source_id, title: s.source_title, changed_at: new Date(s.changed_at).toISOString() }));
  return {
    linked_from: linking.slice(0, limit).map((p) => ({ doc_id: p.doc_id, title: p.title, doc_type: p.doc_type, kinds: p.kinds, path: pathOf(paths, p.parent_id) })),
    linked_from_truncated: linking.length > limit,
    needs_checking: needs,
    can_mark_checked: needs.length > 0 && !ctx.isAgent && canWriteDoc(ctx, doc),
  };
}

/** A person who can edit the page looked again: what it cites that changed counts as approved now. Agents never do. */
export async function markDocChecked(ctx: Ctx, doc: DocRow): Promise<{ marked: number } | { error: string; status: number }> {
  if (ctx.isAgent) return { error: "agents cannot mark a page checked", status: 403 };
  if (!canWriteDoc(ctx, doc)) return { error: "view-only access", status: 403 };
  const marked = await markCitationsChecked(ctx.sql, wikiReader(ctx), doc.doc_id);
  if (marked > 0) {
    recordAudit(ctx, { action: "doc.check", targetKind: "doc", targetId: doc.doc_id, targetLabel: doc.title, detail: { sources: marked } });
  }
  return { marked };
}

// ---- The Index ----------------------------------------------------------------------------

/**
 * Every page the caller opens, by folder: the top level first, then each folder by its path, the caller's own My notes
 * last. An agent's leaves out pages kept out of search, whose opening it would otherwise read, as its session index does.
 */
export async function wikiIndex(ctx: Ctx, opts: { folderId?: string | null; limit: number }): Promise<WikiIndex | { error: string }> {
  const scope = await folderScope(ctx, opts.folderId);
  if ("error" in scope) return NOT_FOUND;
  const r = wikiReader(ctx);
  const [folders, { pages, truncated }] = await Promise.all([
    readableFolders(ctx.sql, r),
    indexPages(ctx.sql, r, { folderIds: scope.folderIds, limit: opts.limit, searchable: ctx.isAgent }),
  ]);
  const refs = await authorRefs(ctx.sql, unique(pages.flatMap((p) => p.changed_by)));
  const paths = folderPaths(folders);
  const mine = new Set(folders.filter((f) => f.home_of === personOf(ctx)).map((f) => f.folder_id));
  const sections = new Map<string, IndexSection>();
  for (const p of pages) {
    const path = pathOf(paths, p.parent_id);
    const key = path === null ? "\u0000elsewhere" : (p.parent_id ?? "");
    let section = sections.get(key);
    if (!section) {
      section =
        path === null
          ? { folder_id: null, path: [], elsewhere: true, pages: [] }
          : { folder_id: p.parent_id, path, ...(p.parent_id && mine.has(p.parent_id) ? { my_notes: true as const } : {}), pages: [] };
      sections.set(key, section);
    }
    section.pages.push({
      doc_id: p.doc_id,
      title: p.title,
      doc_type: p.doc_type,
      summary: p.summary,
      changed_at: new Date(p.changed_at).toISOString(),
      changed_by: p.changed_by.flatMap((a) => {
        const ref = refs.get(a);
        return ref ? [ref] : [];
      }),
      needs_checking: p.needs_checking,
      ...(p.doc_type === "database" && p.row_count !== null ? { row_count: p.row_count } : {}),
    });
  }
  // Top level, folders by path, pages shared from folders the reader cannot open, their own notes.
  const rank = (s: IndexSection) => (s.folder_id === null && !s.elsewhere ? 0 : s.my_notes ? 3 : s.elsewhere ? 2 : 1);
  const ordered = [...sections.values()].sort((a, b) => rank(a) - rank(b) || a.path.join("\u0000").localeCompare(b.path.join("\u0000")));
  return { sections: ordered, truncated };
}

// ---- The Log ------------------------------------------------------------------------------

/** A cursor as a caller passes it back: when the last entry was decided and its id. */
function encodeCursor(c: LogCursor): string {
  return `${Date.parse(c.at)}:${c.entryId}`;
}

export function decodeLogCursor(raw: string | null | undefined): LogCursor | null | "bad" {
  if (!raw) return null;
  const m = /^(\d{1,13}):([A-Za-z0-9_-]{1,80})$/.exec(raw);
  const at = m ? new Date(Number(m[1])) : null;
  if (!m || !at || !Number.isFinite(at.getTime())) return "bad";
  return { at: at.toISOString(), entryId: m[2]! };
}

function outcomeOf(runs: readonly LogRun[]): LogOutcome {
  const live = runs.filter((r) => !r.reverted);
  if (live.length === 0) return "reverted";
  const accepted = live.reduce((n, r) => n + r.accepted, 0);
  const applied = live.reduce((n, r) => n + r.applied, 0);
  const refused = live.reduce((n, r) => n + r.rejected + r.conflicts, 0);
  if (accepted + applied > 0 && refused === 0) return accepted === 0 ? "applied" : "approved";
  if (accepted + applied === 0 && refused > 0) return "declined";
  return "partly";
}

/** Row titles the Log names per table of a run; the rest are counted. */
const LOG_ROWS_NAMED = 5;

/**
 * The tables and rows each database run touched, named as each table reads now, by run id: per database, a read
 * of its tables' names and reads of the rows the runs name. A row since deleted, with no name, or of a change
 * too large to keep its ids, is counted alone; a table since deleted is left out; a database whose actor cannot
 * answer, all of its runs.
 */
async function touchedTables(ctx: Ctx, runs: readonly LogRun[]): Promise<Map<string, LogTable[]>> {
  const out = new Map<string, LogTable[]>();
  const byDb = new Map<string, LogRun[]>();
  for (const r of runs) if (r.doc_kind === "database" && r.touched?.length) byDb.set(r.doc_id, [...(byDb.get(r.doc_id) ?? []), r]);
  await Promise.all(
    [...byDb].map(async ([docId, dbRuns]) => {
      // Every table's name, so a table a large change touched (its row ids kept apart) is still named.
      const names = await readDatabaseRows(ctx, { doc_id: docId }, { titles_only: true, max_rows: 1 });
      if (!names) return;
      const tables = new Map(names.tables.map((t) => [t.table_id, t.display]));
      const refs = dbRuns.flatMap((r) => r.touched!.flatMap((t) => t.row_ids.map((row_id) => ({ table_id: t.table_id, row_id }))));
      const titles = new Map<string, string>();
      for (let i = 0; i < refs.length; i += ROWS_READ_IDS_MAX) {
        const read = await readDatabaseRows(ctx, { doc_id: docId }, { rows: refs.slice(i, i + ROWS_READ_IDS_MAX), titles_only: true });
        if (!read) return;
        for (const t of read.tables) for (const row of t.rows) if (row.title) titles.set(`${t.table_id}.${row.row_id}`, row.title);
      }
      for (const r of dbRuns) {
        out.set(
          r.run_id,
          r.touched!.flatMap((t) => {
            const table = tables.get(t.table_id);
            if (table === undefined) return [];
            // In the order the change touched them.
            const named = t.row_ids.flatMap((id) => titles.get(`${t.table_id}.${id}`) ?? []);
            return [{ table, rows: named.slice(0, LOG_ROWS_NAMED), count: t.rows }];
          }),
        );
      }
    }),
  );
  return out;
}

/** The workspace's decided AI changes the caller can read, newest first. */
export async function wikiLog(ctx: Ctx, opts: { before?: string | null; limit: number }): Promise<WikiLog | { error: string }> {
  const before = decodeLogCursor(opts.before);
  if (before === "bad") return { error: "`before` is not a cursor this log gave" };
  const { entries, next } = await logEntries(ctx.sql, wikiReader(ctx), { before, limit: opts.limit });
  const tables = await touchedTables(ctx, entries.flatMap((e) => e.runs));
  const people = unique(entries.flatMap((e) => e.runs.flatMap((r) => [r.reviewer, ...r.decided_by])));
  const refs = await authorRefs(ctx.sql, people);
  const me = personOf(ctx);
  const named = (alias: string): AuthorRef[] => {
    const ref = refs.get(alias);
    return ref ? [ref] : [];
  };
  return {
    entries: entries.map((e) => {
      const first = e.runs[0]!;
      const deciders = unique(e.runs.flatMap((r) => r.decided_by));
      const change = first.change_id !== null;
      // A change's title is its agent's words to whoever asked and whoever approves, as its card gives them; to an
      // agent, only its own, as no other surface gives an agent another's words.
      const seesTitle = change && (ctx.isAgent ? first.agent_alias === ctx.alias : first.reviewer === me || deciders.includes(me));
      return {
        kind: change ? ("change" as const) : ("run" as const),
        id: e.entry_id,
        title: seesTitle ? first.change_title : null,
        at: e.at,
        outcome: outcomeOf(e.runs),
        asked_by: named(first.reviewer)[0] ?? null,
        agent: { name: first.agent, alias: first.agent_alias, client: first.client, source: first.source },
        decided_by: deciders.flatMap(named),
        pages: e.runs.map((r) => ({
          doc_id: r.doc_id,
          title: r.title,
          doc_kind: r.doc_kind,
          run_id: r.run_id,
          approved: r.accepted,
          declined: r.rejected + r.conflicts,
          applied: r.applied,
          reverted: r.reverted,
          ...(tables.get(r.run_id)?.length ? { tables: tables.get(r.run_id) } : {}),
        })),
      };
    }),
    next: next ? encodeCursor(next) : null,
  };
}

// ---- Checking the wiki --------------------------------------------------------------------

/** Pages to look at again, in a folder the caller opens or the whole workspace, as the caller reads it. */
export async function wikiLint(ctx: Ctx, opts: { folderId?: string | null; limit: number }): Promise<WikiLint | { error: string }> {
  const scope = await folderScope(ctx, opts.folderId);
  if ("error" in scope) return NOT_FOUND;
  const r = wikiReader(ctx);
  const within = { folderIds: scope.folderIds, limit: opts.limit };
  const [folders, stale, orphans, broken, rowsNamed] = await Promise.all([
    readableFolders(ctx.sql, r),
    stalePages(ctx.sql, r, within),
    orphanPages(ctx.sql, r, within),
    brokenLinks(ctx.sql, r, within),
    rowLinks(ctx.sql, r, within),
  ]);
  const paths = folderPaths(folders);
  const needs = new Map<string, ChangedSource[]>();
  for (const c of stale.citations) {
    const list = needs.get(c.doc_id) ?? [];
    list.push({ doc_id: c.source_id, title: c.source_title, changed_at: new Date(c.changed_at).toISOString() });
    needs.set(c.doc_id, list);
  }
  const brokenBy = new Map<string, LintPage & { links: LintBrokenLink[] }>();
  for (const b of broken.links) {
    const page = brokenBy.get(b.doc_id) ?? { doc_id: b.doc_id, title: b.title, path: pathOf(paths, b.parent_id), links: [] };
    page.links.push({
      href: `/doc/${b.target_doc_id}`,
      kind: b.kind,
      reason: b.in_trash ? "in_trash" : "not_found",
      ...(b.in_trash && b.target_title !== null ? { title: b.target_title } : {}),
    });
    brokenBy.set(b.doc_id, page);
  }
  // A link to a row, or a citation of one, in a database the reader opens: broken once the row is gone.
  for (const b of await deletedRows(ctx, rowsNamed.links)) {
    const page = brokenBy.get(b.link.doc_id) ?? { doc_id: b.link.doc_id, title: b.link.title, path: pathOf(paths, b.link.parent_id), links: [] };
    page.links.push({ href: b.href, kind: b.link.kind, reason: "row_deleted", title: b.link.target_title });
    brokenBy.set(b.link.doc_id, page);
  }
  return {
    needs_checking: stale.pages.map((p) => ({ doc_id: p.doc_id, title: p.title, path: pathOf(paths, p.parent_id), sources: needs.get(p.doc_id) ?? [] })),
    orphans: orphans.pages.map((p) => ({ doc_id: p.doc_id, title: p.title, path: pathOf(paths, p.parent_id) })),
    broken_links: [...brokenBy.values()],
    truncated: stale.truncated || orphans.truncated || broken.truncated || rowsNamed.truncated,
  };
}

/**
 * The rows `links` name that are gone from their tables, each with the address a page writes it by: one read
 * per database. A database whose actor cannot answer says nothing is gone, rather than everything.
 */
async function deletedRows(ctx: Ctx, links: readonly RowLink[]): Promise<Array<{ link: RowLink; href: string }>> {
  const byDb = new Map<string, RowLink[]>();
  for (const l of links) byDb.set(l.target_doc_id, [...(byDb.get(l.target_doc_id) ?? []), l]);
  const out: Array<{ link: RowLink; href: string }> = [];
  await Promise.all(
    [...byDb].map(async ([docId, named]) => {
      const refs = [...new Set(named.flatMap((l) => l.target_rows))].flatMap((ref) => {
        const [table_id, row_id] = ref.split(".");
        return table_id && row_id ? [{ table_id, row_id }] : [];
      });
      // A read names at most ROWS_READ_IDS_MAX rows: the rest go in further reads.
      const there = new Map<string, unknown>();
      for (let i = 0; i < refs.length; i += ROWS_READ_IDS_MAX) {
        const found = await existingRows(ctx, docId, refs.slice(i, i + ROWS_READ_IDS_MAX));
        if (!found) return;
        for (const [ref, row] of found) there.set(ref, row);
      }
      for (const l of named) {
        for (const ref of l.target_rows) {
          if (there.has(ref)) continue;
          const [table, row] = ref.split(".");
          out.push({ link: l, href: `/doc/${docId}?table=${table}&row=${row}` });
        }
      }
    }),
  );
  return out.sort((a, b) => a.link.title.localeCompare(b.link.title) || a.link.doc_id.localeCompare(b.link.doc_id) || a.href.localeCompare(b.href));
}
