/**
 * `stuga-node media-scan`: reclaim media no document points at any more. Safe because:
 *  1. the reachable set is computed before the object list, so an object uploaded mid-run is new;
 *  2. objects inside the grace window are never touched (an image is stored before its link is flushed);
 *  3. a corrupt snapshot aborts the run, since the reachable set is then incomplete;
 *  4. reclaiming moves to `trash/`, and only `--empty-trash` destroys, past a retention window.
 */
import type { MediaRef } from "@stuga/db";
import { failedChanged, refused, type ExitCode } from "../ops/outcome.js";
import {
  type Page,
  type ScanEnv,
  type StoredObject,
  destroyTrashed,
  listMediaObjects,
  listTrash,
  referencesInBodies,
  referencesInSnapshots,
  trashObjects,
} from "./media-scan.js";

export const MEDIA_SCAN_USAGE = "stuga-node media-scan [--reclaim] [--empty-trash[=<days>]] [--grace-hours=<hours>]";

const key = (r: MediaRef) => `${r.workspace}/${r.hash}`;
const human = (b: number) =>
  b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)}G` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}M` : `${Math.ceil(b / 1024)}K`;

/** Every object a document body, hidden body or retained version snapshot still points at. */
async function reachableSet(env: ScanEnv, say: (line: string) => void): Promise<{ refs: Set<string>; corrupt: string[] }> {
  const refs = new Set<string>();
  const corrupt: string[] = [];

  let cursor: string | null = null;
  let bodies = 0;
  do {
    const page = await referencesInBodies(env, cursor);
    for (const r of page.items) refs.add(key(r));
    bodies += page.scanned;
    cursor = page.next;
  } while (cursor);
  say(`  bodies:    ${bodies} scanned, ${refs.size} referenced objects`);

  const afterBodies = refs.size;
  let snapshots = 0;
  let pruned = 0;
  do {
    const page = await referencesInSnapshots(env, cursor);
    for (const r of page.items) refs.add(key(r));
    snapshots += page.scanned;
    pruned += page.pruned;
    corrupt.push(...page.corrupt);
    cursor = page.next;
  } while (cursor);
  say(`  snapshots: ${snapshots} read, ${pruned} already pruned, ${refs.size - afterBodies} further objects`);

  return { refs, corrupt };
}

async function listAll<T>(list: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(cursor);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return out;
}

/** Apply `step` object by object; a failure after the first object landed has changed something. */
async function eachObject(what: string, refs: MediaRef[], step: (ref: MediaRef) => Promise<number>): Promise<number> {
  let done = 0;
  for (const ref of refs) {
    try {
      done += await step({ workspace: ref.workspace, hash: ref.hash });
    } catch (err) {
      if (done === 0) throw err;
      throw failedChanged(`${what} stopped after ${done} objects: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return done;
}

/** Split the unreferenced objects into those still inside the grace window and those that may be reclaimed. */
export function partition(
  objects: StoredObject[],
  reachable: Set<string>,
  nowMs: number,
  graceMs: number,
): { tooNew: StoredObject[]; reclaimable: StoredObject[] } {
  const tooNew: StoredObject[] = [];
  const reclaimable: StoredObject[] = [];
  for (const o of objects) {
    if (reachable.has(key(o))) continue;
    (nowMs - o.uploadedMs < graceMs ? tooNew : reclaimable).push(o);
  }
  return { tooNew, reclaimable };
}

export interface MediaScanOptions {
  reclaim: boolean;
  /** Days an object must have sat in trash/ before it is destroyed; null scans for orphans instead. */
  emptyTrashDays: number | null;
  graceHours: number;
}

/** Parse the command's flags; a refusal names the bad one. */
export function parseMediaScanArgs(argv: string[]): MediaScanOptions {
  const arg = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
  };
  const known = ["--reclaim", "--empty-trash", "--grace-hours"];
  const unknown = argv.find((a) => !known.some((k) => a === k || a.startsWith(`${k}=`)));
  if (unknown) throw refused(`unknown argument ${unknown}\nusage: ${MEDIA_SCAN_USAGE}`);
  const graceHours = Number(arg("grace-hours") ?? 24);
  if (!Number.isFinite(graceHours) || graceHours < 0) throw refused("--grace-hours must be a non-negative number");
  const emptyTrash = arg("empty-trash");
  let emptyTrashDays: number | null = null;
  if (emptyTrash !== undefined) {
    emptyTrashDays = Number(emptyTrash === "" ? 30 : emptyTrash);
    if (!Number.isFinite(emptyTrashDays) || emptyTrashDays < 1) throw refused("--empty-trash needs a retention in days, at least 1");
  }
  return { reclaim: arg("reclaim") !== undefined, emptyTrashDays, graceHours };
}

export async function runMediaScan(
  env: ScanEnv,
  opts: MediaScanOptions,
  say: (line: string) => void,
  now: number = Date.now(),
): Promise<ExitCode> {
  if (opts.emptyTrashDays !== null) {
    const days = opts.emptyTrashDays;
    const trash = await listAll((cursor) => listTrash(env, cursor));
    const stale = trash.filter((t) => t.trashedMs < now - days * 86_400_000);
    const bytes = stale.reduce((n, t) => n + t.size, 0);
    say(`trash: ${trash.length} objects, ${stale.length} older than ${days}d (${human(bytes)})`);
    if (!stale.length) return 0;
    if (!opts.reclaim) {
      say("Nothing destroyed. Add --reclaim to this command to destroy them.");
      return 0;
    }
    const n = await eachObject("destroy", stale, (ref) => destroyTrashed(env, [ref]));
    say(`destroyed ${n} objects, ${human(bytes)} freed. This is not reversible.`);
    return 0;
  }

  say("Building the reachable set (this is what makes reclaiming safe)");
  const { refs, corrupt } = await reachableSet(env, say);

  const objects = await listAll((cursor) => listMediaObjects(env, cursor));
  const total = objects.reduce((n, o) => n + o.size, 0);
  say(`  store:     ${objects.length} objects, ${human(total)}\n`);

  if (corrupt.length) {
    throw refused(
      `REFUSING to reclaim: ${corrupt.length} snapshot(s) could not be decoded, so the reachable\n` +
        `set is a subset of the truth and anything reclaimed now might still be in use.\n` +
        `  ${corrupt.slice(0, 10).join(", ")}${corrupt.length > 10 ? ", …" : ""}`,
    );
  }

  const { tooNew, reclaimable } = partition(objects, refs, now, opts.graceHours * 3_600_000);
  const bytes = reclaimable.reduce((n, o) => n + o.size, 0);

  say(`unreferenced: ${tooNew.length + reclaimable.length} objects`);
  if (tooNew.length) {
    say(
      `  held back:  ${tooNew.length} uploaded in the last ${opts.graceHours}h — an image reaches the\n` +
        `              store before the document linking it is flushed, so a recent one is\n` +
        `              expected to look unreferenced.`,
    );
  }
  say(`  reclaimable: ${reclaimable.length} objects, ${human(bytes)}`);

  if (!reclaimable.length) return 0;
  if (!opts.reclaim) {
    say("\nNothing moved. Add --reclaim to move them to trash/, which is reversible.");
    return 0;
  }

  const moved = await eachObject("trash", reclaimable, async (ref) => (await trashObjects(env, [ref])).moved);
  say(
    `\nmoved ${moved} objects to trash/, ${human(bytes)}. Nothing is destroyed yet — the bytes are\n` +
      `still on disk under trash/, on the key documents already point at.\n` +
      `Empty it later with:  --empty-trash=30 --reclaim`,
  );
  return 0;
}
