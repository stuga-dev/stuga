/**
 * Setting how AI edits to a document, database or folder are reviewed, and keeping a move from
 * loosening it. A folder gives its level to everything beneath it; an item's owner (or a workspace
 * admin) may set it stricter, and only the owner of the folder that gives the level, or a workspace
 * admin, sets an item looser than that, or moves it where its level would be looser. Every change is
 * in the audit ledger, and the workspace's other admins who can read the item are told of one that
 * loosens it below its folder's level, or loosens a folder. Agents never change a level.
 */
import { userPrincipal } from "@stuga/auth";
import { type ClampedLevel, type DocRow, type FolderRow, type WaitingRunBeneath, managersWhoCanRead, reviewSubtree, waitingRunsIn } from "@stuga/db";
import {
  REVIEW_MODES,
  docReviewLevel,
  looserReviewMode,
  reviewLevelOf,
  stricterReviewMode,
  type ReviewMode,
} from "@stuga/protocol/domain/events";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { isWorkspaceAdmin, manages } from "../authz/authz.js";
import { type ChainFolder, type FolderReviewChain, folderChain, reviewChainOf } from "../authz/review-mode.js";
import { error } from "../http/respond.js";

/** The refusals for a looser level, or a move to one, that someone else must make. */
const FOLDER_OWNER_LOOSENS = "only the folder's owner or a workspace admin can make this looser than its folder";
const OWNERS_MOVE = "only its owner, its folder's owner or a workspace admin can move this somewhere AI edits are reviewed less strictly";
const GROUP_OWNER_MOVES = "a folder above names the approver group; only its owner or a workspace admin can move this where another group approves";

/** The item whose level changes. */
export interface LevelTarget {
  kind: "document" | "database" | "folder";
  id: string;
  title: string;
  /** The folder it is in (for a folder, the one above it); null at the top level. */
  parentId: string | null;
  /** Its level now. */
  current: ReviewMode;
  /** The level it sets itself; null follows its folder. */
  own: ReviewMode | null;
  /** Whether the caller may change its other settings: its owner or a workspace admin. */
  managed: boolean;
  /** Who can read it: only they are told of a loosening. */
  readers: string[];
  /** For a row page, its database's level, which it is reviewed at least as strictly as. */
  databaseLevel?: ReviewMode | null;
}

/** What to store and what it means, once the caller may make the change. */
export interface LevelChange {
  /** Its own level to store; null follows its folder. */
  own: ReviewMode | null;
  /** The level its folder gives it, or null when none does. */
  floor: ReviewMode | null;
  /** Below the level its folder gives it: an exception its folder's owner or an admin made. */
  belowFloor: boolean;
  /** Looser than it was. */
  loosened: boolean;
}

/** A document's level target, for the caller. */
export function docLevelTarget(ctx: Ctx, doc: DocRow): LevelTarget {
  return {
    kind: doc.doc_type === "database" ? "database" : "document",
    id: doc.doc_id,
    title: doc.title,
    parentId: doc.parent_id,
    current: docReviewLevel(doc),
    own: doc.agent_mode,
    managed: manages(ctx, doc),
    readers: doc.acl_principals,
    databaseLevel: doc.database_agent_mode,
  };
}

/** A folder's level target, for the caller. */
export function folderLevelTarget(ctx: Ctx, folder: FolderRow): LevelTarget {
  return {
    kind: "folder",
    id: folder.folder_id,
    title: folder.title,
    parentId: folder.parent_id,
    current: reviewLevelOf(folder.agent_mode, folder.parent_agent_mode),
    own: folder.agent_mode,
    managed: manages(ctx, folder),
    readers: folder.acl_principals,
  };
}

/**
 * Whether `me` alone may make an item looser, to `next`, where `place` puts it: the item's own level
 * `own`, and whether `me` manages it (its owner or an admin). Down to its folder's level that is its
 * owner's call; below it, the owner of every folder whose level it goes below must be `me`, and a
 * level the item's owner set above its folder's stays theirs to give up. `defaultsOpen` lets a
 * folder's default `review`, which no one chose, stand in the way of no one.
 */
function mayLoosen(
  place: FolderReviewChain,
  item: { own: ReviewMode | null; managed: boolean },
  next: ReviewMode,
  me: string,
  defaultsOpen = false,
): boolean {
  const below = place.settersBelow(next);
  const ownAbove = item.own !== null && (place.floor === null || looserReviewMode(place.floor, item.own));
  if ((below.length === 0 || ownAbove) && !item.managed) return false;
  return below.every((f) => f.owner === me || (defaultsOpen && f.agent_mode === null));
}

