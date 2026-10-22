/**
 * New pages an agent makes inside a folder where AI edits wait for a colleague. Such a page is held
 * until its change's runs on it are approved: it does not follow its folder's access, and only the
 * person who asked (its owner) and the people who may approve it there can open it, so its title
 * reaches nobody else through a list, a search, the feed, a webhook, a retrieval, a plan or an export.
 * No `doc.created` is sent for it, and no webhook hears of it. Once approved it takes its folder's
 * access and the grants it would have had, and `doc.created` goes out; once declined or withdrawn it
 * goes to the trash, never announced.
 */
import { materializeAcl, userPrincipal, type OwnGrants } from "@stuga/auth";
import {
  changePageOf,
  colleagueApprovers,
  folderEffectiveAcl,
  getChange,
  getDoc,
  listChangeRuns,
  setDocAcl,
  settleChangePage,
  updateDoc,
  type DocRow,
  type FolderRow,
  type OwnGrantsJson,
  type WikiChangePageRow,
} from "@stuga/db";
import { agentActorOf } from "@stuga/protocol/domain/runs";
import { completeRun, itemsOf } from "./actor-runs.js";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { agentFolderReviewMode, folderReviewChain } from "../authz/review-mode.js";
import { itemKind, pushTrashState } from "../documents/access.js";

/** How a new page is held: who may open it besides its owner, and the approver group it was judged under. */
export interface HoldPlan {
  /** The people who may approve it where it is made, as `user:` principals: everyone else who may open it while held. */
  grants: string[];
  approverGroup: string | null;
}

/**
 * Whether a new item an agent makes in `parent` is held, and how: only when AI edits there wait for a
 * colleague. Those who may approve it are worked out as for a run on an item with the folder's access
 * (approversFor): everyone else who can edit there and holds its approver group, or the owner and
 * admins standing in when nobody does. Each is granted by name, so a group or the whole workspace
 * never stands in for them, and nobody who may only read the folder sees the page.
 */
export async function holdPlan(ctx: Ctx, parent: FolderRow | null): Promise<HoldPlan | null> {
  if (!ctx.isAgent || !parent) return null;
  if (agentFolderReviewMode(parent) !== "colleague") return null;
  const { approverGroup } = await folderReviewChain(ctx.sql, parent.folder_id, ctx.workspaceId);
  const approvers = await colleagueApprovers(
    ctx.sql,
    { acl_principals: parent.acl_principals, acl_writers: parent.acl_writers, owner: parent.owner, workspace_id: ctx.workspaceId },
    ctx.onBehalfOf,
    approverGroup ? [approverGroup] : [],
  );
  return { grants: approvers.aliases.map(userPrincipal), approverGroup };
}

const uniq = (list: readonly string[]): string[] => [...new Set(list)];

/** The grants a released page keeps: those it would have had, and any its owner added while it was held. */
export function releasedGrants(page: Pick<WikiChangePageRow, "held_grants" | "release_grants">, own: OwnGrantsJson): OwnGrants {
  const held = new Set(page.held_grants);
  const kept = (list: readonly string[]) => list.filter((g) => !held.has(g));
  return {
    p: uniq([...page.release_grants.p, ...kept(own.p)]),
    w: uniq([...page.release_grants.w, ...kept(own.w)]),
    c: uniq([...page.release_grants.c, ...kept(own.c)]),
  };
}

/** Where the items of a page's runs in its change stand, from the actors that hold them. */
interface Tally {
  runs: number;
  pending: number;
  accepted: number;
  rejected: number;
}

async function tallyRuns(ctx: Ctx, doc: DocRow, runIds: readonly string[]): Promise<Tally | null> {
  const tally: Tally = { runs: 0, pending: 0, accepted: 0, rejected: 0 };
  for (const runId of runIds) {
    // Every item's status, however large the run; one that cannot be read now settles nothing.
    const run = await completeRun(ctx, doc, runId);
    if (!run) return null;
    const items = itemsOf(run);
    if (!items) return null;
    tally.runs++;
    for (const i of items) {
      if (i.status === "pending") tally.pending++;
      else if (i.status === "accepted" || i.status === "auto_applied") tally.accepted++;
      else if (i.status === "rejected") tally.rejected++;
    }
  }
  return tally;
}

/**
 * After a decision on a run of `docId`: when it is a held page and its change's runs on it are all
 * decided, release it if something of them was approved, or remove it if they were all declined.
 * Nothing happens while any of them waits, or to a page holding no run of its change yet, which the
 * change's card approves or declines as a page. Best-effort: a held page that is not settled now stays
 * held, never wider.
 */
export async function settleHeldPage(ctx: Ctx, item: Pick<DocRow, "doc_id" | "inherits_perms">, note: string | null): Promise<"released" | "removed" | null> {
  // A held page never follows its folder's access, so only such a page is looked up.
  if (item.inherits_perms !== false) return null;
  const docId = item.doc_id;
  const page = await changePageOf(ctx.sql, docId).catch(() => null);
  if (!page || page.state !== "held") return null;
  const doc = await getDoc(ctx.sql, docId);
  if (!doc) return null;
  const runIds = (await listChangeRuns(ctx.sql, page.change_id)).filter((r) => r.doc_id === docId).map((r) => r.run_id);
  if (runIds.length === 0) return null;
  const tally = await tallyRuns(ctx, doc, runIds).catch(() => null);
  if (!tally || tally.runs === 0 || tally.pending > 0) return null;
  if (tally.accepted > 0) return (await releasePage(ctx, page, doc)) ? "released" : null;
  if (tally.rejected > 0) return (await removePage(ctx, page, doc, note)) ? "removed" : null;
  return null;
}

