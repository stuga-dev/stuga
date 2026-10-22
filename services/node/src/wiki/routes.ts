/** The wiki over REST: a page's links, the Index, the Log and the check, each as the caller reads them. */
import type { WorkspaceCall } from "../http/router.js";
import { error, json } from "../http/respond.js";
import { authorizedDoc } from "../documents/access.js";
import { docWikiLinks, markDocChecked, wikiIndex, wikiLint, wikiLog } from "./wiki.js";

/** Pages one Index lists; a larger wiki is read a folder at a time. */
export const INDEX_MAX_PAGES = 1000;
/** Entries one page of the Log holds by default, and at most. */
export const LOG_PAGE = 50;
export const LOG_PAGE_MAX = 100;
/** Pages each list of a check holds. */
export const LINT_MAX = 200;

/** `?limit=` as a whole number within bounds, or the default. */
function limitOf(url: URL, fallback: number, max: number): number {
  const n = Number(url.searchParams.get("limit"));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export async function getDocLinks({ ctx, match }: WorkspaceCall): Promise<Response> {
  const doc = await authorizedDoc(ctx, match[1]!);
  if (!doc) return error(404, "not found");
  return json(await docWikiLinks(ctx, doc));
}

export async function markDocLinksChecked({ ctx, match }: WorkspaceCall): Promise<Response> {
  const doc = await authorizedDoc(ctx, match[1]!);
  if (!doc) return error(404, "not found");
  const out = await markDocChecked(ctx, doc);
  if ("error" in out) return error(out.status, out.error);
  return json({ ...out, ...(await docWikiLinks(ctx, doc)) });
}

export async function getWikiIndex({ ctx, url }: WorkspaceCall): Promise<Response> {
  const out = await wikiIndex(ctx, { folderId: url.searchParams.get("folder_id"), limit: INDEX_MAX_PAGES });
  if ("error" in out) return error(404, out.error);
  return json(out);
}

export async function getWikiLog({ ctx, url }: WorkspaceCall): Promise<Response> {
  const out = await wikiLog(ctx, { before: url.searchParams.get("before"), limit: limitOf(url, LOG_PAGE, LOG_PAGE_MAX) });
  if ("error" in out) return error(400, out.error);
  return json(out);
}

export async function getWikiLint({ ctx, url }: WorkspaceCall): Promise<Response> {
  const out = await wikiLint(ctx, { folderId: url.searchParams.get("folder_id"), limit: LINT_MAX });
  if ("error" in out) return error(404, out.error);
  return json(out);
}
