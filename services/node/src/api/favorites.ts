/** A person's starred documents. */
import { addFavorite, listFavoriteDocs, listFavorites, removeFavorite } from "@stuga/db";
import { authorizedDoc } from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { docSummary } from "./summaries.js";

export async function listFavoritesRoute({ ctx }: WorkspaceCall): Promise<Response> {
  // `favorites` is every starred id in this workspace; `docs` only those still
  // readable, so it may be shorter while the stale star stays clearable.
  const [favorites, docs] = await Promise.all([
    listFavorites(ctx.sql, ctx.alias, ctx.workspaceId),
    listFavoriteDocs(ctx.sql, ctx.alias, ctx.principals, ctx.workspaceId),
  ]);
  return json({ favorites, docs: docs.map(docSummary) });
}

export async function addFavoriteRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { doc_id?: string };
  if (body.doc_id) {
    // Read-gated, so a star cannot probe for a document's existence.
    if (!(await authorizedDoc(ctx, body.doc_id))) return error(404, "not found");
    await addFavorite(ctx.sql, ctx.alias, body.doc_id);
  }
  return json({ ok: true });
}

export async function removeFavoriteRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  // Not read-gated: it touches only the caller's own row, and a star on a doc they lost access to must still clear.
  await removeFavorite(ctx.sql, ctx.alias, match[1]!);
  return json({ ok: true });
}
