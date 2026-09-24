/**
 * The node's in-process surface for the actors, reached through `env.internal` and never
 * mounted on the listener. The principals a caller forwards were resolved at WebSocket upgrade
 * from a verified credential and are trusted; tenant and ACL gates still run here.
 */
import { getDoc, listEditableDocs, resolveDocInstructions, resolveFolderInstructions } from "@stuga/db";
import { hasAccess } from "@stuga/auth";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { AiCitation, AiStrEdit } from "@stuga/protocol/wire/doc-socket";
import { retrieveAndRerank } from "../retrieval/retrieve.js";
import { COLLECTION_UNAVAILABLE, OPEN_DOCUMENT_ONLY, OUTSIDE_COLLECTION, sessionCollectionScope } from "../retrieval/scope.js";
import { proposeDocEdit } from "../agents/edits.js";
import { json } from "../http/respond.js";
import { matchRoute, type PathMatch, type Route } from "../http/router.js";
import { hostExternalImages, ingestWarning, type HostedImage } from "../media/media-ingest.js";
import { isKeySafeWorkspaceId } from "../media/media.js";
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import { serveMedia } from "../media/serve.js";
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

interface InternalRoute extends Route {
  handler: (req: Request, env: NodeEnv, match: PathMatch) => Promise<Response>;
}

const INTERNAL_ROUTES: readonly InternalRoute[] = [
  // Image bytes for a co-author turn, addressed by the workspace the actor runs the turn for.
  { method: "GET", path: MEDIA_GET_PATH, handler: internalMedia },
  { method: "POST", path: "/internal/retrieve", handler: handleInternalRetrieve },
  { method: "POST", path: "/internal/editable-docs", handler: handleInternalEditableDocs },
  { method: "POST", path: "/internal/doc-markdown", handler: handleInternalDocMarkdown },
  { method: "POST", path: "/internal/propose-doc-edit", handler: handleInternalProposeDocEdit },
  { method: "POST", path: "/internal/media-ingest", handler: handleInternalMediaIngest },
  { method: "POST", path: "/internal/agent-instructions", handler: handleInternalAgentInstructions },
];

/** Answer one in-process request from an actor. */
export async function handleInternalRequest(req: Request, env: NodeEnv): Promise<Response> {
  const found = matchRoute(INTERNAL_ROUTES, req.method, new URL(req.url).pathname);
  if (!found) return json({ error: "not found" }, { status: 404 });
  return found.route.handler(req, env, found.match);
}

async function internalMedia(req: Request, env: NodeEnv, match: PathMatch): Promise<Response> {
  const workspaceId = req.headers.get("x-stuga-workspace") ?? "";
  if (!isKeySafeWorkspaceId(workspaceId)) return json({ error: "not found" }, { status: 404 });
  return serveMedia(env, workspaceId, match[1]!);
}

/** The folder confinement of a scoped agent key, as stamped at upgrade; absent means unscoped. */
function folderScope(body: { scopeFolderIds?: unknown }): string[] | null {
  const folders = Array.isArray(body.scopeFolderIds) ? body.scopeFolderIds.filter((f): f is string => typeof f === "string") : [];
  return folders.length > 0 ? folders : null;
}

/**
 * The documents a co-author turn's cross-document calls must stay inside: its
 * selected collection's, null for every document, "open-document" for none
 * besides its own. `alias` is the person at the editor.
 */
function turnScope(
  env: NodeEnv,
  body: { collection_id?: unknown; alias?: unknown; scopeFolderIds?: unknown },
  principals: string[],
  workspaceId: string,
): Promise<string[] | null | "not-found" | "open-document"> {
  const person = typeof body.alias === "string" ? body.alias : "";
  return sessionCollectionScope(env.sql, {
    collectionId: body.collection_id,
    person,
    principals,
    workspaceId,
    scopeFolderIds: folderScope(body),
  });
}

/** The co-author's search_collection tool: the same collection-scoped, ACL-gated retrieval as /api/retrieve. */
async function handleInternalRetrieve(req: Request, env: NodeEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    query?: string;
    collection_id?: string;
    principals?: string[];
    scopeFolderIds?: string[] | null;
    alias?: string;
    workspaceId?: string;
  };
  const query = (body.query ?? "").trim().slice(0, 4000);
  const principals = Array.isArray(body.principals) ? body.principals : [];
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const alias = typeof body.alias === "string" ? body.alias : "";
  if (!query || principals.length === 0 || !workspaceId || !alias) return json({ chunks: [] });
  const ai = env.aiSettings.current();
  // Retrieval is the embed half; the rerank degrades on its own when chat is off.
  if (!ai.embed.enabled) return json({ chunks: [] });
  const scopeDocIds = await turnScope(env, body, principals, workspaceId);
  if (scopeDocIds === "not-found") return json({ chunks: [], message: COLLECTION_UNAVAILABLE });
  if (scopeDocIds === "open-document") return json({ chunks: [] });
  const { chunks } = await retrieveAndRerank({
    sql: env.sql,
    aiCfg: ai,
    embeddingDims: env.embeddingDims,
    searchLanguages: env.searchLanguages,
    alias,
    principals,
    workspaceId,
    query,
    scopeDocIds,
    scopeFolderIds: folderScope(body),
    topN: 8,
  });
  return json({
    chunks: chunks.map((c) => ({
      doc_id: c.doc_id,
      title: c.title,
      chunk_index: c.chunk_index,
      content: c.content,
      heading_path: c.heading_path ?? null,
    })),
  });
}