/**
 * Release a held page: it takes the grants it would have had and its folder's access, and is announced
 * (`doc.created`) as made by the agent that made it. Guarded on its state, so it is released once.
 */
export async function releasePage(ctx: Ctx, page: WikiChangePageRow, doc: DocRow): Promise<boolean> {
  const settled = await settleChangePage(ctx.sql, doc.doc_id, "released", ctx.alias, null);
  if (!settled) return false;
  const fresh = (await getDoc(ctx.sql, doc.doc_id)) ?? doc;
  const own = releasedGrants(page, fresh.own_grants);
  const parent = fresh.parent_id ? await folderEffectiveAcl(ctx.sql, fresh.parent_id, fresh.workspace_id) : null;
  const eff = materializeAcl(fresh.owner, own, parent, true);
  await setDocAcl(ctx.sql, fresh.doc_id, eff.principals, eff.writers, true, eff.commenters, own);
  // A database's row pages opened while it was held took its held grants: they follow it out.
  if (fresh.doc_type === "database") {
    const released = (await getDoc(ctx.sql, fresh.doc_id)) ?? fresh;
    const pages = await ctx.sql<DocRow[]>`SELECT doc_id FROM docs WHERE page_of = ${fresh.doc_id} AND workspace_id = ${fresh.workspace_id}`;
    for (const { doc_id } of pages) {
      const rowPage = await getDoc(ctx.sql, doc_id);
      if (!rowPage) continue;
      // As a row page is made (databases/row-pages.ts): the database's own grants, its owner writing.
      const own = released.own_grants;
      const pageOwn = { p: [...own.p, released.owner], w: [...own.w, released.owner], c: [...own.c] };
      const pageEff = materializeAcl(rowPage.owner, pageOwn, parent, released.inherits_perms);
      await setDocAcl(ctx.sql, doc_id, pageEff.principals, pageEff.writers, released.inherits_perms, pageEff.commenters, pageOwn);
    }
  }
  const change = await getChange(ctx.sql, page.change_id);
  // Announced now, as the agent made it: before, it was nobody's to hear of.
  try {
    void ctx.env.jobs
      .send({
        kind: "event",
        workspaceId: fresh.workspace_id,
        type: "doc.created",
        docId: fresh.doc_id,
        actor: change ? agentActorOf(change.agent_alias) : "system",
        actorKind: change ? "agent" : "internal",
        payload: { title: fresh.title, doc_type: fresh.doc_type, parent_id: fresh.parent_id, change_id: page.change_id },
      })
      .catch(() => {});
  } catch {
    /* the feed is best-effort */
  }
  recordAudit(ctx, {
    action: "change.page_approved",
    targetKind: itemKind(fresh),
    targetId: fresh.doc_id,
    targetLabel: fresh.title,
    detail: { change_id: page.change_id },
  });
  return true;
}

/**
 * Its owner or an admin set a held page's sharing themselves: it is no longer held, and is announced
 * as made; its waiting changes still wait for whoever may approve them. Guarded on its state.
 */
export async function releasedBySharing(ctx: Ctx, doc: DocRow): Promise<void> {
  // `doc` as it was before the sharing changed: a held page never follows its folder's access.
  if (doc.inherits_perms !== false) return;
  const page = await changePageOf(ctx.sql, doc.doc_id);
  if (!page || page.state !== "held") return;
  const settled = await settleChangePage(ctx.sql, doc.doc_id, "released", ctx.alias, null);
  if (!settled) return;
  const change = await getChange(ctx.sql, page.change_id);
  try {
    void ctx.env.jobs
      .send({
        kind: "event",
        workspaceId: doc.workspace_id,
        type: "doc.created",
        docId: doc.doc_id,
        actor: change ? agentActorOf(change.agent_alias) : "system",
        actorKind: change ? "agent" : "internal",
        payload: { title: doc.title, doc_type: doc.doc_type, parent_id: doc.parent_id, change_id: page.change_id },
      })
      .catch(() => {});
  } catch {
    /* the feed is best-effort */
  }
}

/**
 * Remove a held page whose changes were declined or withdrawn: to the trash, with the note it was
 * declined with, and never announced. Its access stays as it was held, so the trash shows it only to
 * those who could open it.
 */
export async function removePage(ctx: Ctx, page: WikiChangePageRow, doc: DocRow, note: string | null): Promise<boolean> {
  // A lock keeps a page out of the trash, whoever asks: it stays held until it is unlocked and declined.
  if (doc.locked) return false;
  const settled = await settleChangePage(ctx.sql, doc.doc_id, "removed", ctx.alias, note);
  if (!settled) return false;
  if (!doc.trashed) {
    await updateDoc(ctx.sql, doc.doc_id, { trashed: true });
    await pushTrashState(ctx.env, doc.doc_id, true, doc.doc_type);
  }
  recordAudit(ctx, {
    action: "doc.trash",
    targetKind: itemKind(doc),
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: { change_id: page.change_id, reason: "change_declined" },
  });
  return true;
}
