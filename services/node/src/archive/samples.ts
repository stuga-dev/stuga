/**
 * Published sample workspaces: the index the node reads from SAMPLES_URL, each sample's archive
 * checked against it, and Sample agent, who proposes a sample's steps once it is imported. The
 * node builds every URL itself from the index's tag and ids, so the index cannot send it anywhere
 * else, and nothing about the node or the person is part of a request.
 */
import { createHash } from "node:crypto";
import { getDirectoryRow } from "@stuga/db";
import type { RowValue } from "@stuga/protocol/databases/types";
import { SAMPLE_AGENT_ALIAS, SAMPLE_AGENT_NAME } from "@stuga/protocol/domain/workspaces";
import type { AiCitation, AiStrEdit } from "@stuga/protocol/wire/doc-socket";
import { type AccountCtx, type Ctx, workspaceContextFor } from "../auth/context.js";
import { routeCaller, type WriteOptions } from "./client.js";
import {
  ArchiveError,
  SAMPLE_ME,
  SAMPLES_INDEX_MAX_BYTES,
  SAMPLES_INDEX_NAME,
  archiveCellValue,
  parseSamplesIndex,
  sampleFileName,
  type ArchiveIndex,
  type SampleEntry,
  type SampleStep,
  type SamplesIndex,
} from "./format.js";
import type { ImportedIds } from "./import.js";

/** How long an index is used before it is read again. */
export const SAMPLES_INDEX_TTL_MS = 60 * 60_000;
/** After a look that failed, how long the node answers from what it has before it looks again. */
export const SAMPLES_RETRY_MS = 60_000;
const INDEX_TIMEOUT_MS = 15_000;
/** An archive is up to 50 MiB. */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

/** Where the index is: `latest/download` is GitHub's pointer to the newest release's assets. */
export function samplesIndexUrl(base: string): string {
  return `${base}/latest/download/${SAMPLES_INDEX_NAME}`;
}

/** Where a sample's archive is: an asset of the release the index was read from. */
export function sampleArchiveUrl(base: string, tag: string, id: string): string {
  return `${base}/download/${encodeURIComponent(tag)}/${encodeURIComponent(sampleFileName(id))}`;
}

/** A download that failed or did not match the index; the reason is for the log. */
export class SampleDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleDownloadError";
  }
}

/** A response body with a hard byte ceiling, streamed: a server's content-length may lie. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SampleDownloadError(`${declared} bytes, more than ${maxBytes}`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SampleDownloadError(`more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function get(fetchFn: typeof globalThis.fetch, url: string, accept: string, timeoutMs: number, maxBytes: number): Promise<Uint8Array> {
  let res: Response;
  try {
    // No version and no node id: whoever serves the file learns an address asked, and nothing more.
    res = await fetchFn(url, { headers: { accept, "user-agent": "stuga-node" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new SampleDownloadError(timedOut ? `${url} did not answer in time` : `could not reach ${url}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SampleDownloadError(`${url} answered ${res.status}`);
  }
  try {
    return await readCapped(res, maxBytes);
  } catch (err) {
    if (err instanceof SampleDownloadError) throw new SampleDownloadError(`${url}: ${err.message}`);
    throw new SampleDownloadError(`${url}: the download broke off`);
  }
}

export interface SampleCatalog {
  /** The index, read within the hour or kept from the last good look; null when there is none. */
  index(): Promise<SamplesIndex | null>;
  /** Whether the last look failed, as it does offline: the kept index's samples likely cannot be downloaded now. */
  lastLookFailed(): boolean;
  /** A listed sample's archive, of the size and SHA-256 the index gives. Throws a SampleDownloadError. */
  download(index: SamplesIndex, sample: SampleEntry): Promise<Uint8Array>;
}

/**
 * The samples published under `base`. The index is kept in memory: callers share one look, and a
 * look that fails keeps the copy there is, and waits SAMPLES_RETRY_MS before the next.
 */
