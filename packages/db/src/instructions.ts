/**
 * The stack of instructions for agents that applies to one document or folder:
 * the workspace's, each folder's from the root down, the database a row page
 * belongs to, then the item's own. Levels without text are left out. Resolved
 * on every read rather than materialized, so a move changes the stack at once.
 *
 * A folder or database level is included only when the reader's principals are
 * on its ACL: a document shared on its own must not reveal the title or the
 * instructions of a private folder above it. The workspace level and the item's
 * own are the caller's to gate (every member reads the first; the second is on
 * the item the caller already opened). Pass a person's principals, not a key's
 * folder scope: an agent confined to one folder still reads the folders above
 * it that its person can read.
 */
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { DocRow } from "./types.js";
import { MAX_FOLDER_DEPTH, type Queryable } from "./sql.js";

function levelOf(kind: InstructionLevel["kind"], id: string, title: string, text: string): InstructionLevel | null {
  const trimmed = text.trim();
  return trimmed ? { kind, id, title, text: trimmed } : null;
}

async function workspaceLevel(sql: Queryable, workspaceId: string): Promise<InstructionLevel | null> {
  const rows = await sql<{ name: string; agent_instructions: string }[]>`
    SELECT name, agent_instructions FROM workspaces WHERE workspace_id = ${workspaceId}`;
  const ws = rows[0];
  return ws ? levelOf("workspace", workspaceId, ws.name, ws.agent_instructions) : null;
}

/**
 * The folder and its ancestors in the workspace, root first, as levels; one
 * query. The walk climbs through folders the reader cannot open, so a readable
 * folder above an unreadable one still counts; only the readable ones are kept.
 */
async function folderChainLevels(
  sql: Queryable,
  folderId: string | null,
  workspaceId: string,
  principals: readonly string[],
): Promise<InstructionLevel[]> {
  if (!folderId) return [];
  const rows = await sql<{ folder_id: string; title: string; agent_instructions: string }[]>`
    WITH RECURSIVE up(folder_id, parent_id, title, agent_instructions, acl_principals, depth) AS (
      SELECT folder_id, parent_id, title, agent_instructions, acl_principals, 0
      FROM folders WHERE folder_id = ${folderId} AND workspace_id = ${workspaceId}
      UNION ALL
      SELECT f.folder_id, f.parent_id, f.title, f.agent_instructions, f.acl_principals, u.depth + 1
      FROM folders f JOIN up u ON f.folder_id = u.parent_id
      WHERE f.workspace_id = ${workspaceId} AND u.depth < ${MAX_FOLDER_DEPTH - 1}
    )
    SELECT folder_id, title, agent_instructions FROM up
    WHERE agent_instructions <> '' AND acl_principals && ${[...principals]}::text[]
    ORDER BY depth DESC`;
  return rows.map((r) => levelOf("folder", r.folder_id, r.title, r.agent_instructions)).filter((l) => l !== null);
}

function present(levels: (InstructionLevel | null)[]): InstructionLevel[] {
  return levels.filter((l): l is InstructionLevel => l !== null);
}

/**
 * Every level that applies to the document, outermost first, ending with its
 * own. A row page takes its database's place in the tree: the database's
 * folders, then the database, then the page.
 */
export async function resolveDocInstructions(
  sql: Queryable,
  doc: Pick<DocRow, "doc_id" | "workspace_id" | "title" | "doc_type" | "parent_id" | "page_of" | "agent_instructions">,
  principals: readonly string[],
): Promise<InstructionLevel[]> {
  let database: { doc_id: string; title: string; parent_id: string | null; agent_instructions: string; readable: boolean } | null =
    null;
  if (doc.page_of) {
    const rows = await sql<{ doc_id: string; title: string; parent_id: string | null; agent_instructions: string; readable: boolean }[]>`
      SELECT doc_id, title, parent_id, agent_instructions, (acl_principals && ${[...principals]}::text[]) AS readable
      FROM docs WHERE doc_id = ${doc.page_of} AND workspace_id = ${doc.workspace_id}`;
    database = rows[0] ?? null;
  }
  const [ws, folders] = await Promise.all([
    workspaceLevel(sql, doc.workspace_id),
    folderChainLevels(sql, database ? database.parent_id : doc.parent_id, doc.workspace_id, principals),
  ]);
  const own = levelOf(doc.doc_type === "database" ? "database" : "document", doc.doc_id, doc.title, doc.agent_instructions);
  const db =
    database?.readable ? levelOf("database", database.doc_id, database.title, database.agent_instructions) : null;
  return present([ws, ...folders, db, own]);
}

/**
 * Every level that applies to a document placed in the folder (null for the
 * root), outermost first. For a folder the caller opened this ends with the
 * folder's own level.
 */
export async function resolveFolderInstructions(
  sql: Queryable,
  workspaceId: string,
  folderId: string | null,
  principals: readonly string[],
): Promise<InstructionLevel[]> {
  const [ws, folders] = await Promise.all([
    workspaceLevel(sql, workspaceId),
    folderChainLevels(sql, folderId, workspaceId, principals),
  ]);
  return present([ws, ...folders]);
}