/**
 * Whether the caller may set `target` to `next`, and what to store: null where `next` is what it
 * would follow anyway, so a later change to its folder carries on to it. A refusal is a 403 (a 400
 * for a row page set looser than its database, which it never is).
 *
 * Stricter is the call of anyone who may set its level: its owner or an admin, or the owner of a
 * folder above it, who may so undo a looser level they set. Looser, but not below its folder's
 * level, is its owner's or an admin's. Below its folder's level, the owner of every folder whose
 * level it goes below must be the caller, or the caller an admin: owning a stricter folder inside
 * another does not let anyone go below the outer one, and a folder's owner does not undo a level the
 * item's owner set above the folder's.
 */
export async function planLevelChange(ctx: Ctx, target: LevelTarget, next: ReviewMode): Promise<Response | LevelChange> {
  if (ctx.isAgent) return error(403, "agents cannot change how AI edits are reviewed");
  if (target.databaseLevel && looserReviewMode(next, target.databaseLevel)) {
    return error(400, "a database's pages are reviewed at least as strictly as the database");
  }
  const folders = await folderChain(ctx.sql, target.parentId, ctx.workspaceId);
  const chain = reviewChainOf(folders);
  const floor = chain.floor;
  const below = chain.settersBelow(next);
  const loosened = looserReviewMode(next, target.current);
  const me = userPrincipal(ctx.alias);
  if (!isWorkspaceAdmin(ctx)) {
    if (!loosened) {
      if (!target.managed && !folders.some((f) => f.owner === me)) return error(403, "only the owner or a workspace admin can change these settings");
    } else if (!mayLoosen(chain, target, next, me)) {
      return error(403, below.length > 0 && !below.every((f) => f.owner === me) ? FOLDER_OWNER_LOOSENS : "only the owner or a workspace admin can change these settings");
    }
  }
  return { own: next === reviewLevelOf(null, floor) ? null : next, floor, belowFloor: below.length > 0, loosened };
}

/** The workspace's other admins who can read an item that loosened: REVIEW_LEVEL_LOWERED each. */
async function tellAdmins(
  ctx: Ctx,
  target: Pick<LevelTarget, "kind" | "id" | "title" | "readers">,
  params: { level: ReviewMode; floor: ReviewMode | null; moved: boolean },
): Promise<void> {
  const admins = (await managersWhoCanRead(ctx.sql, ctx.workspaceId, { acl_principals: target.readers }, ctx.alias)).filter(
    (a) => a !== ctx.alias,
  );
  for (const recipient of admins) {
    await ctx.env.jobs.send({
      kind: "notify",
      recipient,
      workspaceId: ctx.workspaceId,
      eventType: "REVIEW_LEVEL_LOWERED",
      docId: target.id,
      ...(target.kind === "folder" ? { folder: true as const } : {}),
      params: { actor: ctx.displayName || ctx.alias, doc: target.title, kind: target.kind, ...params },
      actor: ctx.alias,
    });
  }
}

/** The ledger row for a level change, and the other admins' notices where it loosened past a folder's level, or a folder. */
export async function recordLevelChange(ctx: Ctx, target: LevelTarget, next: ReviewMode, change: LevelChange): Promise<void> {
  recordAudit(ctx, {
    action: target.kind === "folder" ? "folder.agent_mode" : "doc.agent_mode",
    targetKind: target.kind === "document" ? "doc" : target.kind,
    targetId: target.id,
    targetLabel: target.title,
    detail: { mode: next, from: target.current, follows_folder: change.own === null, floor: change.floor, below_floor: change.belowFloor },
  });
  // Only a real loosening: a folder's reaches everything beneath it; an item's, past its folder's level.
  if (!change.loosened || !(change.belowFloor || target.kind === "folder")) return;
  await tellAdmins(ctx, target, { level: next, floor: change.belowFloor ? change.floor : null, moved: false });
}

/** The ledger rows for the levels a move set back to following their new folder. */
export function recordClampedLevels(ctx: Ctx, clamped: ClampedLevel[]): void {
  for (const c of clamped) {
    recordAudit(ctx, {
      action: c.kind === "folder" ? "folder.agent_mode" : "doc.agent_mode",
      targetKind: c.kind,
      targetId: c.id,
      targetLabel: c.title,
      detail: { mode: null, from: c.from, follows_folder: true, reason: "moved" },
    });
  }
}

