/** The agent tools' data access for one call, in-process over its resolved Ctx. */
import type {
  AgentBackend,
  Answer,
  DatabaseMutation,
  DatabaseProposeBody,
  ImportOutcome,
  ViewShape,
  ProposeInstructionLabels,
} from "@stuga/agent-surface/backend";
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import {
  type DocRow,
  addComment,
  getDoc,
  getWorkspace,
  latestWorkspaceEventId,
  listComments,
  listDocs,
  listFolders,
  listWorkspaceEvents,
} from "@stuga/db";
import { DATABASE_IMPORT_INLINE_MAX_CHARS } from "@stuga/protocol/databases/limits";
import type { DatabaseRunSummary, DatabaseSchema } from "@stuga/protocol/databases/types";
import {
  databaseDocMessage,
  proposeBody,
  proposeDocEdit,
  readDocMarkdownWithProjection,
  readDocProvenance,
  readDocRuns,
} from "../agents/edits.js";
import {
  type CollectionRefusal,
  changePersonCollectionItems,
  createPersonCollection,
  deletePersonCollection,
  isCollectionRefusal,
  listPersonCollections,
  openCollection,
  renamePersonCollection,
} from "../api/collections.js";
import { retrievePassages, searchDocuments } from "../api/search.js";
import { folderSummary } from "../api/summaries.js";
import { recordEvent } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canCommentDoc, canReadDoc, canWriteDoc, scopeFolderIds } from "../authz/authz.js";
import { resolveReviewMode } from "../authz/review-mode.js";
import { authorizedDatabase, callDatabaseActor } from "../databases/gate.js";
import {
  commitDatabaseImport,
  createDatabaseImport,
  importPageUrl,
  parseCommitOptions,
  stageInlineImport,
} from "../databases/imports/staging.js";
import {
  databaseProposeBody,
  parseColumnSpecs,
  proposeDatabaseOp,
  proposeTableWithColumns,
  type DatabaseProposeOutcome,
} from "../databases/propose.js";
import { findRowPage, openRowPage } from "../databases/row-pages.js";
import { createDocument } from "../documents/create.js";
import { docAgentInstructions, docAgentInstructionsOrNone, docInstructionLabelsOrNone } from "../documents/instructions.js";
import {
  MediaValidationError,
  decodeBase64Image,
  fetchRemoteImage,
  mediaUrl,
  storeImage,
  validateImageBytes,
} from "../media/media.js";

/** Max page before the caller's own runs are picked out: a busy database's newest runs may all be someone else's. */
const RUNS_PAGE = 50;

const NOT_FOUND = { error: "not found or no access" };