/** The principals an actor forwarded, strings only; anything else is none. */
function principalsOf(body: { principals?: unknown }): string[] {
  return Array.isArray(body.principals) ? body.principals.filter((p): p is string => typeof p === "string") : [];
}

/**
 * The instructions for agents that apply to a document, for the co-author's system prompt: asked
 * per turn because they can change, or the document can move, mid-session. Folder and database
 * levels follow the principals' read access. A document that is not in the workspace gets the
 * workspace's level alone; an unknown workspace has none, rather than an error.
 */
async function handleInternalAgentInstructions(req: Request, env: NodeEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { workspaceId?: unknown; docId?: unknown; principals?: unknown };
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!workspaceId) return json({ levels: [] });
  const principals = principalsOf(body);
  const doc = typeof body.docId === "string" && body.docId ? await getDoc(env.sql, body.docId) : null;
  const levels =
    doc && doc.workspace_id === workspaceId
      ? await resolveDocInstructions(env.sql, doc, principals)
      : await resolveFolderInstructions(env.sql, workspaceId, null, principals);
  return json({ levels });
}

/** The documents the principals may edit, inside the turn's scope, for the co-author's list_documents tool. */
async function handleInternalEditableDocs(req: Request, env: NodeEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    principals?: string[];
    exclude?: string;
    workspaceId?: string;
    alias?: string;
    collection_id?: string | null;
  };
  const principals = Array.isArray(body.principals) ? body.principals : [];
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (principals.length === 0 || !workspaceId) return json({ docs: [] });
  const scope = await turnScope(env, body, principals, workspaceId);
  if (scope === "not-found") return json({ docs: [], message: COLLECTION_UNAVAILABLE }, { status: 404 });
  if (scope === "open-document") return json({ docs: [] });
  const docs = await listEditableDocs(env.sql, principals, workspaceId, { exclude: body.exclude, docIds: scope });
  return json({ docs });
}

/**
 * Another document's live Markdown for the co-author's openDocument, write-gated because it opens to edit,
 * with the instructions for agents that apply to it. A `message` is a refusal worded for the model.
 */
async function handleInternalDocMarkdown(req: Request, env: NodeEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    doc_id?: string;
    principals?: string[];
    workspaceId?: string;
    alias?: string;
    collection_id?: string | null;
  };
  const docId = typeof body.doc_id === "string" ? body.doc_id : "";
  const principals = Array.isArray(body.principals) ? body.principals : [];
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!docId || principals.length === 0 || !workspaceId) return json({ error: "bad request" }, { status: 400 });
  const scope = await turnScope(env, body, principals, workspaceId);
  if (scope === "not-found") return json({ error: "not found", message: COLLECTION_UNAVAILABLE }, { status: 404 });
  if (scope === "open-document") return json({ error: "forbidden", message: OPEN_DOCUMENT_ONLY }, { status: 403 });
  if (scope && !scope.includes(docId)) return json({ error: "forbidden", message: OUTSIDE_COLLECTION }, { status: 403 });
  const doc = await getDoc(env.sql, docId);
  if (!doc || doc.trashed) return json({ error: "not found" }, { status: 404 });
  if (doc.workspace_id !== workspaceId) return json({ error: "not found" }, { status: 404 });
  // A database id would materialize a stray empty document actor under its name.
  if (doc.doc_type !== "prose") return json({ error: "not found" }, { status: 404 });
  if (!hasAccess(doc.acl_writers, principals)) return json({ error: "forbidden" }, { status: 403 });
  const res = await env.docs.get(docId).fetch(`http://actor/markdown?docId=${encodeURIComponent(docId)}`);
  if (!res.ok) return json({ error: "unavailable" }, { status: 502 });
  const data = (await res.json()) as { markdown?: string };
  // House style, not a gate: a failed lookup opens the document without them rather than
  // telling the model it cannot edit a document it can.
  const instructions = await resolveDocInstructions(env.sql, doc, principals).catch((e: unknown): InstructionLevel[] => {
    console.warn("[node] instructions for agents unavailable for a co-author open", { docId, err: String(e) });
    return [];
  });
  return json({ markdown: data.markdown ?? "", title: doc.title, instructions });
}

