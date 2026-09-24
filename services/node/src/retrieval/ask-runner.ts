/**
 * The read-only tools of the cross-document ask agent. It runs in the request
 * layer because every tool needs Postgres. Each tool applies the caller's own
 * ACL, so the model reaches only what the person can; `scopeDocIds` narrows
 * that further and never widens it: with a collection selected, every tool
 * lists, reads, searches and queries inside it or refuses.
 */
import { listReadableDocs, listFolders, getFolder, getFolderSubtreeIds, listDocs, listAncestorFolderIds } from "@stuga/db";
import { DATABASE_ASK_QUERY_MAX_ROWS } from "@stuga/protocol/databases/limits";
import { selectOnlyViolation } from "@stuga/protocol/databases/sql-guard";
import type { ColumnSpec, DatabaseSchema, TableSchema } from "@stuga/protocol/databases/types";
import { describeFilter } from "@stuga/protocol/databases/filters";
import { LIST_LIMIT } from "@stuga/ai";
import type { AiConfig, AskToolRunner } from "@stuga/ai";
import { passageCitations } from "./passages.js";
import { retrieveAndRerank } from "./retrieve.js";
import { DATABASE_OUTSIDE_COLLECTION, OUTSIDE_COLLECTION } from "./scope.js";
import { readDocMarkdownWithProjection, databaseDocMessage } from "../agents/edits.js";
import { authorizedDatabase, callDatabaseActor } from "../databases/gate.js";
import { canReadFolder, scopeFolderIds } from "../authz/authz.js";
import type { Ctx } from "../auth/context.js";

/** Databases one list_databases call describes, schemas included. */
const DATABASES_MAX = 20;

/** One column: its physical name, type, display name, what it may hold, and the note whoever built it wrote. */
function describeColumn(c: ColumnSpec): string {
  const display = c.display !== c.name ? ` ("${c.display}")` : "";
  // A select's values decide whether a WHERE matches at all, so they go in every listing.
  const choices = c.options?.choices?.length ? ` one of: ${c.options.choices.map((v) => `'${v}'`).join(", ")}` : "";
  // The human note is what says "USD, net of refunds" where the name and type say only "number".
  const note = c.description ? ` — "${c.description.replace(/\s+/g, " ").trim()}"` : "";
  return `${c.name} ${c.type}${display}${choices}${note}`;
}

/** The saved views of one table, as what each selects; a view is not a SQL object, so it reads as words. */
function describeViews(t: TableSchema): string {
  const named = new Map(t.columns.map((c) => [c.column_id, c.name]));
  const parts = (t.views ?? [])
    .map((v) => {
      const where = v.filter ? describeFilter(v.filter, (id) => named.get(id) ?? id) : "";
      return where ? `${v.name} = ${where}` : "";
    })
    .filter(Boolean);
  return parts.length > 0 ? `\n  saved views (what the people here mean by these words): ${parts.join("; ")}` : "";
}

/** One database's schema as a compact, model-readable block. Exported for its unit test: this text is what the SQL is written from. */
export function describeSchema(schema: DatabaseSchema): string {
  if (schema.tables.length === 0) return "(no tables)";
  return schema.tables
    .map((t) => {
      const cols = t.columns.map(describeColumn).join(", ");
      return `table ${t.name}${t.display !== t.name ? ` ("${t.display}")` : ""} [${t.row_count ?? "?"} rows]: _id, ${cols}${describeViews(t)}`;
    })
    .join("\n");
}

export interface AskRunnerArgs {
  ctx: Ctx;
  aiCfg: AiConfig;
  /** Collection-expanded doc ids; null = every document the caller can see. */
  scopeDocIds: string[] | null;
  /** Passages returned per search. */
  topN?: number;
}

export interface AskRunnerHandle {
  runner: AskToolRunner;
  /** True once any search ran without its semantic leg (the embedding failed). */
  degraded(): boolean;
}