export function createSampleCatalog(
  base: string,
  opts: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): SampleCatalog {
  // Looked up per call, so a test's stubbed global fetch applies.
  const fetchFn = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = opts.now ?? Date.now;
  let kept: { index: SamplesIndex; at: number } | null = null;
  let failedAt: number | null = null;
  let inflight: Promise<SamplesIndex | null> | null = null;

  async function look(): Promise<SamplesIndex | null> {
    const url = samplesIndexUrl(base);
    try {
      const bytes = await get(fetchFn, url, "application/json", INDEX_TIMEOUT_MS, SAMPLES_INDEX_MAX_BYTES);
      const index = parseSamplesIndex(JSON.parse(new TextDecoder().decode(bytes)), (err) =>
        console.warn("left a sample out of the samples index", { reason: `${url}: ${err.message}` }),
      );
      kept = { index, at: now() };
      failedAt = null;
      return index;
    } catch (err) {
      failedAt = now();
      const reason =
        err instanceof SampleDownloadError ? err.message : err instanceof ArchiveError ? `${url}: ${err.message}` : `${url} is not JSON`;
      console.warn("could not read the samples index", { reason });
      return kept?.index ?? null;
    }
  }

  return {
    async index() {
      const at = now();
      if (kept && at - kept.at < SAMPLES_INDEX_TTL_MS) return kept.index;
      if (failedAt !== null && at - failedAt < SAMPLES_RETRY_MS) return kept?.index ?? null;
      inflight ??= look().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    lastLookFailed: () => failedAt !== null,
    async download(index, sample) {
      const url = sampleArchiveUrl(base, index.tag, sample.id);
      const bytes = await get(fetchFn, url, "application/zip", ARCHIVE_TIMEOUT_MS, sample.bytes);
      if (bytes.byteLength !== sample.bytes) throw new SampleDownloadError(`${url}: ${bytes.byteLength} bytes, not the ${sample.bytes} the index lists`);
      if (createHash("sha256").update(bytes).digest("hex") !== sample.sha256) throw new SampleDownloadError(`${url}: not the SHA-256 the index lists`);
      return bytes;
    },
  };
}

const catalogs = new Map<string, SampleCatalog>();

/** The node's one catalog of the samples published under `base`. */
export function sampleCatalog(base: string): SampleCatalog {
  let catalog = catalogs.get(base);
  if (!catalog) catalogs.set(base, (catalog = createSampleCatalog(base)));
  return catalog;
}

// ---- Sample agent ------------------------------------------------------------------------------

/** The routes a sample's steps call, as Sample agent. */
export interface SampleAgentClient {
  /** A document's body as Sample agent reads it: with its own pending edits laid over. */
  markdown(docId: string): Promise<string>;
  /** The answer's `mode`. */
  proposeEdits(docId: string, edits: AiStrEdit[], citations: AiCitation[]): Promise<string>;
  /** The answer's `mode`. */
  proposeRowUpdate(databaseId: string, tableId: string, rowId: string, values: Record<string, RowValue>): Promise<string>;
  comment(docId: string, body: string, quote: string | null): Promise<void>;
}

/**
 * Sample agent's writes into the workspace `ctx` names, through the routes an agent's key calls,
 * paced as the import's are: each row step is a mutation the database actor budgets per minute.
 */
export function sampleAgentClient(ctx: Ctx, opts: WriteOptions = {}): SampleAgentClient {
  const enc = encodeURIComponent;
  const call = routeCaller(ctx, opts);
  return {
    async markdown(docId) {
      return (await call<{ markdown: string }>("GET", `/api/docs/${enc(docId)}/markdown`)).markdown;
    },
    async proposeEdits(docId, edits, citations) {
      return (await call<{ mode: string }>("POST", `/api/docs/${enc(docId)}/propose`, { action: "cited_edits", edits, citations })).mode;
    },
    async proposeRowUpdate(databaseId, tableId, rowId, values) {
      const path = `/api/databases/${enc(databaseId)}/tables/${enc(tableId)}/rows`;
      return (await call<{ mode: string }>("PATCH", path, { updates: [{ _id: rowId, values }] })).mode;
    },
    async comment(docId, body, quote) {
      await call("POST", `/api/docs/${enc(docId)}/comments`, { body, anchor_quote: quote });
    },
  };
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && n < 2; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

/**
 * Propose a sample's steps as Sample agent, in order, where the import put what they name. Each
 * proposal must wait for review: an edit whose text the body does not hold once would otherwise
 * be dropped without a word, so each `old_string` is found once first. `me` is the importing
 * person's username. Throws at the first step that does not land.
 */
export async function replaySampleSteps(
  client: SampleAgentClient,
  steps: SampleStep[],
  where: { ids: ImportedIds; index: ArchiveIndex; me: string },
): Promise<void> {
  const { ids, index, me } = where;
  const docId = (path: string): string => ids.docs.get(path)!;
  for (const [i, step] of steps.entries()) {
    const at = `step ${i + 1}`;
    if (step.kind === "edit") {
      let text = await client.markdown(docId(step.doc));
      for (const edit of step.edits) {
        const n = occurrences(text, edit.old_string);
        if (n !== 1) throw new Error(`${at}: ${step.doc} holds an edit's old_string ${n === 0 ? "nowhere" : "more than once"}`);
        const hit = text.indexOf(edit.old_string);
        text = text.slice(0, hit) + edit.new_string + text.slice(hit + edit.old_string.length);
      }
      const citations = (step.citations ?? []).map((c): AiCitation => {
        const title = index.bodies.get(c.doc)!.item.title;
        return { n: c.n, doc_id: docId(c.doc), title, heading_path: c.heading_path ?? null, content: c.content };
      });
      const edits = step.edits.map(({ old_string, new_string }) => ({ old_string, new_string }));
      const mode = await client.proposeEdits(docId(step.doc), edits, citations);
      if (mode !== "proposed") throw new Error(`${at}: the edit to ${step.doc} was ${mode}, not proposed`);
    } else if (step.kind === "row") {
      const db = ids.databases.get(step.database)!;
      const table = db.tables.get(step.table)!;
      const columns = index.databases.get(step.database)!.tables.find((t) => t.name === step.table)!.columns;
      const values: Record<string, RowValue> = {};
      for (const [name, raw] of Object.entries(step.values)) {
        const cell = archiveCellValue(columns.find((c) => c.name === name)!, raw);
        if (!cell.ok) throw new Error(`${at}: ${name}: ${cell.reason}`);
        values[table.columns.get(name)!] = cell.value;
      }
      const mode = await client.proposeRowUpdate(db.docId, table.tableId, table.rows.get(step.row)!, values);
      if (mode !== "proposed") throw new Error(`${at}: the change to row "${step.row}" of ${step.database} was ${mode}, not proposed`);
    } else {
      await client.comment(docId(step.doc), step.body.replaceAll(SAMPLE_ME, `@${me}`), step.quote ?? null);
    }
  }
}

/** Sample agent's account: no key, acting for the person importing the sample, who reviews what it proposes. */
function sampleAgentAccount(importer: AccountCtx): AccountCtx {
  return {
    sql: importer.sql,
    surface: importer.surface,
    alias: SAMPLE_AGENT_ALIAS,
    displayName: SAMPLE_AGENT_NAME,
    isAgent: true,
    onBehalfOf: importer.alias,
    env: importer.env,
    ...(importer.requestId ? { requestId: importer.requestId } : {}),
  };
}

/** The import's sample-steps hook: `importer`'s sample replayed by Sample agent in the workspace just made for them. */
export function sampleStepReplay(
  importer: AccountCtx,
  workspaceId: string,
  index: ArchiveIndex,
  opts: WriteOptions = {},
): (steps: SampleStep[], ids: ImportedIds) => Promise<void> {
  return async (steps, ids) => {
    const ctx = await workspaceContextFor({ account: sampleAgentAccount(importer), workspaces: null, readOnly: false }, workspaceId);
    if (!ctx) throw new Error("Sample agent cannot act in the new workspace");
    const person = await getDirectoryRow(importer.sql, importer.alias);
    if (!person) throw new Error("the importing person has no account");
    await replaySampleSteps(sampleAgentClient(ctx, opts), steps, { ids, index, me: person.username });
  };
}
