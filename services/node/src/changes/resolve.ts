/**
 * Which change an agent's write belongs to. `change_title` opens one and the answer hands back its
 * `change_id`, which the agent passes to every later write for the same piece of work, on any page.
 * A change belongs to the agent that opened it, for the person it acts for, in one workspace; any
 * other id is unknown. A write with neither to a new page the same agent made in a change goes into
 * that change, so a page and the text that fills it are approved together.
 */
import { changePageOf, changeRunCount, createChange, deleteChangeIfEmpty, getChange, touchChange, type DocRow, type WikiChangeRow } from "@stuga/db";
import { CHANGE_RUNS_MAX, CHANGE_SUMMARY_MAX, CHANGE_TITLE_MAX, cleanChangeText, isChangeId, newChangeId } from "@stuga/protocol/domain/changes";
import type { Ctx } from "../auth/context.js";

/** A write's word on its change, as a surface received it. */
export interface ChangeArgs {
  changeId?: unknown;
  changeTitle?: unknown;
  changeSummary?: unknown;
}

/** The change a write goes into: `opened` when this write opened it, so a failed write takes it back. */
export interface ResolvedChange {
  change: WikiChangeRow;
  opened: boolean;
}

export type ChangeOutcome = { ok: true; resolved: ResolvedChange | null } | { ok: false; status: number; message: string };

export const UNKNOWN_CHANGE =
  "unknown `change_id`: pass the `change_id` an earlier write of yours returned, or open a change with `change_title`";

/** The fields a surface passes on, from a body that names them as the wire does. */
export function changeArgsOf(body: { change_id?: unknown; change_title?: unknown; change_summary?: unknown } | null | undefined): ChangeArgs {
  return { changeId: body?.change_id, changeTitle: body?.change_title, changeSummary: body?.change_summary };
}

/** Whether a change is this agent's own: opened by it, for the person it acts for, in this workspace. */
export function ownChange(ctx: Ctx, change: WikiChangeRow | null): change is WikiChangeRow {
  return !!change && ctx.isAgent && change.workspace_id === ctx.workspaceId && change.agent_alias === ctx.alias && change.on_behalf_of === ctx.onBehalfOf;
}

/**
 * The change a write by `ctx` goes into, opening it when the write names a title and no id. `doc` is
 * the item written to, when it exists already. A person's writes belong to no change.
 */
export async function resolveChange(ctx: Ctx, args: ChangeArgs | undefined, doc: Pick<DocRow, "doc_id" | "inherits_perms"> | null): Promise<ChangeOutcome> {
  if (!ctx.isAgent) return { ok: true, resolved: null };
  const summary = args?.changeSummary === undefined ? undefined : cleanChangeText(args.changeSummary, CHANGE_SUMMARY_MAX, false);
  if (args?.changeId !== undefined && args.changeId !== null && args.changeId !== "") {
    const change = isChangeId(args.changeId) ? await getChange(ctx.sql, args.changeId) : null;
    if (!ownChange(ctx, change)) return { ok: false, status: 400, message: UNKNOWN_CHANGE };
    if ((await changeRunCount(ctx.sql, change.change_id)) >= CHANGE_RUNS_MAX) {
      return {
        ok: false,
        status: 409,
        message: `this change already holds ${CHANGE_RUNS_MAX} runs; open another with \`change_title\` for the rest of the work`,
      };
    }
    if (summary || ctx.client || ctx.model) await touchChange(ctx.sql, change.change_id, { ...(summary ? { summary } : {}), client: ctx.client ?? null, model: ctx.model ?? null });
    return { ok: true, resolved: { change: summary ? { ...change, summary } : change, opened: false } };
  }
  const title = cleanChangeText(args?.changeTitle, CHANGE_TITLE_MAX, true);
  if (title) return { ok: true, resolved: { change: await openChange(ctx, title, summary ?? ""), opened: true } };
  if (args?.changeTitle !== undefined && args.changeTitle !== null && args.changeTitle !== "") {
    return { ok: false, status: 400, message: "`change_title` needs a few words naming the work, such as the meeting or email it comes from" };
  }
  // A page this agent made in a change, filled without naming it, is filled in that change. A held page
  // never follows its folder's access, so only such a page is looked up.
  if (doc && doc.inherits_perms === false) {
    const page = await changePageOf(ctx.sql, doc.doc_id);
    if (page) {
      const change = await getChange(ctx.sql, page.change_id);
      if (ownChange(ctx, change)) return { ok: true, resolved: { change, opened: false } };
    }
  }
  return { ok: true, resolved: null };
}

/** Open a change for the agent `ctx`, on behalf of its person. */
export async function openChange(ctx: Ctx, title: string, summary: string): Promise<WikiChangeRow> {
  if (!ctx.isAgent) throw new Error("only an agent opens a change");
  return createChange(ctx.sql, {
    changeId: newChangeId(),
    workspaceId: ctx.workspaceId,
    title,
    summary,
    agent: ctx.displayName || ctx.alias,
    agentAlias: ctx.alias,
    onBehalfOf: ctx.onBehalfOf,
    client: ctx.client ?? null,
    model: ctx.model ?? null,
  });
}

/** Take back a change a failed write opened, when nothing came of it. */
export async function discardOpened(ctx: Ctx, resolved: ResolvedChange | null): Promise<void> {
  if (resolved?.opened) await deleteChangeIfEmpty(ctx.sql, resolved.change.change_id).catch(() => {});
}

/** What a write's answer says of its change, so the agent passes the id to its next write. */
export function changeAnswer(resolved: ResolvedChange | null): { change_id: string; change_title: string } | Record<string, never> {
  return resolved ? { change_id: resolved.change.change_id, change_title: resolved.change.title } : {};
}
