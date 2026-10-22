/**
 * `GET /api/agent/session-index`: what the Claude Code plugin shows a session as it starts. The
 * wiki pages the connection reaches, by id, title and folder path: never a body. Team pages come
 * first, newest first, the workspaces taking turns, so a hundred of one's own notes never push the
 * team's pages out; the person's own My notes come after them, with rows kept for them, so the
 * team's pages never push them out either. Each workspace says how many of each it holds in all.
 * Behind the same credential as /mcp, so a grant scoped to some workspaces reaches only those and a
 * key confined to some folders only those. Each workspace's read is audited there, one row per
 * connection per minute, by counts alone.
 */
import { countSearchableDocs, getHomeFolder, getFolderSubtreeIds, listDocs, listFolders, type DocRow, type FolderRow } from "@stuga/db";
import { SEARCH_MAX_WORKSPACES } from "@stuga/agent-surface/catalog";
import { AUDIT_DEDUP_MS, noteAuditWindow, recordAudit } from "../audit/record.js";
import { mcpPerson, workspaceContextFor, type Ctx } from "../auth/context.js";
import { canReadFolder, scopeFolderIds } from "../authz/authz.js";
import { json } from "../http/respond.js";
import type { McpCall } from "../http/router.js";
import { reachOf } from "./handler.js";

/** Rows one answer carries at most: the plugin prints what fits its budget, in this order. */
export const SESSION_INDEX_LIMIT = 200;
/** Of those, the rows kept for the person's own notes when they have that many. */
export const SESSION_INDEX_MINE = 40;
/** Documents read from each workspace, newest first: team pages, and the person's own notes apart. */
const PER_WORKSPACE = 500;
const NAME_MAX = 120;
/** A folder above a page that the caller cannot read, named in its path. */
const HIDDEN_FOLDER = "…";

export interface SessionIndexRow {
  workspace_id: string;
  doc_id: string;
  title: string;
  /** "database" for a structured database; a page otherwise. */
  type: "page" | "database";
  /** The folders it is in, from the top. */
  path: string[];
  /** The day it last changed, YYYY-MM-DD. */
  date: string;
  /** In the person's own My notes. */
  mine: boolean;
}

/** One line of text a person wrote, cut to `max`: a title is shown, never followed. */
function field(text: string, max = NAME_MAX): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** Each folder's path from the top, by the titles the caller can read. */
function pathsOf(ctx: Ctx, folders: readonly FolderRow[]): (folderId: string | null) => string[] {
  const byId = new Map(folders.map((f) => [f.folder_id, f]));
  const memo = new Map<string, string[]>();
  const walk = (id: string | null, depth: number): string[] => {
    if (!id || depth > 32) return [];
    const kept = memo.get(id);
    if (kept) return kept;
    const folder = byId.get(id);
    // A folder this listing does not hold is one the caller cannot read; above it, nothing is named.
    const path = folder ? [...walk(folder.parent_id, depth + 1), canReadFolder(ctx, folder) ? field(folder.title) : HIDDEN_FOLDER] : [HIDDEN_FOLDER];
    memo.set(id, path);
    return path;
  };
  return (id) => walk(id, 0);
}

/** Round by round, a row from each list in turn while it has one, up to `max`. */
function interleave<T>(lists: readonly T[][], max: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < max && lists.some((rows) => i < rows.length); i++) {
    for (const rows of lists) {
      const row = rows[i];
      if (row !== undefined && out.length < max) out.push(row);
    }
  }
  return out;
}

interface WorkspaceIndex {
  workspace_id: string;
  name: string;
  team: SessionIndexRow[];
  mine: SessionIndexRow[];
  myNotes: string | null;
  /** How many of each the caller can read there in all, listed or not. */
  counts: { team: number; mine: number };
}