export function createAskRunner(args: AskRunnerArgs): AskRunnerHandle {
  const { ctx, aiCfg, scopeDocIds } = args;
  const topN = args.topN ?? 8;
  let sawDegraded = false;
  const scope = scopeDocIds === null ? null : new Set(scopeDocIds);
  const inScope = (id: string): boolean => scope === null || scope.has(id);
  // Folders are shown under a collection only when they lead to one of its documents.
  let scopeFolders: Promise<Set<string>> | null = null;
  const foldersInScope = (): Promise<Set<string>> =>
    (scopeFolders ??= listAncestorFolderIds(ctx.sql, scopeDocIds ?? [], ctx.workspaceId).then((ids) => new Set(ids)));

  const runner: AskToolRunner = {
    // Never throws: a failure is text the model can act on, where an exception would end the turn.
    search: async ({ query, offset }) => {
      try {
        const { chunks, degraded } = await retrieveAndRerank({
          sql: ctx.sql,
          embeddingDims: ctx.env.embeddingDims,
          searchLanguages: ctx.env.searchLanguages,
          aiCfg,
          alias: ctx.alias,
          principals: ctx.principals,
          workspaceId: ctx.workspaceId,
          query,
          scopeDocIds,
          scopeFolderIds: scopeFolderIds(ctx),
          topN,
        });
        if (degraded) sawDegraded = true;
        if (chunks.length === 0) {
          // Rephrasing helps an unlucky query and not an empty collection.
          return {
            text:
              scopeDocIds !== null && scopeDocIds.length === 0
                ? "That collection is empty, so there is nothing to search."
                : "No relevant passages found. Try different wording.",
            citations: [],
          };
        }
        // The doc id lets the model open a passage that is only a lead.
        const text = chunks
          .map(
            (c, i) =>
              `[${offset + i + 1}] ${c.title || "Untitled"}${c.heading_path ? ` — ${c.heading_path}` : ""} (doc: ${c.doc_id})\n${c.content}`,
          )
          .join("\n\n");
        return { text, citations: passageCitations(chunks, offset) };
      } catch (e) {
        return { text: `Search failed: ${e instanceof Error ? e.message : String(e)}`, citations: [] };
      }
    },

    // Every refusal is the same null, so read_document cannot probe for documents the caller cannot see.
    readDocument: async ({ doc_id, offset = 0, length }) => {
      if (!inScope(doc_id)) return { error: OUTSIDE_COLLECTION };
      const md = await readDocMarkdownWithProjection(ctx, doc_id);
      if (md === null) return null;
      // Said outright, or the model concludes the document is empty.
      if (md === "database") return { title: "", text: databaseDocMessage(doc_id), total: 0 };
      const full = md.markdown;
      const start = Math.min(Math.max(0, offset), full.length);
      return { title: md.doc.title, text: full.slice(start, start + (length ?? full.length)), total: full.length };
    },

    // The folder is checked before its subtree is expanded: getFolderSubtreeIds has no ACL gate.
    listDocuments: async ({ query, folder_id }) => {
      let parentIds: string[] | undefined;
      if (folder_id) {
        const folder = await getFolder(ctx.sql, folder_id);
        const visible = folder !== null && canReadFolder(ctx, folder);
        if (!visible) return { docs: [], folders: [], folderMissing: true };
        parentIds = await getFolderSubtreeIds(ctx.sql, folder_id, ctx.workspaceId);
      }
      const [docs, folders] = await Promise.all([
        listReadableDocs(ctx.sql, ctx.principals, ctx.workspaceId, {
          q: query,
          parentIds,
          docIds: scopeDocIds,
          limit: LIST_LIMIT,
          scopeFolderIds: scopeFolderIds(ctx),
        }),
        // Immediate children only: the document list already spans the subtree.
        listFolders(ctx.sql, ctx.principals, ctx.workspaceId, folder_id ?? null, { scopeFolderIds: scopeFolderIds(ctx) }),
      ]);
      const leading = scopeDocIds === null ? null : await foldersInScope();
      return {
        docs,
        folders: folders.filter((f) => !leading || leading.has(f.folder_id)).map((f) => ({ folder_id: f.folder_id, title: f.title })),
      };
    },

    // Schemas come up front: the model writes SQL against physical names.
    listDatabases: async () => {
      const docs = await listDocs(ctx.sql, ctx.principals, ctx.workspaceId, { scopeFolderIds: scopeFolderIds(ctx) });
      const dbs = docs.filter((d) => d.doc_type === "database" && inScope(d.doc_id)).slice(0, DATABASES_MAX);
      const out: Array<{ database_id: string; title: string; schema: string }> = [];
      for (const d of dbs) {
        const res = await callDatabaseActor(ctx, d.doc_id, "schema", null, "GET").catch(() => null);
        const schema = res?.ok ? ((await res.json().catch(() => null)) as DatabaseSchema | null) : null;
        out.push({ database_id: d.doc_id, title: d.title, schema: schema ? describeSchema(schema) : "(schema unavailable)" });
      }
      return out;
    },

    // The gates of POST /api/databases/:id/query; a refusal is text the model can correct from.
    queryDatabase: async ({ database_id, sql }) => {
      if (!inScope(database_id)) return { error: DATABASE_OUTSIDE_COLLECTION };
      const doc = await authorizedDatabase(ctx, database_id);
      if (!doc) return { error: `no database ${database_id} you can read` };
      const violation = selectOnlyViolation(sql);
      if (violation) return { error: violation };
      const res = await callDatabaseActor(ctx, database_id, "query", { sql, params: [] }).catch(() => null);
      if (!res) return { error: "the database did not answer" };
      const body = (await res.json().catch(() => null)) as
        | { columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; message?: string; error?: string }
        | null;
      if (!res.ok) return { error: body?.message ?? body?.error ?? `query failed (${res.status})` };
      const columns = Array.isArray(body?.columns) ? body!.columns! : [];
      const rows = Array.isArray(body?.rows) ? body!.rows! : [];
      return {
        title: doc.title,
        columns,
        // The actor answers a row as an object keyed by column name; the agent renders rows as cells in column order.
        rows: rows.slice(0, DATABASE_ASK_QUERY_MAX_ROWS).map((r) => (Array.isArray(r) ? r : columns.map((c) => r?.[c] ?? null))),
        truncated: Boolean(body?.truncated) || rows.length > DATABASE_ASK_QUERY_MAX_ROWS,
      };
    },
  };

  return { runner, degraded: () => sawDegraded };
}
