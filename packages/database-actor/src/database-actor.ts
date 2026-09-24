/**
 * DatabaseActor: one structured database in the actor's own SQLite. The node
 * authenticates, authorizes and resolves the caller before forwarding, so every
 * route trusts the `actor` it is handed. What the actor enforces is what an
 * authorized caller could still abuse: identifier and value hygiene, resource
 * caps, per-alias rate limits, read-only agent SQL, and a revertible ledger
 * entry for every mutation.
 */
import { selectOnlyViolation } from "@stuga/protocol/databases/sql-guard";
import type { DatabaseRunUpdatedPayload } from "@stuga/protocol/wire/db-socket";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { SocketPair, upgradeResponse, type Actor, type ActorState } from "@stuga/runtime";
import { Database } from "./database.js";
import type { DatabaseActorEnv } from "./env.js";
import { handleOpsList, handleOpsRevert, handleRunAck, handleRunDecide, handleRunDetail, handleRunList, handleRunRevert } from "./ledger/decide.js";
import { handleRunPropose } from "./ledger/propose.js";
import { openRunOf, outstandingRunsFor, pendingCountOf } from "./ledger/runs.js";
import { commitOp, opDef, type OpPayload } from "./ops/registry.js";
import { SchemaView } from "./ops/schema-view.js";
import { isInitialized, schemaInit } from "./ops/tables.js";
import { projectRows, projectSchema } from "./projection.js";
import { listRowPage } from "./query/row-query.js";
import { runReadOnly } from "./query/sql-guard.js";
import { OpError, errorResponse, parseActor, parseOpsKeep, readJson } from "./request.js";
import { ensureSchema, getTable, readSchema, setMeta, takeDocLinks } from "./schema-ops.js";
import type { SessionMeta } from "./sockets.js";

type Route = (req: Request, url: URL) => Promise<Response> | Response;

export class DatabaseActor implements Actor<SessionMeta> {
  private readonly db: Database;
  private readonly routes: Record<string, Route>;
  private schemaReady = false;

