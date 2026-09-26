/** GET /api/workspaces/:id/export: the workspace as a `.stuga.zip` archive, for a workspace owner or admin. */
import { ARCHIVE_WORK_MAX_MS } from "@stuga/protocol/domain/workspaces";
import { recordAudit } from "../audit/record.js";
import { error } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { answeredUntil } from "../http/serving-gate.js";
import type { ZipSink } from "../lib/zip.js";
import { ExportRefused, planWorkspaceExport, writeWorkspaceExport, type ExportPlan } from "./export.js";
import { ARCHIVE_EXTENSION } from "./format.js";
import { archiveWorkBegins, archiveWorkHeld } from "./under-way.js";

/** What the response holds unread before the export waits for the client. */
const BUFFERED_BYTES = 1024 * 1024;
/** The most the response is handed at once, so a client reading part of a large image or rows file makes room for more. */
const SLICE_BYTES = 64 * 1024;
/** How long an export waits for its client to read before it stops. */
export const EXPORT_IDLE_MS = 60_000;

/**
 * The people exporting now. Each export holds the entry in hand and what its client has not read,
 * so a person runs one at a time and the node EXPORTS_AT_ONCE.
 */
const exporting = new Set<string>();
const EXPORTS_AT_ONCE = 3;

export async function exportWorkspaceRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  // The context, and the role the route's gate checked, belong to the workspace the header names.
  if (match[1] !== ctx.workspaceId) return error(400, "x-stuga-workspace must name the workspace being exported");
  if (exporting.has(ctx.alias)) return error(409, "you are already exporting a workspace; try again when it is done");
  if (exporting.size >= EXPORTS_AT_ONCE) return error(409, "other workspaces are being exported on this node; try again when one is done");
  const held = archiveWorkHeld();
  if (held) return error(409, held);
  exporting.add(ctx.alias);
  // Planned, then written for as long as the client takes to read it, within ARCHIVE_WORK_MAX_MS: a backup waits until it ends.
  const underWay = archiveWorkBegins();
  const ended = (): void => {
    exporting.delete(ctx.alias);
    underWay();
  };
  let plan: ExportPlan;
  try {
    plan = await planWorkspaceExport(ctx);
  } catch (err) {
    ended();
    if (err instanceof ExportRefused) return error(err.status, err.message);
    throw err;
  }
  let written!: () => void;
  const done = new Promise<void>((resolve) => (written = resolve));
  const body = zipStream(
    (sink) => writeWorkspaceExport(ctx, plan, sink),
    (finished, bytes) => {
      // A copy leaves the node, finished or not, so the row says how much of one did.
      recordAudit(ctx, {
        action: "workspace.export",
        targetKind: "workspace",
        targetId: ctx.workspaceId,
        targetLabel: plan.workspace.name,
        detail: { docs: plan.docs.size, databases: plan.databases.length, bytes, ...(finished ? {} : { finished: false }) },
      });
      ended();
      written();
    },
    ctx.workspaceId,
  );
  const response = new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": attachment(plan.workspace.name),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
  // Counted as being answered until the archive is written, which happens as it is sent.
  return answeredUntil(response, done);
}

/**
 * A response body that `write` fills with an archive one entry at a time, waiting while the
 * client has not read what is buffered. The download breaks, and the writing stops at its next
 * entry, when the client reads nothing for EXPORT_IDLE_MS, or the archive is not written within
 * ARCHIVE_WORK_MAX_MS, whatever the writing waits on then. `settled` hears, once, whether the
 * archive was finished, and how many bytes were sent.
 */
function zipStream(
  write: (sink: ZipSink) => Promise<void>,
  settled: (finished: boolean, bytes: number) => void,
  workspaceId: string,
): ReadableStream<Uint8Array> {
  let wake: (() => void) | null = null;
  /** Why the writing stops before the archive is done. */
  let stopped: Error | null = null;
  let bytes = 0;
  const resume = (): void => {
    wake?.();
    wake = null;
  };
  /** Stop the writing and end the download now; a client that went away hears nothing, and no failure is logged. */
  let stop!: (why: string, clientLeft?: boolean) => void;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let ended = false;
        /** The archive whole (null), or the download broken for `failure`. What the writing does after is moot. */
        const end = (failure: Error | null, clientLeft = false): void => {
          if (ended) return;
          ended = true;
          clearTimeout(deadline);
          settled(failure === null, bytes);
          if (failure === null) return controller.close();
          if (clientLeft) return;
          console.error("workspace export failed", { workspaceId, error: failure.message });
          controller.error(failure);
        };
        stop = (why, clientLeft = false) => {
          stopped ??= new Error(why);
          resume();
          end(stopped, clientLeft);
        };
        const deadline = setTimeout(() => stop(`the export did not finish within ${ARCHIVE_WORK_MAX_MS / 60_000} minutes`), ARCHIVE_WORK_MAX_MS);
        /** Until the client has read enough to make room. */
        const room = async (): Promise<void> => {
          while (!stopped && (controller.desiredSize ?? 0) <= 0) {
            const idle = setTimeout(() => stop(`the client read nothing for ${EXPORT_IDLE_MS / 1000} seconds`), EXPORT_IDLE_MS);
            await new Promise<void>((resolve) => (wake = resolve));
            clearTimeout(idle);
          }
        };
        const sink: ZipSink = async (chunk) => {
          for (let at = 0; at < chunk.byteLength; at += SLICE_BYTES) {
            if (stopped) throw stopped;
            const slice = chunk.subarray(at, at + SLICE_BYTES);
            controller.enqueue(slice);
            bytes += slice.byteLength;
            await room();
          }
        };
        // Not awaited: the stream starts answering reads while the archive is written.
        void write(sink).then(
          () => end(null),
          (err: unknown) => end(err instanceof Error ? err : new Error(String(err))),
        );
      },
      pull: resume,
      cancel() {
        stop("the client went away", true);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: BUFFERED_BYTES }),
  );
}

const pct = (c: string): string => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;

/** RFC 6266: the workspace's name in UTF-8, and a plain ASCII one for clients that read only that. */
export function attachment(name: string): string {
  const plain = name.normalize("NFKD").replace(/[^A-Za-z0-9._ -]/g, "").replace(/\s+/g, " ").trim() || "workspace";
  const full = `${name.replace(/[\\/]/g, "-")}${ARCHIVE_EXTENSION}`;
  // RFC 5987 leaves ' ( ) * out of the characters a value may carry unescaped.
  return `attachment; filename="${plain}${ARCHIVE_EXTENSION}"; filename*=UTF-8''${encodeURIComponent(full).replace(/['()*]/g, pct)}`;
}
