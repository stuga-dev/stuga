/**
 * How AI edits to a document or database are reviewed, and who decides them.
 *
 * Its level is its own `agent_mode`, else its folder's, else `review`, and a row page's at least its
 * database's (docReviewLevel). An agent's proposal parks or applies by that level; a person's own
 * proposal always gets `review`: it is a suggestion, and the setting is about agents. A decision on
 * pending changes takes the stricter of the level a run was proposed under and the item's now, so a
 * move or a later loosening never releases a waiting change; marking a run reviewed keeps the level
 * it was proposed under (actLevel). At `colleague`, someone other than the person who asked the AI,
 * who can edit the item and holds its approver groups, approves (mayActOnRun); when nobody else can,
 * the item's owner or a workspace administrator stands in.
 *
 * An item in a person's My notes that anyone else can read (`notes_shared`) is at `review` at least
 * for every agent, theirs included (effectiveReviewLevel): once it is shared, it is no longer theirs
 * alone, and no agent changes it unseen.
 */
import { type Approvers, type DocRow, type FolderRow, type Queryable, approversFor, getFolderAncestors } from "@stuga/db";
import { docReviewLevel, looserReviewMode, reviewLevelOf, stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";
import { actLevel, mayActOnRun, type RunAct, type RunStanding } from "@stuga/protocol/domain/runs";
import type { Ctx } from "../auth/context.js";
import { canWriteDoc, manages } from "./authz.js";

/** A folder as a level or an approver group comes from it. */
export interface FolderRef {
  folder_id: string;
  owner: string;
}

/** A folder as a chain of levels reads it. */
export interface ChainFolder extends FolderRef {
  agent_mode: ReviewMode | null;
  approver_group?: string | null;
}

/** A folder a level would go below: one that sets it, or (`agent_mode` null) the one whose default `review` it is. */
export interface LevelSetter extends FolderRef {
  agent_mode: ReviewMode | null;
}

/**
 * What the folders above an item give it (the chain, root first, ending with the folder it is in;
 * empty at the top level): the level, which is its floor (`review` when none sets one; null at the
 * top level); the approver group of the nearest folder that names one, and that folder; and, for a
 * level, the folders it would go below, whose owners must agree to it.
 */
export interface FolderReviewChain {
  floor: ReviewMode | null;
  /** The level the folders set, null when none does: what a folder's owner chose, not the default. */
  setLevel: ReviewMode | null;
  approverGroup: string | null;
  groupFolder: FolderRef | null;
  /**
   * The folders whose level `next` goes below, nearest first, empty when it goes below none: each
   * that sets a level looser `next` passes under, up to the first whose level `next` meets (an
   * exception set there was itself agreed above), and, where no folder sets one, the folder the
   * item is in, whose default `review` it is.
   */
  settersBelow(next: ReviewMode): LevelSetter[];
}

/** The levels a chain of folders, root first, gives what is in its last folder. */
export function reviewChainOf(chain: readonly ChainFolder[]): FolderReviewChain {
  // Root first: each folder's level now, and whether a folder at or above it sets one.
  const level: ReviewMode[] = [];
  const set: boolean[] = [];
  let setLevel: ReviewMode | null = null;
  chain.forEach((f, i) => {
    level.push(reviewLevelOf(f.agent_mode, i > 0 ? level[i - 1]! : null));
    set.push(f.agent_mode !== null || (i > 0 && set[i - 1]!));
    setLevel = f.agent_mode ?? setLevel;
  });
  let groupFolder: FolderRef | null = null;
  let approverGroup: string | null = null;
  for (let i = chain.length - 1; i >= 0 && !approverGroup; i--) {
    const f = chain[i]!;
    if (f.approver_group) {
      approverGroup = f.approver_group;
      groupFolder = { folder_id: f.folder_id, owner: f.owner };
    }
  }
  const settersBelow = (next: ReviewMode): LevelSetter[] => {
    const out: LevelSetter[] = [];
    for (let i = chain.length - 1; i >= 0 && looserReviewMode(next, level[i]!); i--) {
      const f = chain[i]!;
      if (f.agent_mode !== null || !set[i]) out.push({ folder_id: f.folder_id, owner: f.owner, agent_mode: f.agent_mode });
      // Where no folder sets a level, the nearest gives the default, and those above it give the same.
      if (!set[i]) break;
    }
    return out;
  };
  return { floor: chain.length > 0 ? level.at(-1)! : null, setLevel, approverGroup, groupFolder, settersBelow };
}

/** The folders above an item in `folderId` (null at the top level), read from the database. */
export async function folderChain(sql: Queryable, folderId: string | null, workspaceId: string): Promise<ChainFolder[]> {
  return folderId ? getFolderAncestors(sql, folderId, workspaceId) : [];
}

export async function folderReviewChain(sql: Queryable, folderId: string | null, workspaceId: string): Promise<FolderReviewChain> {
  return reviewChainOf(await folderChain(sql, folderId, workspaceId));
}

export interface ResolvedReview {
  mode: ReviewMode;
  /** Where the answer came from, in words an agent can read back. */
  reason: string;
}

const REASONS: Record<ReviewMode, string> = {
  auto: "this document is set to let AI edits apply directly",
  review: "this document waits for review",
  colleague: "this document waits for a colleague's approval",
};

/** Why an item set to apply AI edits directly waits for review all the same. */
export const SHARED_NOTES_REASON = "this is in a person's My notes and shared with others, so AI edits to it wait for review";

type LevelFields = Pick<DocRow, "agent_mode" | "folder_agent_mode" | "database_agent_mode" | "notes_shared">;

/** `level`, raised to `review` for an item in a person's My notes that others can read. */
function notesFloor(level: ReviewMode, notesShared: boolean | undefined): ReviewMode {
  return notesShared ? stricterReviewMode(level, "review") : level;
}

/** The level an item is at for every agent: its own or its folders' (docReviewLevel), at `review` at least in a shared My notes. */
export function effectiveReviewLevel(doc: LevelFields): ReviewMode {
  return notesFloor(docReviewLevel(doc), doc.notes_shared);
}

/** Resolve the review mode for one proposal. */
export function resolveReviewMode(ctx: Ctx, doc: LevelFields): ResolvedReview {
  if (!ctx.isAgent) return { mode: "review", reason: "a human session" };
  return agentReviewMode(doc);
}

/** The item's level for any agent, the in-app co-author included. */
export function agentReviewMode(doc: LevelFields): ResolvedReview {
  const set = docReviewLevel(doc);
  const mode = notesFloor(set, doc.notes_shared);
  return { mode, reason: mode === set ? REASONS[mode] : SHARED_NOTES_REASON };
}

/** The level a new page in a folder starts at for every agent: the folder's, at `review` at least in a shared My notes. */
export function agentFolderReviewMode(folder: Pick<FolderRow, "agent_mode" | "parent_agent_mode" | "notes_shared">): ReviewMode {
  return notesFloor(reviewLevelOf(folder.agent_mode, folder.parent_agent_mode), folder.notes_shared);
}

/** The approver group a proposal at `mode` is stamped with: the nearest one the item's folders name, at `colleague` only. */
export async function proposalApproverGroup(ctx: Pick<Ctx, "sql">, doc: DocRow, mode: ReviewMode): Promise<string | null> {
  if (mode !== "colleague") return null;
  return (await folderReviewChain(ctx.sql, doc.parent_id, doc.workspace_id)).approverGroup;
}

/** A run as a decision reads it, from its actor. */
export interface RunPolicyFields {
  reviewer: string;
  review_mode: ReviewMode;
  approver_group?: string | null;
}

/** What the node vouches for beside a decision, and what the person reading the run is shown. */
export interface RunVerdict {
  /** The level its pending changes are decided at: the stricter of the run's and the item's now. */
  level: ReviewMode;
  /** The level the item is at now, which the actor takes the stricter of with the run's own. */
  itemLevel: ReviewMode;
  /** The caller may approve at `colleague`. */
  approver: boolean;
  manager: boolean;
  /** The caller may read the text of its changes that have not landed: its reviewer, an approver, or a manager. */
  seesText: boolean;
  standing: RunStanding;
}

/**
 * Who the caller is to the runs of one document: its level and approver group now, and, for the
 * runs at `colleague` that need it, who else may approve, looked up for all of them in one query.
 */
export class RunJudge {
  private group: Promise<string | null> | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly doc: DocRow,
  ) {}

  private currentGroup(): Promise<string | null> {
    this.group ??= folderReviewChain(this.ctx.sql, this.doc.parent_id, this.doc.workspace_id).then((c) => c.approverGroup);
    return this.group;
  }

  /** The run's level now and where the caller stands on it. */
  async judge(run: RunPolicyFields): Promise<RunVerdict> {
    return (await this.judgeAll([run]))[0]!;
  }

  /** judge for many runs of the document, with one approver lookup for all of them. */
  async judgeAll(runs: readonly RunPolicyFields[]): Promise<RunVerdict[]> {
    const { ctx, doc } = this;
    const itemLevel = effectiveReviewLevel(doc);
    const manager = manages(ctx, doc);
    const writer = !ctx.isAgent && canWriteDoc(ctx, doc);
    const me = ctx.alias;
    const current = runs.some((r) => stricterReviewMode(r.review_mode, itemLevel) === "colleague") ? await this.currentGroup() : null;
    const groupsOf = (run: RunPolicyFields) => [...new Set([run.approver_group, current].filter((g): g is string => !!g))];
    const inGroups = (groups: string[]) => groups.every((g) => ctx.principals.includes(g));
    // Who else may approve matters to the run's reviewer (whom it waits for) and to a manager outside
    // its groups (who stands in only while nobody else can).
    const needs = runs.filter((run) => {
      if (stricterReviewMode(run.review_mode, itemLevel) !== "colleague") return false;
      return me === run.reviewer || (writer && manager && !inGroups(groupsOf(run)));
    });
    const keyOf = (run: RunPolicyFields) => JSON.stringify([run.reviewer, groupsOf(run)]);
    const found =
      needs.length > 0
        ? await approversFor(
            ctx.sql,
            doc.workspace_id,
            needs.map((run) => ({ key: keyOf(run), item: doc, reviewer: run.reviewer, groups: groupsOf(run) })),
          )
        : new Map<string, Approvers>();
    return runs.map((run) => {
      const level = stricterReviewMode(run.review_mode, itemLevel);
      let approver = false;
      let waitsFor: RunStanding["waits_for"];
      if (level === "colleague") {
        const groups = groupsOf(run);
        if (me !== run.reviewer && writer) approver = inGroups(groups) || (manager && found.get(keyOf(run))?.standIn === true);
        if (me === run.reviewer) {
          const approvers = found.get(keyOf(run));
          waitsFor = approvers && approvers.aliases.length === 0 ? (approvers.cause ?? "nobody") : "colleague";
        }
      }
      const may = (act: RunAct) =>
        mayActOnRun({ act, level: actLevel(act, run.review_mode, itemLevel), by: me, reviewer: run.reviewer, approver, manager });
      const standing: RunStanding = {
        level,
        // Deciding changes the item, so both need write access to it, as the decision routes ask.
        accept: writer && may("accept"),
        reject: writer && may("reject"),
        // Marking it reviewed changes nothing, and works after access is withdrawn.
        ack: !ctx.isAgent && may("ack"),
        ...(waitsFor ? { waits_for: waitsFor } : {}),
      };
      return { level, itemLevel, approver, manager, seesText: me === run.reviewer || approver || manager, standing };
    });
  }
}