// ---- Moves ------------------------------------------------------------------------------------

/** A document or a folder about to move, as the caller may see it. */
export type MovedItem = { kind: "doc"; doc: DocRow } | { kind: "folder"; folder: FolderRow };

/** What a move does to levels, once the caller may make it. */
export interface MovePlan {
  target: LevelTarget;
  /** The moved item's level before and after. */
  before: ReviewMode;
  after: ReviewMode;
  /** How many of the items it moves (it, and for a folder everything beneath) it reviews more loosely. */
  lowered: number;
  /** The level the folders it leaves gave it, when the move goes below what they set; else null. */
  leftFloor: ReviewMode | null;
}

/** One item a move takes along, as the level check walks it: the moved item first, then what is beneath, parents first. */
interface Moving {
  id: string;
  /** Its folder among the moving ones; null for the moved item itself. */
  parent: string | null;
  folder: boolean;
  owner: string;
  own: ReviewMode | null;
  /** The caller may change its settings: its owner or an admin. */
  managed: boolean;
}

/** The levels below `level`, loosest first. */
function looserThan(level: ReviewMode): ReviewMode[] {
  return REVIEW_MODES.filter((m) => looserReviewMode(m, level));
}

/**
 * Whether the caller may move `moved` into `destId` (null for the top level), as levels go. A move
 * takes everything it moves out from under the folders it leaves, and must not let the caller alone
 * review AI edits to any of it more loosely than they could before: neither at once (a looser level
 * where it lands) nor afterwards (in a folder of their own, or, for what they own, at the top level),
 * as planLevelChange would let them. A folder's default `review`, which no one chose, is no bar to
 * leaving it. Nor may a move take an item at `colleague` out from under an approver group someone
 * else names. Each level is the item's own and its folders': a row page counts without its
 * database's, from which it can be parted. Refused, it is a 403 and nothing moves; an admin is
 * never refused.
 */
export async function planMove(ctx: Ctx, moved: MovedItem, destId: string | null): Promise<Response | MovePlan> {
  const target = moved.kind === "doc" ? docLevelTarget(ctx, moved.doc) : folderLevelTarget(ctx, moved.folder);
  const [left, dest] = await Promise.all([folderChain(ctx.sql, target.parentId, ctx.workspaceId), folderChain(ctx.sql, destId, ctx.workspaceId)]);
  const leftChain = reviewChainOf(left);
  const destChain = reviewChainOf(dest);
  const me = userPrincipal(ctx.alias);
  const admin = isWorkspaceAdmin(ctx);
  const managed = (owner: string) => admin || owner === me;

  // What moves: the item, and for a folder everything beneath it.
  const owner = moved.kind === "doc" ? moved.doc.owner : moved.folder.owner;
  const items: Moving[] = [{ id: target.id, parent: null, folder: target.kind === "folder", owner, own: target.own, managed: target.managed }];
  if (moved.kind === "folder") {
    const sub = await reviewSubtree(ctx.sql, moved.folder.folder_id, ctx.workspaceId);
    for (const f of sub.folders) items.push({ id: f.folder_id, parent: f.parent_id, folder: true, owner: f.owner, own: f.agent_mode, managed: managed(f.owner) });
    for (const d of sub.docs) items.push({ id: d.doc_id, parent: d.parent_id, folder: false, owner: d.owner, own: d.agent_mode, managed: managed(d.owner) });
  }

  // Each moving folder's chain, before and after: what the items beneath it inherit.
  const chainBefore = new Map<string, ChainFolder[]>();
  const chainAfter = new Map<string, ChainFolder[]>();
  const places = new Map<string, FolderReviewChain>();
  const placeOf = (when: "before" | "after", parent: string | null): FolderReviewChain => {
    const key = `${when}:${parent ?? ""}`;
    let found = places.get(key);
    if (!found) {
      const chains = when === "before" ? chainBefore : chainAfter;
      found = parent === null ? (when === "before" ? leftChain : destChain) : reviewChainOf(chains.get(parent)!);
      places.set(key, found);
    }
    return found;
  };
  /** The loosest level the caller could set an item to alone at a place, if looser than `from`. */
  const reach = (place: FolderReviewChain, item: { own: ReviewMode | null; managed: boolean }, from: ReviewMode, defaultsOpen: boolean) =>
    looserThan(from).find((x) => mayLoosen(place, item, x, me, defaultsOpen)) ?? null;

  let lowered = 0;
  let lowestAfter: ReviewMode | null = null;
  let rootAfter: ReviewMode = target.current;
  let gained = false;
  let colleague = false;
  for (const item of items) {
    const before = placeOf("before", item.parent);
    const after = placeOf("after", item.parent);
    // A looser level of its own was an exception for the old place: it does not travel.
    const own = item.own && after.floor && looserReviewMode(item.own, after.floor) ? null : item.own;
    const from = reviewLevelOf(item.own, before.floor);
    const to = reviewLevelOf(own, after.floor);
    if (item.parent === null) rootAfter = to;
    if (item.folder) {
      chainBefore.set(item.id, [...(item.parent === null ? left : chainBefore.get(item.parent)!), { folder_id: item.id, owner: item.owner, agent_mode: item.own }]);
      chainAfter.set(item.id, [...(item.parent === null ? dest : chainAfter.get(item.parent)!), { folder_id: item.id, owner: item.owner, agent_mode: own }]);
    }
    if (from === "colleague") colleague = true;
    if (looserReviewMode(to, from)) {
      lowered++;
      if (lowestAfter === null || looserReviewMode(to, lowestAfter)) lowestAfter = to;
    }
    if (admin) continue;
    // How low the caller alone could take it, before the move and after it.
    const couldBefore = reach(before, item, from, true) ?? from;
    const reached = reach(after, { own, managed: item.managed }, to, false);
    const couldAfter = reached && looserReviewMode(reached, to) ? reached : to;
    if (looserReviewMode(couldAfter, couldBefore)) gained = true;
  }
  if (gained) return error(403, OWNERS_MOVE);
  // The approver group a folder it leaves names stays theirs: it lands where the same group applies, named by someone else.
  const group = leftChain.groupFolder;
  if (!admin && colleague && group && group.owner !== me) {
    const there = destChain.groupFolder;
    if (destChain.approverGroup !== leftChain.approverGroup || !there || there.owner === me) return error(403, GROUP_OWNER_MOVES);
  }
  const leftFloor = lowestAfter !== null && leftChain.settersBelow(lowestAfter).length > 0 ? leftChain.floor : null;
  // A row page that moves alone keeps its database's level as well.
  const database = moved.kind === "doc" ? moved.doc.database_agent_mode : null;
  return { target, before: target.current, after: database ? stricterReviewMode(rootAfter, database) : rootAfter, lowered, leftFloor };
}

