/**
 * The real DatabaseActor on the in-memory host. node:sqlite refuses boolean and
 * undefined bindings and binds every JS number as REAL, so tests exercise the
 * same storage classes the node does.
 */
import { MemoryActorState, MemoryBlobStore, MemoryJobQueue } from "@stuga/runtime/testing";
import type { BlobStore } from "@stuga/runtime";
import { DATABASE_OPS_KEEP } from "@stuga/protocol/databases/limits";
import type { DatabaseActor as DatabaseActorIdentity } from "@stuga/protocol/databases/types";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { DatabaseActor } from "../src/database-actor.js";
import type { DatabaseActorEnv } from "../src/env.js";
import type { SessionMeta } from "../src/sockets.js";

export interface Harness {
  state: MemoryActorState<SessionMeta>;
  snapshots: BlobStore;
  jobs: MemoryJobQueue<IndexMessage>;
  env: DatabaseActorEnv;
}

export function makeState(snapshots: BlobStore = new MemoryBlobStore()): Harness {
  const jobs = new MemoryJobQueue<IndexMessage>();
  return { state: new MemoryActorState<SessionMeta>(), snapshots, jobs, env: { snapshots, jobs } };
}

export const DB_ID = "db_test";

export const HUMAN: DatabaseActorIdentity = { alias: "user:liv", is_agent: false };
export const AGENT: DatabaseActorIdentity = { alias: "agent:claude", is_agent: true, on_behalf_of: "user:liv" };

export function makeActor(h: Harness = makeState()): { actor: DatabaseActor; h: Harness } {
  return { actor: new DatabaseActor(h.state, h.env), h };
}

/**
 * A request as the node sends it: `?dbId=` always, a JSON body with the
 * node's retention on POSTs. `path` may carry a query string; no body sends a GET.
 */
export async function doFetch(actor: DatabaseActor, path: string, body?: unknown, opts: { dbId?: string } = {}): Promise<Response> {
  const url = new URL(`http://actor${path}`);
  url.searchParams.set("dbId", opts.dbId ?? DB_ID);
  const req =
    body === undefined
      ? new Request(url.toString())
      : new Request(url.toString(), {
          method: "POST",
          body: JSON.stringify(body !== null && typeof body === "object" ? { ops_keep: DATABASE_OPS_KEEP, ...body } : body),
          headers: { "content-type": "application/json" },
        });
  return actor.fetch(req);
}

/** doFetch and parse, asserting the status. */
export async function doJson<T = Record<string, unknown>>(
  actor: DatabaseActor,
  path: string,
  body?: unknown,
  expectStatus = 200,
  opts: { dbId?: string } = {},
): Promise<T> {
  const res = await doFetch(actor, path, body, opts);
  const parsed = (await res.json()) as T;
  if (res.status !== expectStatus) {
    throw new Error(`${path}: expected ${expectStatus}, got ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

/** A /runs/propose body as the node sends it for a connector agent. */
export function proposeBody(op: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: AGENT,
    source: "connector",
    agent: "Claude (Test)",
    reviewer: HUMAN.alias,
    workspace_id: "ws_test",
    doc_title: "Test DB",
    op,
    ...extra,
  };
}

/** A table's column id by display name. */
export function colId(table: { columns: Array<{ column_id: string; display: string }> }, display: string): string {
  return table.columns.find((c) => c.display === display)!.column_id;
}

/** Init the starter schema as a human and return its table. */
export async function initStarter(actor: DatabaseActor): Promise<{
  table_id: string;
  name: string;
  display: string;
  columns: Array<{ column_id: string; name: string; display: string; type: string; options: { choices?: string[] } | null }>;
}> {
  const out = await doJson<{ schema: { tables: never[] } }>(actor, "/schema/init", { actor: HUMAN });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (out.schema.tables as any[])[0];
}

export async function blobKeys(store: BlobStore, prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(prefix === undefined ? { cursor } : { prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export async function hasBlob(store: BlobStore, key: string): Promise<boolean> {
  return (await store.head(key)) !== null;
}

/** Drop every object, as a GC sweep would. */
export async function clearBlobs(store: BlobStore): Promise<void> {
  for (const key of await blobKeys(store)) await store.delete(key);
}
