/**
 * Collections: a person's named retrieval scopes. The person and every agent
 * acting for them manage the same set, through REST and both MCP servers, and
 * each caller sees and changes only the members it can read. The audit ledger,
 * which workspace admins read, names a collection by id only.
 */
import {
  type CollectionItemRow,
  type CollectionReach,
  type CollectionRow,
  type CollectionSummary,
  addCollectionItems,
  createCollection,
  deleteCollection,
  filterVisibleRefs,
  listCollectionItems,
  listCollections,
  readsEveryMember,
  removeCollectionItems,
  renameCollection,
} from "@stuga/db";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { ownedCollection, personOf, READ_ONLY_MESSAGE, scopeFolderIds } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";

/** A refused collection call: the status REST answers with, and the sentence every surface shows. */
export interface CollectionRefusal {
  status: 400 | 403 | 404;
  error: string;
}

export function isCollectionRefusal(value: unknown): value is CollectionRefusal {
  return typeof value === "object" && value !== null && typeof (value as CollectionRefusal).status === "number";
}

const NOT_FOUND: CollectionRefusal = { status: 404, error: "collection not found" };
const NAME_MAX = 200;

export interface ItemRefs {
  docIds: string[];
  folderIds: string[];
}

function reachOf(ctx: Ctx): CollectionReach {
  return { principals: ctx.principals, workspaceId: ctx.workspaceId, scopeFolderIds: scopeFolderIds(ctx) };
}

/** A read-only key lists and opens collections and changes none; the route table refuses it too. */
function readOnlyRefusal(ctx: Ctx): CollectionRefusal | null {
  return ctx.scope?.readOnly ? { status: 403, error: READ_ONLY_MESSAGE } : null;
}

async function changeable(ctx: Ctx, collectionId: string): Promise<CollectionRow | CollectionRefusal> {
  const refused = readOnlyRefusal(ctx);
  if (refused) return refused;
  return (await ownedCollection(ctx, collectionId)) ?? NOT_FOUND;
}

/** A key confined to folders renames or deletes only a collection whose every member it can read. */
async function changeableWhole(ctx: Ctx, collectionId: string): Promise<CollectionRow | CollectionRefusal> {
  const collection = await changeable(ctx, collectionId);
  if (isCollectionRefusal(collection)) return collection;
  if (scopeFolderIds(ctx) && !(await readsEveryMember(ctx.sql, collectionId, reachOf(ctx)))) return NOT_FOUND;
  return collection;
}

export function listPersonCollections(ctx: Ctx): Promise<CollectionSummary[]> {
  return listCollections(ctx.sql, personOf(ctx), reachOf(ctx));
}

export async function openCollection(
  ctx: Ctx,
  collectionId: string,
): Promise<{ collection: CollectionRow; items: CollectionItemRow[] } | CollectionRefusal> {
  const collection = await ownedCollection(ctx, collectionId);
  if (!collection) return NOT_FOUND;
  return { collection, items: await listCollectionItems(ctx.sql, collectionId, reachOf(ctx)) };
}

export async function createPersonCollection(ctx: Ctx, name: string | undefined): Promise<CollectionRow | CollectionRefusal> {
  const refused = readOnlyRefusal(ctx);
  if (refused) return refused;
  if (ctx.role === "guest") return { status: 403, error: "guests cannot create collections" };
  const collection = await createCollection(ctx.sql, {
    collectionId: newId("col_"),
    workspaceId: ctx.workspaceId,
    owner: personOf(ctx),
    name: ((name ?? "").trim() || "New collection").slice(0, NAME_MAX),
  });
  recordAudit(ctx, { action: "collection.create", targetKind: "collection", targetId: collection.collection_id });
  return collection;
}

export async function renamePersonCollection(ctx: Ctx, collectionId: string, name: unknown): Promise<CollectionRow | CollectionRefusal> {
  const collection = await changeableWhole(ctx, collectionId);
  if (isCollectionRefusal(collection)) return collection;
  if (typeof name !== "string" || !name.trim()) return { status: 400, error: "name required" };
  const updated = await renameCollection(ctx.sql, collectionId, name.trim().slice(0, NAME_MAX));
  if (!updated) return NOT_FOUND;
  recordAudit(ctx, { action: "collection.rename", targetKind: "collection", targetId: collectionId });
  return updated;
}

export async function deletePersonCollection(ctx: Ctx, collectionId: string): Promise<{ deleted: true } | CollectionRefusal> {
  const collection = await changeableWhole(ctx, collectionId);
  if (isCollectionRefusal(collection)) return collection;
  await deleteCollection(ctx.sql, collectionId);
  recordAudit(ctx, { action: "collection.delete", targetKind: "collection", targetId: collectionId });
  return { deleted: true };
}

/**
 * Add or remove members. Only documents and folders the caller can read are
 * touched: an add skips the rest, and a remove leaves members it cannot see.
 */
export async function changePersonCollectionItems(
  ctx: Ctx,
  collectionId: string,
  change: "add" | "remove",
  refs: ItemRefs,
): Promise<{ added: number; skipped: number } | { removed: number } | CollectionRefusal> {
  const collection = await changeable(ctx, collectionId);
  if (isCollectionRefusal(collection)) return collection;
  const docIds = [...new Set(refs.docIds)];
  const folderIds = [...new Set(refs.folderIds)];
  if (docIds.length === 0 && folderIds.length === 0) return { status: 400, error: "provide doc_ids or folder_ids" };
  const readable = await filterVisibleRefs(ctx.sql, reachOf(ctx), docIds, folderIds);
  const audit = { targetKind: "collection", targetId: collectionId };
  if (change === "add") {
    const added = await addCollectionItems(ctx.sql, collectionId, readable);
    const skipped = docIds.length + folderIds.length - readable.docIds.length - readable.folderIds.length;
    recordAudit(ctx, { action: "collection.items.add", ...audit, detail: { added, skipped } });
    return { added, skipped };
  }
  const removed = await removeCollectionItems(ctx.sql, collectionId, readable);
  recordAudit(ctx, { action: "collection.items.remove", ...audit, detail: { removed } });
  return { removed };
}

function respond(out: object, status = 200): Response {
  return isCollectionRefusal(out) ? error(out.status, out.error) : json(out, { status });
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function listCollectionsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  return json({ collections: await listPersonCollections(ctx) });
}

export async function createCollectionRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  return respond(await createPersonCollection(ctx, typeof body.name === "string" ? body.name : undefined), 201);
}

export async function getCollectionRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  return respond(await openCollection(ctx, match[1]!));
}

export async function renameCollectionRoute({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  return respond(await renamePersonCollection(ctx, match[1]!, body.name));
}

export async function deleteCollectionRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  return respond(await deletePersonCollection(ctx, match[1]!));
}

export async function changeCollectionItemsRoute({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { doc_ids?: unknown; folder_ids?: unknown };
  const add = req.method === "POST";
  const out = await changePersonCollectionItems(ctx, match[1]!, add ? "add" : "remove", {
    docIds: idList(body.doc_ids),
    folderIds: idList(body.folder_ids),
  });
  return respond(out, add ? 201 : 200);
}
