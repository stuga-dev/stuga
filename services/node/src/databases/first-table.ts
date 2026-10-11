/** A new database's one table is named after it, and keeps following the database's name until someone names it. */
import type { DocRow } from "@stuga/db";
import { DATABASE_MAX_DISPLAY_LENGTH } from "@stuga/protocol/databases/limits";
import type { Ctx } from "../auth/context.js";
import { callDatabaseActor } from "./gate.js";

/**
 * After a database's rename: its only table takes the new name while it still
 * follows the database's (the actor knows). Best effort; the database's own
 * rename is the change people see, so this one notifies no one.
 */
export async function followDatabaseRename(ctx: Ctx, doc: Pick<DocRow, "doc_id" | "title">): Promise<void> {
  const display = doc.title.trim().slice(0, DATABASE_MAX_DISPLAY_LENGTH);
  if (display === "") return;
  await callDatabaseActor(ctx, doc.doc_id, "tables/follow-title", { display }).catch(() => null);
}
