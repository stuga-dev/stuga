/**
 * "My notes": one folder per person per workspace, where Save to Stuga files what their AI saves for
 * them alone. Made the first time it is needed, at the top level, owned by the person and shared
 * with nobody else (so not with a workspace administrator either), with AI edits beneath it applying
 * directly. Its title is in the language the person reads Stuga in when it is made. They may rename,
 * move or share it like any folder they own; `folders.home_of` keeps it theirs.
 */
import { createHomeFolder, getHomeFolder, getUiLanguage, type FolderRow } from "@stuga/db";
import { MY_NOTES, matchUiLanguage, type UiLanguage } from "@stuga/protocol/domain/ui-languages";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canReadFolder, personOf } from "../authz/authz.js";
import { newId } from "../ids.js";

export type MyNotes = { folder: FolderRow; created: boolean } | { refusal: string };

/** The language a person reads Stuga in: the one they chose, else their browser's at their last sign-in, else English. */
async function readerLanguage(ctx: Ctx, alias: string): Promise<UiLanguage> {
  const language = await getUiLanguage(ctx.sql, alias).catch(() => null);
  for (const tag of [language?.chosen, language?.detected]) {
    const match = tag ? matchUiLanguage(tag) : null;
    if (match) return match;
  }
  return "en";
}

/** The person's My notes in this workspace, made now when they have none, or why this caller has none. */
export async function myNotes(ctx: Ctx): Promise<MyNotes> {
  if (ctx.role === "guest") return { refusal: "a guest keeps no notes in this workspace" };
  const person = personOf(ctx);
  const found = await getHomeFolder(ctx.sql, ctx.workspaceId, person);
  if (found) {
    // A key confined to some folders reaches My notes only when its person put it among them.
    return canReadFolder(ctx, found)
      ? { folder: found, created: false }
      : { refusal: "this connection is confined to some folders, and the user's My notes is not among them" };
  }
  if (ctx.scope?.folders) return { refusal: "this connection is confined to some folders, so it cannot make the user's My notes" };
  if (ctx.scope?.readOnly) return { refusal: "this connection only reads, and the user has no My notes here yet" };
  const title = MY_NOTES[await readerLanguage(ctx, person)];
  const made = await createHomeFolder(ctx.sql, { folderId: newId("f_"), workspaceId: ctx.workspaceId, alias: person, title });
  if (made.created) {
    recordAudit(ctx, {
      action: "folder.create",
      targetKind: "folder",
      targetId: made.folder.folder_id,
      targetLabel: made.folder.title,
      detail: { parent_id: null, my_notes: true },
    });
  }
  return made;
}
