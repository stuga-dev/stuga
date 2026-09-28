/**
 * Files held between an import's check and its go-ahead: what a person uploaded, checked and kept
 * in the snapshots store until they import it, cancel, or it expires, so a large export is sent
 * once and imported only after its importer has seen what it leaves out. One per person: holding
 * another drops theirs.
 *   workspace-imports/<alias>/<importId>.zip
 */
import { randomBytes } from "node:crypto";
import type { NodeEnv } from "../env.js";

const PREFIX = "workspace-imports/";
/** How long a checked file waits for its importer. */
export const HELD_IMPORT_TTL_MS = 60 * 60_000;

/** `wsi_<expiry base36>_<random>`: the expiry rides in the id, so a listing finds stale ones unopened. */
function newHeldImportId(now: number): string {
  return `wsi_${(now + HELD_IMPORT_TTL_MS).toString(36)}_${randomBytes(9).toString("hex")}`;
}

/** When a held import's id says it expires, or null for no id of ours. */
export function heldImportExpiry(importId: string): number | null {
  const m = /^wsi_([0-9a-z]+)_[0-9a-f]{18}$/.exec(importId);
  return m ? parseInt(m[1]!, 36) : null;
}

const keyOf = (alias: string, importId: string): string => `${PREFIX}${alias}/${importId}.zip`;

async function keysUnder(env: Pick<NodeEnv, "snapshots">, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.snapshots.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Hold `bytes` for `alias`, dropping any file held for them before. */
export async function holdImport(env: Pick<NodeEnv, "snapshots">, alias: string, bytes: Uint8Array, now = Date.now()): Promise<{ importId: string; expiresAt: number }> {
  const earlier = await keysUnder(env, `${PREFIX}${alias}/`);
  if (earlier.length) await env.snapshots.delete(earlier);
  const importId = newHeldImportId(now);
  await env.snapshots.put(keyOf(alias, importId), bytes, { httpMetadata: { contentType: "application/zip" } });
  return { importId, expiresAt: heldImportExpiry(importId)! };
}

/** The file held for `alias` as `importId`, or null when there is none, or it has expired. */
export async function heldImport(env: Pick<NodeEnv, "snapshots">, alias: string, importId: string, now = Date.now()): Promise<Uint8Array | null> {
  const expiry = heldImportExpiry(importId);
  if (expiry === null || expiry < now) return null;
  const obj = await env.snapshots.get(keyOf(alias, importId)).catch(() => null);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

export async function dropHeldImport(env: Pick<NodeEnv, "snapshots">, alias: string, importId: string): Promise<void> {
  if (heldImportExpiry(importId) === null) return;
  await env.snapshots.delete(keyOf(alias, importId));
}

/** Delete every expired held import on the node. Returns how many went. */
export async function sweepHeldImports(env: Pick<NodeEnv, "snapshots">, now: number): Promise<number> {
  const stale = (await keysUnder(env, PREFIX)).filter((key) => {
    const expiry = heldImportExpiry(key.slice(key.lastIndexOf("/") + 1).replace(/\.zip$/, ""));
    return expiry !== null && expiry < now;
  });
  if (stale.length) await env.snapshots.delete(stale);
  return stale.length;
}