/** The body fields a decision forwards to the actor, which re-checks them against the run it holds. */
export function vouched(v: RunVerdict): { level: ReviewMode; approver: boolean; manager_override: boolean } {
  return { level: v.itemLevel, approver: v.approver, manager_override: v.manager };
}

/** Whether the caller may do `act`, at the level that act is judged at (actLevel); write access is the route's own check. */
export function mayAct(ctx: Ctx, run: RunPolicyFields, v: RunVerdict, act: RunAct): boolean {
  const level = actLevel(act, run.review_mode, v.itemLevel);
  return mayActOnRun({ act, level, by: ctx.alias, reviewer: run.reviewer, approver: v.approver, manager: v.manager });
}

/** The refusal for a decision the verdict does not allow, worded for who asked. */
export function decisionRefusal(ctx: Ctx, run: RunPolicyFields, v: RunVerdict, act: RunAct, noun: "document" | "database"): string {
  if (actLevel(act, run.review_mode, v.itemLevel) !== "colleague") {
    return noun === "database"
      ? "only this run's reviewer (or the database's owner) can decide it"
      : "only this agent run's reviewer (or the document's owner) can decide it";
  }
  if (ctx.alias === run.reviewer) return "a colleague approves these changes, not the person who asked the AI";
  return `only someone in this ${noun}'s approver group approves these changes`;
}