  constructor(state: ActorState<SessionMeta>, env: DatabaseActorEnv) {
    this.db = new Database(state, env);
    const mutation = (kind: OpPayload["kind"]): Route => (req) => this.mutate(kind, req);
    this.routes = {
      "GET /connect": (req, url) => this.connect(req, url),
      "GET /schema": (_req, url) => Response.json(projectSchema(this.db, readSchema(this.db.sql, this.db.dbId), url.searchParams.get("agent"))),
      "POST /schema/init": (req) => this.init(req),
      "POST /tables/create": mutation("tables.create"),
      "POST /tables/rename": mutation("tables.rename"),
      "POST /tables/delete": mutation("tables.delete"),
      "POST /columns/add": mutation("columns.add"),
      "POST /columns/rename": mutation("columns.rename"),
      "POST /columns/set-type": mutation("columns.set_type"),
      "POST /columns/set-description": mutation("columns.set_description"),
      "POST /columns/delete": mutation("columns.delete"),
      "POST /views/create": mutation("views.create"),
      "POST /views/update": mutation("views.update"),
      "POST /views/delete": mutation("views.delete"),
      "POST /rows/list": (req) => this.listRows(req),
      "POST /rows/insert": mutation("rows.insert"),
      "POST /rows/update": mutation("rows.update"),
      "POST /rows/delete": mutation("rows.delete"),
      "POST /rows/link-doc": mutation("rows.link_page"),
      "POST /doc-links/take": () => this.takeDocLinks(),
      "POST /query": (req) => this.query(req),
      "GET /ops": (_req, url) => handleOpsList(this.db, url),
      "POST /ops/revert": (req) => handleOpsRevert(this.db, req),
      "GET /runs": (_req, url) => handleRunList(this.db, url),
      "GET /runs/detail": (_req, url) => handleRunDetail(this.db, url),
      "POST /runs/propose": (req) => handleRunPropose(this.db, req),
      "POST /runs/decide": (req) => handleRunDecide(this.db, req),
      "POST /runs/ack": (req) => handleRunAck(this.db, req),
      "POST /runs/revert": (req) => handleRunRevert(this.db, req),
      "POST /set-locked": (_req, url) => this.setLocked(url),
      "POST /destroy": () => this.destroy(),
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      const dbId = url.searchParams.get("dbId");
      if (!dbId) return errorResponse(400, "bad_request", "missing dbId query param");
      this.db.dbId = dbId;
      const route = this.routes[`${req.method} ${url.pathname}`];
      if (!route) return errorResponse(404, "not_found", `no route for ${req.method} ${url.pathname}`);
      if (!this.schemaReady) {
        ensureSchema(this.db.sql);
        this.schemaReady = true;
      }
      return await route(req, url);
    } catch (e) {
      if (e instanceof OpError) return errorResponse(e.status, e.slug, e.message, e.extra);
      console.error("DatabaseActor internal error", {
        databaseId: this.db.dbId,
        route: url.pathname,
        method: req.method,
        err: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return errorResponse(500, "internal", e instanceof Error ? e.message : "internal error");
    }
  }

  private async mutate(kind: OpPayload["kind"], req: Request): Promise<Response> {
    const body = await readJson(req);
    const actor = parseActor(body);
    const keep = parseOpsKeep(body);
    this.db.throttle(actor, "mutation");
    const def = opDef(kind);
    const payload = def.parse(body, SchemaView.live(this.db.sql));
    const unchanged = def.unchanged?.(this.db.sql, payload);
    if (unchanged) return Response.json(unchanged);
    return Response.json(await commitOp(this.db, def, payload, { actor, keep }));
  }

  /** Idempotent: a second init adds nothing, whatever it names. */
  private async init(req: Request): Promise<Response> {
    const body = await readJson(req);
    const actor = parseActor(body);
    const keep = parseOpsKeep(body);
    this.db.throttle(actor, "mutation");
    const sql = this.db.sql;
    if (isInitialized(sql)) return Response.json({ initialized: false, schema: readSchema(sql, this.db.dbId) });
    await commitOp(this.db, schemaInit, schemaInit.parse(body, SchemaView.live(sql)), { actor, keep });
    return Response.json({ initialized: true, schema: readSchema(sql, this.db.dbId) });
  }

  /** An agent (`agent_alias`, set by the node from the verified credential) reads its own pending row ops laid over the page. */
  private async listRows(req: Request): Promise<Response> {
    const body = await readJson(req);
    const meta = getTable(this.db.sql, body.table_id);
    const { page, offset } = listRowPage(this.db.sql, meta, body);
    const agentAlias = typeof body.agent_alias === "string" && body.agent_alias !== "" ? body.agent_alias : null;
    const projected = agentAlias ? await projectRows(this.db, meta.table_id, agentAlias, page, { offset }) : null;
    return Response.json(projected ? { ...page, ...projected } : page);
  }

  /** The node's inbox of pages to trash or restore, read and cleared together. */
  private takeDocLinks(): Response {
    const sql = this.db.sql;
    return Response.json(this.db.storage.transactionSync(() => ({ trash: takeDocLinks(sql, "trash"), restore: takeDocLinks(sql, "restore") })));
  }

  /** The node's select-only check is for fast feedback; this copy of the guard is the enforcement, and the rollback underneath is the backstop. */
  private async query(req: Request): Promise<Response> {
    const body = await readJson(req);
    const actor = parseActor(body);
    this.db.throttle(actor, "query");
    if (typeof body.sql !== "string") throw new OpError(400, "validation", "sql must be a string");
    const violation = selectOnlyViolation(body.sql);
    if (violation) throw new OpError(400, "select_only", violation);
    const params = body.params ?? [];
    if (!Array.isArray(params)) throw new OpError(400, "validation", "params must be an array");
    if (params.some((p) => p !== null && typeof p !== "string" && typeof p !== "number")) {
      throw new OpError(400, "validation", "params must be strings, numbers, or null");
    }
    let result: Record<string, unknown>;
    try {
      result = { ...runReadOnly(this.db.storage, body.sql, params) };
    } catch (e) {
      // Only SQLite runs in here, so anything thrown is about the query.
      throw new OpError(400, "sql_error", e instanceof Error ? e.message : String(e));
    }
    // SQL reads live data only; without this an agent reads its unreviewed rows as missing and proposes them again.
    const run = actor.is_agent ? openRunOf(this.db.sql, actor.alias) : null;
    const pending = run ? pendingCountOf(this.db.sql, run.run_id) : 0;
    if (run && pending > 0) {
      result.pending_note = `Results reflect live data only — your ${pending} proposed change(s) (run ${run.run_id}) are awaiting the user's review and are not included.`;
    }
    return Response.json(result);
  }

  /**
   * A socket that carries run and "rows changed" frames. A person's fresh
   * socket replays the runs they still owe a decision on or have not seen.
   */
  private async connect(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const meta: SessionMeta = { alias: url.searchParams.get("alias") ?? "anonymous", agentAuth: url.searchParams.get("agentAuth") === "1" };
    const { client, server } = new SocketPair<SessionMeta>();
    this.db.state.acceptWebSocket(server, meta);
    if (!meta.agentAuth) {
      for (const run of outstandingRunsFor(this.db.sql, meta.alias)) {
        this.db.sockets.send(server, encodeJson(Opcode.DB_RUN_UPDATED, { run: await this.db.runSummary(run) } satisfies DatabaseRunUpdatedPayload));
      }
    }
    return upgradeResponse(client);
  }

  /** docs.locked, mirrored by the node so a proposal cannot land in a database just frozen. */
  private setLocked(url: URL): Response {
    setMeta(this.db.sql, "locked", url.searchParams.get("locked") === "1" ? "1" : "0");
    return Response.json({ locked: this.db.locked() });
  }

  /** Wipe the actor; the next request rebuilds an empty shell. A spill left behind is a harmless orphan. */
  private async destroy(): Promise<Response> {
    await this.db.storage.deleteAll();
    this.schemaReady = false;
    this.db.rate.clear();
    const bucket = this.db.bucket;
    for (const prefix of [`${this.db.dbId}/db-ops/`, `${this.db.dbId}/db-runs/`]) {
      try {
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix, cursor });
          for (const obj of page.objects) await bucket.delete(obj.key);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      } catch {
        /* best-effort */
      }
    }
    return Response.json({ destroyed: true });
  }
}
