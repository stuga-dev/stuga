/** What an agent reads back from `remember`: the plan, and what to do with it. */
import type { RememberPlanBody } from "../backend.js";
import { instructionFields } from "./docs.js";

/** Said after the plan, where a model acting on it reads it: the steps the description gives, in short. */
export const REMEMBER_NEXT =
  "Nothing is saved yet: this plan wrote nothing. For each point not in `already_saved`: read the best place with " +
  "`markdown` action:read, then correct a sentence with `markdown_edit` str_replace (never leave the old one " +
  "standing; a likely_duplicate may say the point already), add under a section with `markdown_append` and " +
  "`heading`, or make a page with `docs_create` (in a `new_page` folder or the folder whose instructions say it " +
  "belongs, else in `home`) and fill it. A fact a table's columns name goes in its row, prose in a page: for a " +
  '`kind: "row"` candidate, `databases_change` action:update_rows on its `row_id` (a cell `possibly_replaces` ' +
  "changed in place), or for `row: null` `databases_add` action:insert_rows; a `waiting` cell or `waiting_row` is " +
  "proposed already, so say it waits. The whole save is ONE change: give `change_title` (a few words naming " +
  "what you save, never a page's title) to your first write and pass the `change_id` it returns to every other, so " +
  "it is reviewed as one. Write no name or date for what the user told you directly: version " +
  "history records who changed what and when. Cite a point's `source` (a meeting, an email, a document) as the " +
  "place asks, never attributing it to the user, and never invent one; a page in Stuga is cited with " +
  "`markdown_edit` action:cited_edits naming it. Then tell the user what you saved where, " +
  "what was already there, and what waits for approval; when you wrote nothing, say nothing was saved, never that " +
  "it was saved or recorded.";

export function renderRememberPlan(plan: RememberPlanBody): string {
  const { user, points, home, home_note, folders_with_instructions, semantic, degraded } = plan;
  return JSON.stringify({
    user,
    points,
    home,
    ...(home_note ? { home_note } : {}),
    ...(folders_with_instructions?.length ? { folders_with_instructions } : {}),
    ...instructionFields(plan),
    semantic,
    degraded,
    next: REMEMBER_NEXT,
  });
}