/** The tools' data access in the one workspace `ctx` resolved to. */
export function nodeBackend(ctx: Ctx): AgentBackend {
  /** A database the caller may change, or the refusal. */
  const writableDatabase = async (databaseId: string): Promise<DocRow | { error: string }> => {
    const doc = await authorizedDatabase(ctx, databaseId);
    if (!doc) return NOT_FOUND;
    if (!canWriteDoc(ctx, doc)) return { error: "no write access to this database" };
    if (doc.locked) return { error: "this database is locked; the user must unlock it first" };
    return doc;
  };

  const actorJson = async <T>(res: Response, fallback: string): Answer<T> => {
    const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok || body === null) return { error: body?.message ?? fallback };
    return body;
  };

  return {
    origin: ctx.env.publicOrigin,

    async workspaceInstructions() {
      const ws = await getWorkspace(ctx.sql, ctx.workspaceId);
      return { workspace_id: ctx.workspaceId, name: ws?.name ?? "", instructions: ws?.agent_instructions ?? "" };
    },

    async listDocs(parentId) {
      const docs = await listDocs(ctx.sql, ctx.principals, ctx.workspaceId, {
        scopeFolderIds: scopeFolderIds(ctx),
        ...(parentId !== undefined ? { parentId } : {}),
      });
      return docs.map((d) => ({ doc_id: d.doc_id, title: d.title, doc_type: d.doc_type, parent_id: d.parent_id, updated_at: d.updated_at }));
    },

    searchDocs: async (query) => orCollectionNotFound(await searchDocuments(ctx, query)),

    async docMetadata(docId) {
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || !canReadDoc(ctx, doc)) return { error: "not found" };
      const review = resolveReviewMode(ctx, doc);
      return {
        doc_id: doc.doc_id,
        title: doc.title,
        doc_type: doc.doc_type,
        updated_at: doc.updated_at,
        locked: doc.locked,
        search_hidden: doc.search_hidden,
        review: { mode: review.mode, reason: review.reason },
        ...(await docAgentInstructions(ctx, doc)),
      };
    },

    async createDoc(input) {
      const out = await createDocument(ctx, {
        title: input.title,
        docType: input.doc_type,
        parentId: input.parent_id,
        table: input.table,
        columns: input.columns,
      });
      if (!out.ok) return { error: out.message };
      // The document exists now: a failed lookup must not read as a failed create, or the agent makes another.
      return { doc_id: out.doc.doc_id, title: out.doc.title, ...(await docAgentInstructionsOrNone(ctx, out.doc)) };
    },

    async readMarkdown(docId) {
      const md = await readDocMarkdownWithProjection(ctx, docId);
      if (!md) return NOT_FOUND;
      if (md === "database") return { error: databaseDocMessage(docId) };
      return {
        markdown: md.markdown,
        run_id: md.runId ?? null,
        pending: md.pending ?? 0,
        ...(await docAgentInstructions(ctx, md.doc)),
      };
    },

    async docRuns(docId) {
      const runs = await readDocRuns(ctx, docId);
      if (runs === "database") return { error: databaseDocMessage(docId) };
      if (!runs) return NOT_FOUND;
      return runs.filter((r) => r.agent_alias === ctx.alias);
    },

    async provenance(docId) {
      const out = await readDocProvenance(ctx, docId);
      if (out === null) return NOT_FOUND;
      if (out === "database") return { error: databaseDocMessage(docId) };
      return out;
    },

    async propose(docId, input) {
      const outcome = await proposeDocEdit(ctx, {
        docId,
        action: input.action,
        text: input.text,
        heading: input.heading ?? null,
        find: input.find,
        replace: input.replace,
        replaceAll: input.replace_all,
        edits: input.edits,
        citations: input.citations,
        source: "connector",
      });
      if (outcome.kind === "error") return { error: outcome.message };
      const answer = proposeBody(outcome, `${ctx.env.publicOrigin}/doc/${docId}`);
      if (outcome.kind === "noop") return answer;
      return { ...answer, ...(await docInstructionLabelsOrNone(ctx, outcome.doc)) };
    },

    async uploadImage(docId, source) {
      // An upload is a document write: the same gates as an edit.
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || doc.trashed || !canReadDoc(ctx, doc)) return { error: `document ${docId} not found` };
      if (doc.doc_type !== "prose") return { error: databaseDocMessage(docId) };
      if (!canWriteDoc(ctx, doc)) return { error: `no write access to ${docId}` };
      if (doc.locked) return { error: `document ${docId} is locked; unlock it to add images` };
      try {
        // The bytes name their own type; a model-declared mime is wrong too often to ask for one.
        const { bytes, mime } =
          source.kind === "data"
            ? validateImageBytes(decodeBase64Image(source.data), MAX_INLINE_IMAGE_BYTES)
            : await fetchRemoteImage(source.url);
        const stored = await storeImage(ctx.env.media, ctx.workspaceId, bytes, mime);
        return { url: mediaUrl(docId, stored.hash), hash: stored.hash, size: stored.size, mime: stored.mime };
      } catch (e) {
        if (e instanceof MediaValidationError) return { error: e.message };
        return { error: `upload failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async listComments(docId) {
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || !canReadDoc(ctx, doc)) return { error: "not found" };
      return { comments: await listComments(ctx.sql, docId) };
    },

    async addComment(docId, body) {
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || !canReadDoc(ctx, doc)) return { error: "not found" };
      if (!canCommentDoc(ctx, doc)) return { error: "no comment access" };
      const c = await addComment(ctx.sql, { docId, author: ctx.alias, body, parentNum: null });
      recordEvent(ctx, "comment.added", docId, { num: c.num, parent_num: null, excerpt: body.slice(0, 140) });
      return { ...c };
    },

    async listFolders() {
      // Summaries, as REST lists them: no grants, and no instructions (those come with the items beneath).
      const folders = await listFolders(ctx.sql, ctx.principals, ctx.workspaceId, undefined, { scopeFolderIds: scopeFolderIds(ctx) });
      return { folders: folders.map(folderSummary) };
    },

    async pollEvents({ after, types, limit }) {
      const latest = await latestWorkspaceEventId(ctx.sql, ctx.workspaceId);
      // No cursor means "from now": the whole retained history does not belong in the agent's context.
      const start = after ?? latest;
      const events = await listWorkspaceEvents(ctx.sql, {
        workspaceId: ctx.workspaceId,
        principals: ctx.principals,
        after: start,
        types,
        scopeFolderIds: scopeFolderIds(ctx),
        limit: limit ?? 50,
      });
      return {
        events: events.map((e) => ({ id: Number(e.id), at: e.at, type: e.type, doc_id: e.doc_id, actor: e.actor, actor_kind: e.actor_kind, payload: e.payload })),
        cursor: events.length > 0 ? Number(events[events.length - 1]!.id) : start,
        latest,
      };
    },

    listCollections: () => listPersonCollections(ctx),
    openCollection: async (collectionId) => refusalText(await openCollection(ctx, collectionId)),
    createCollection: async (name) => refusalText(await createPersonCollection(ctx, name)),
    renameCollection: async (collectionId, name) => refusalText(await renamePersonCollection(ctx, collectionId, name)),
    deleteCollection: async (collectionId) => refusalText(await deletePersonCollection(ctx, collectionId)),
    changeCollectionItems: async (collectionId, change, items) =>
      refusalText(await changePersonCollectionItems(ctx, collectionId, change, { docIds: items.doc_ids, folderIds: items.folder_ids })),

    retrieve: async (query) => orCollectionNotFound(await retrievePassages(ctx, query)),

    async databaseSchema(databaseId, opts) {
      const doc = await authorizedDatabase(ctx, databaseId);
      if (!doc) return NOT_FOUND;
      const [res, instructions] = await Promise.all([
        callDatabaseActor(ctx, databaseId, `schema?agent=${encodeURIComponent(ctx.alias)}`, null, "GET"),
        opts?.instructions === false ? {} : docAgentInstructions(ctx, doc),
      ]);
      const schema = await actorJson<DatabaseSchema>(res, "could not load the database schema");
      return "error" in schema ? schema : { ...schema, ...instructions };
    },

    async databaseRuns(databaseId) {
      if (!(await authorizedDatabase(ctx, databaseId))) return NOT_FOUND;
      const res = await callDatabaseActor(ctx, databaseId, `runs?limit=${RUNS_PAGE}`, null, "GET");
      const body = await actorJson<{ runs: DatabaseRunSummary[] }>(res, "could not load run status");
      if ("error" in body) return body;
      return body.runs.filter((r) => r.agent_alias === ctx.alias);
    },

    async mutateDatabase(databaseId, mutation) {
      const doc = await writableDatabase(databaseId);
      if ("error" in doc) return doc;
      // A write needs no schema read, so the answer names what governs this database; the schema carries the text.
      const labels = () => docInstructionLabelsOrNone(ctx, doc);
      if (mutation.action === "create_table" && mutation.columns?.length) {
        const specs = parseColumnSpecs(mutation.columns);
        if (!specs.ok) return { error: specs.message };
        return proposeAnswer(await proposeTableWithColumns(ctx, doc, mutation.display, specs.columns, "connector"), await labels());
      }
      return proposeAnswer(await proposeDatabaseOp(ctx, doc, databaseOp(mutation), "connector"), await labels());
    },

    async openRowPage(databaseId, tableId, rowId) {
      const doc = await authorizedDatabase(ctx, databaseId);
      if (!doc) return NOT_FOUND;
      const out = await openRowPage(ctx, doc, tableId, rowId);
      if (out.kind === "error") return { error: out.message };
      return { doc_id: out.doc_id, created: out.created, restored: out.restored };
    },

    async findRowPage(databaseId, tableId, rowId) {
      const doc = await authorizedDatabase(ctx, databaseId);
      if (!doc) return NOT_FOUND;
      const out = await findRowPage(ctx, doc, tableId, rowId);
      return out.kind === "error" ? { error: out.message } : { doc_id: out.doc_id };
    },

    async startImport(databaseId, tableId, format) {
      const doc = await writableDatabase(databaseId);
      if ("error" in doc) return doc;
      const staged = await createDatabaseImport(ctx, doc, tableId, format);
      if ("error" in staged) return { error: staged.error };
      const { import_id, upload_url, upload_path, max_bytes, expires_at, import_page_url } = staged.ticket;
      return { import_id, upload_url, upload_path, max_bytes, expires_at, import_page_url };
    },

    async importRows(databaseId, tableId, source, options): Answer<ImportOutcome> {
      const doc = await writableDatabase(databaseId);
      if ("error" in doc) return doc;
      const opts = parseCommitOptions({ ...options });
      if ("error" in opts) return opts;
      if (source.kind === "import_id") return commitDatabaseImport(ctx, doc, source.import_id, opts, "connector");
      const handOff = (why: string): ImportOutcome => ({ hand_off: { page_url: importPageUrl(ctx.env.publicOrigin, databaseId, tableId!), why } });
      if (source.content.length > DATABASE_IMPORT_INLINE_MAX_CHARS) {
        return handOff(`That is ${source.content.length} characters, past the ${DATABASE_IMPORT_INLINE_MAX_CHARS} a tool call may carry.`);
      }
      const staged = await createDatabaseImport(ctx, doc, tableId, source.format ?? "csv");
      if ("error" in staged) return { error: staged.error };
      const body = await stageInlineImport(ctx, doc, staged.ticket.import_id, source.content);
      if (body.status >= 400) return handOff(String(body.body.error));
      return commitDatabaseImport(ctx, doc, staged.ticket.import_id, opts, "connector");
    },

    async query(databaseId, sql, params) {
      if (!(await authorizedDatabase(ctx, databaseId))) return NOT_FOUND;
      const res = await callDatabaseActor(ctx, databaseId, "query", { sql, params });
      return actorJson<Record<string, unknown>>(res, "query failed");
    },
  };
}

/** The actor op one mutation proposes. */
function databaseOp(m: DatabaseMutation): Record<string, unknown> {
  switch (m.action) {
    case "create_table":
      return { kind: "tables.create", display: m.display };
    case "add_column":
      return { kind: "columns.add", table: m.table_id, display: m.display, type: m.type, choices: m.choices, description: m.description };
    case "insert_rows":
      return { kind: "rows.insert", table: m.table_id, rows: m.rows };
    case "update_rows":
      return { kind: "rows.update", table: m.table_id, updates: m.updates };
    case "delete_rows":
      return { kind: "rows.delete", table: m.table_id, row_ids: m.row_ids };
    case "create_view":
      return { kind: "views.create", table: m.table_id, ...viewOpFields(m.view) };
    case "update_view":
      return { kind: "views.update", table: m.table_id, view: m.view_id, ...viewOpFields(m.changes) };
  }
}

function viewOpFields({ kind, ...rest }: ViewShape): Record<string, unknown> {
  return kind === undefined ? rest : { ...rest, view_kind: kind };
}

function proposeAnswer(
  outcome: DatabaseProposeOutcome,
  instructions: ProposeInstructionLabels = {},
): DatabaseProposeBody | { error: string } {
  return outcome.kind === "error" ? { error: outcome.message } : { ...databaseProposeBody(outcome), ...instructions };
}

function refusalText<T extends object>(out: T | CollectionRefusal): T | { error: string } {
  return isCollectionRefusal(out) ? { error: out.error } : (out as T);
}

function orCollectionNotFound<T>(answer: T | "not-found"): T | { error: string } {
  return answer === "not-found" ? { error: "collection not found" } : answer;
}