/**
 * Rewrite external image destinations in co-author Markdown to locally hosted ones. Runs
 * before the edit is staged, so the reviewed text is the text that lands.
 */
async function handleInternalMediaIngest(req: Request, env: NodeEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    doc_id?: string;
    principals?: string[];
    workspaceId?: string;
    markdown?: string[];
  };
  const docId = typeof body.doc_id === "string" ? body.doc_id : "";
  const principals = Array.isArray(body.principals) ? body.principals : [];
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const markdown = Array.isArray(body.markdown) ? body.markdown.filter((m) => typeof m === "string") : [];
  if (!docId || principals.length === 0 || !workspaceId || markdown.length === 0) {
    return json({ error: "bad request" }, { status: 400 });
  }
  try {
    // The node fetches caller-influenced URLs here, so a document write's gate applies first.
    const doc = await getDoc(env.sql, docId);
    if (!doc || doc.trashed || doc.locked || doc.workspace_id !== workspaceId) {
      return json({ error: "not writable" }, { status: 403 });
    }
    if (!hasAccess(doc.acl_writers, principals)) return json({ error: "not writable" }, { status: 403 });

    const cache = new Map<string, string | { error: string }>();
    const hosted: HostedImage[] = [];
    const failures: Array<{ url: string; reason: string }> = [];
    let truncated = false;
    const out: string[] = [];
    for (const md of markdown) {
      if (!md.includes("![")) {
        out.push(md);
        continue;
      }
      const r = await hostExternalImages(env, doc.workspace_id, docId, md, cache);
      hosted.push(...r.hosted);
      failures.push(...r.failures);
      truncated ||= r.truncated;
      out.push(r.markdown);
    }
    return json({ markdown: out, warning: ingestWarning(failures, truncated) });
  } catch {
    // Image hosting never fails the turn: the edit stages with its original destinations.
    return json({ markdown, warning: "" });
  }
}

/**
 * A co-author proposal into another document's run ledger, reviewed like one in the open
 * document. The panel acts as an agent (`panel:<human>`) on behalf of its human, so
 * `proposeDocEdit` runs its usual gates and the human is the reviewer.
 */
async function handleInternalProposeDocEdit(req: Request, env: NodeEnv): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    doc_id?: string;
    principals?: string[];
    workspaceId?: string;
    alias?: string;
    panel_alias?: string;
    agent?: string;
    edits?: AiStrEdit[];
    citations?: AiCitation[];
    collection_id?: string | null;
  };
  const docId = typeof body.doc_id === "string" ? body.doc_id : "";
  const principals = Array.isArray(body.principals) ? body.principals : [];
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const alias = typeof body.alias === "string" ? body.alias : "";
  const edits = Array.isArray(body.edits) ? body.edits : [];
  if (!docId || !alias || !workspaceId || principals.length === 0 || edits.length === 0) {
    return json({ error: "bad request" }, { status: 400 });
  }
  const scope = await turnScope(env, body, principals, workspaceId);
  if (scope === "not-found") return json({ kind: "error", message: COLLECTION_UNAVAILABLE }, { status: 404 });
  if (scope === "open-document") return json({ kind: "error", message: OPEN_DOCUMENT_ONLY }, { status: 403 });
  if (scope && !scope.includes(docId)) return json({ kind: "error", message: OUTSIDE_COLLECTION }, { status: 403 });
  const ctx: Ctx = {
    sql: env.sql,
    // The turn came from a person's editor session.
    surface: "ws",
    env,
    principals,
    workspaceId,
    // Isolation comes from the principal set; agent gates key off isAgent, not role.
    role: "member",
    alias: typeof body.panel_alias === "string" && body.panel_alias ? body.panel_alias : `panel:${alias}`,
    displayName: typeof body.agent === "string" && body.agent ? body.agent : "AI co-author",
    isAgent: true,
    onBehalfOf: alias,
  };
  const out = await proposeDocEdit(ctx, {
    docId,
    action: "cited_edits",
    edits,
    citations: Array.isArray(body.citations) ? body.citations : [],
    source: "panel",
  });
  if (out.kind === "error") return json({ kind: "error", message: out.message }, { status: out.status ?? 400 });
  if (out.kind === "noop") return json({ kind: "noop" });
  if (out.kind === "proposed") return json({ kind: "proposed", pending: out.pending, run_id: out.run.id });
  return json({ kind: "auto_applied", run_id: out.run.id });
}