/**
 * The ledger row for a move that reviews what it moved more loosely, and the other admins' notices
 * where that goes below what the folders it left set, or loosens a folder. Nothing for a move that
 * loosens nothing: the move itself is in the ledger already.
 */
export async function recordMove(ctx: Ctx, plan: MovePlan): Promise<void> {
  if (plan.lowered === 0) return;
  const { target } = plan;
  recordAudit(ctx, {
    action: target.kind === "folder" ? "folder.agent_mode" : "doc.agent_mode",
    targetKind: target.kind === "document" ? "doc" : target.kind,
    targetId: target.id,
    targetLabel: target.title,
    detail: { mode: plan.after, from: plan.before, reason: "moved", lowered: plan.lowered, floor: plan.leftFloor },
  });
  if (plan.leftFloor === null && target.kind !== "folder") return;
  await tellAdmins(ctx, target, { level: plan.after, floor: plan.leftFloor, moved: true });
}

/**
 * After a folder's approver group changed, or a document or folder moved: for each run that was
 * waiting there (`before`, read first) at `colleague` whose document follows another group now, ask
 * the job worker to tell the people who may approve it now and could not before, or the item's
 * owner and admins when nobody may.
 */
export async function notifyRegrouped(ctx: Ctx, scope: { folderId: string } | { docId: string }, before: WaitingRunBeneath[]): Promise<void> {
  if (before.length === 0) return;
  const after = new Map((await waitingRunsIn(ctx.sql, scope, ctx.workspaceId)).map((r) => [r.run_id, r]));
  for (const was of before) {
    const now = after.get(was.run_id);
    if (!now || now.doc_group === was.doc_group || stricterReviewMode(now.review_mode, now.doc_level) !== "colleague") continue;
    await ctx.env.jobs.send({
      kind: "notify_approvers",
      workspaceId: ctx.workspaceId,
      docId: now.doc_id,
      runId: now.run_id,
      reviewer: now.reviewer,
      approverGroup: now.approver_group,
      actor: now.agent_alias,
      agent: now.agent,
      doc: now.doc_title,
      count: now.pending,
      askerTold: true,
      groupBefore: was.doc_group,
    });
  }
}