async function indexWorkspace(call: McpCall, workspaceId: string, name: string): Promise<WorkspaceIndex | null> {
  const ctx = await workspaceContextFor(call.caller, workspaceId);
  if (!ctx) return null;
  const scope = scopeFolderIds(ctx);
  const [folders, home] = await Promise.all([
    listFolders(ctx.sql, ctx.principals, workspaceId, undefined, { scopeFolderIds: scope }),
    getHomeFolder(ctx.sql, workspaceId, mcpPerson(call.caller)),
  ]);
  // The folders of the person's own notes; what the caller lists of them is still its own reach.
  const notes = home ? await getFolderSubtreeIds(ctx.sql, home.folder_id, workspaceId) : [];
  const inNotes = new Set(notes);
  const mineScope = scope ? notes.filter((id) => scope.includes(id)) : notes;
  // What search leaves out, the index does too.
  const listing = { sort: "updated_at", order: "desc", limit: PER_WORKSPACE, searchable: true } as const;
  const [teamDocs, mineDocs, counts] = await Promise.all([
    listDocs(ctx.sql, ctx.principals, workspaceId, { ...listing, scopeFolderIds: scope, notInFolders: notes }),
    mineScope.length > 0 ? listDocs(ctx.sql, ctx.principals, workspaceId, { ...listing, scopeFolderIds: mineScope }) : Promise.resolve([]),
    countSearchableDocs(ctx.sql, ctx.principals, workspaceId, { scopeFolderIds: scope, split: notes }),
  ]);
  const pathOf = pathsOf(ctx, folders);
  const row = (d: DocRow): SessionIndexRow => ({
    workspace_id: workspaceId,
    doc_id: d.doc_id,
    title: field(d.title) || "Untitled",
    type: d.doc_type === "database" ? "database" : "page",
    path: pathOf(d.parent_id),
    date: new Date(d.updated_at).toISOString().slice(0, 10),
    mine: d.parent_id !== null && inNotes.has(d.parent_id),
  });
  const team = teamDocs.map(row);
  const mine = mineDocs.map(row);
  // Every session start reads the index again, so one row per connection per workspace per window stands for its repeats.
  if (noteAuditWindow(JSON.stringify(["mcp.session_index", workspaceId, ctx.alias]))) {
    recordAudit(ctx, { action: "mcp.session_index", detail: { docs: team.length + mine.length, dedup_window_ms: AUDIT_DEDUP_MS } });
  }
  return {
    workspace_id: workspaceId,
    name: field(name),
    team,
    mine,
    myNotes: home && canReadFolder(ctx, home) ? home.folder_id : null,
    counts: { team: counts.total - counts.split, mine: counts.split },
  };
}

export async function getSessionIndex(call: McpCall): Promise<Response> {
  const { workspaces } = await reachOf(call.caller);
  const read = await Promise.all(workspaces.slice(0, SEARCH_MAX_WORKSPACES).map((w) => indexWorkspace(call, w.workspace_id, w.name)));
  const indexes = read.filter((w): w is WorkspaceIndex => w !== null);
  // The person's own notes keep their share of the rows, so the team's pages never push them all out.
  const reserved = Math.min(
    SESSION_INDEX_MINE,
    indexes.reduce((n, w) => n + w.mine.length, 0),
  );
  const team = interleave(
    indexes.map((w) => w.team),
    SESSION_INDEX_LIMIT - reserved,
  );
  const mine = interleave(
    indexes.map((w) => w.mine),
    SESSION_INDEX_LIMIT - team.length,
  );
  const left = workspaces.length - Math.min(workspaces.length, SEARCH_MAX_WORKSPACES);
  return json(
    {
      workspaces: indexes.map((w) => ({ workspace_id: w.workspace_id, name: w.name, my_notes: w.myNotes, counts: w.counts })),
      docs: [...team, ...mine],
      // Every page and database the caller can read in these workspaces, listed or not.
      total: indexes.reduce((n, w) => n + w.counts.team + w.counts.mine, 0),
      ...(left > 0 ? { workspaces_left_out: left } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
