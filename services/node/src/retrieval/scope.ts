import { type Sql, expandCollectionScope, getCollection } from "@stuga/db";
import { ALL_DOCUMENTS_SCOPE } from "@stuga/protocol/wire/doc-socket";
import type { Ctx } from "../auth/context.js";
import { ownedCollection, scopeFolderIds } from "../authz/authz.js";

/**
 * The tool error for reaching past a selected collection. It is the same for a
 * document that does not exist, so it reveals nothing the scope does not hold.
 */
export const OUTSIDE_COLLECTION = "that document is not in the selected collection";
export const DATABASE_OUTSIDE_COLLECTION = "that database is not in the selected collection";
export const COLLECTION_UNAVAILABLE = "that collection is not available";
export const OPEN_DOCUMENT_ONLY =
  "this turn reaches only the open document; to work across documents, pick All documents or a collection as the search scope";

/**
 * The documents a collection narrows a search to: null when none is named,
 * "not-found" when the caller cannot read it. The expansion is intersected with
 * the caller's principals and key folders, so a scope only ever narrows.
 */
export async function collectionScope(ctx: Ctx, collectionId: string | null | undefined): Promise<string[] | null | "not-found"> {
  if (!collectionId) return null;
  if (!(await ownedCollection(ctx, collectionId))) return "not-found";
  return expandCollectionScope(ctx.sql, collectionId, {
    principals: ctx.principals,
    workspaceId: ctx.workspaceId,
    scopeFolderIds: scopeFolderIds(ctx),
  });
}

/**
 * The same scope for a co-author session the actor describes: `person` is the
 * human at the editor, whose collections these are. Every document is null, and
 * no collection is "open-document": the turn reaches no document but its own.
 */
export async function sessionCollectionScope(
  sql: Sql,
  session: { collectionId: unknown; person: string; principals: string[]; workspaceId: string; scopeFolderIds: string[] | null },
): Promise<string[] | null | "not-found" | "open-document"> {
  const { collectionId, person, principals, workspaceId } = session;
  if (typeof collectionId !== "string" || !collectionId) return "open-document";
  if (collectionId === ALL_DOCUMENTS_SCOPE) return null;
  const collection = await getCollection(sql, collectionId);
  if (!collection || collection.workspace_id !== workspaceId || collection.owner !== person) return "not-found";
  return expandCollectionScope(sql, collectionId, { principals, workspaceId, scopeFolderIds: session.scopeFolderIds });
}
