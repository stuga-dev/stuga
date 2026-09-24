/** Reading the audit ledger: the workspace's page and facets, its export, and the node's own rows. */
import { type AuditFacet, auditEventsCursor, auditFacets, listAuditEvents, listNodeAuditEvents } from "@stuga/db";
import { AUDIT_EXPORT_COLUMNS, CSV_BOM, auditExportFilename, csvCell } from "@stuga/protocol/domain/audit";
import {
  auditCursorAt,
  auditReadRefusal,
  nextAuditCursor,
  parseAuditCursor,
  parseAuditFilters,
  parseAuditLimit,
} from "./read.js";
import { AUDIT_DEDUP_MS, noteAuditWindow, recordAudit } from "./record.js";
import { error, json, download } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/** Rows a page carries when the caller names no limit; a full page is what offers a cursor. */
const AUDIT_PAGE_DEFAULT = 100;

/**
 * One cell as JSON spells it, before the CSV encoder: `toJSON` is the step
 * `JSON.stringify` takes, so a timestamp reads as the same ISO instant in the
 * CSV, the NDJSON and the client's export, not as a host-locale Date string.
 */
function wireCell(v: unknown): unknown {
  const toJson = (v as { toJSON?: unknown } | null | undefined)?.toJSON;
  return typeof toJson === "function" ? (toJson as () => unknown).call(v) : v;
}

export async function listAudit({ ctx, url }: WorkspaceCall): Promise<Response> {
  const refusal = await auditReadRefusal(ctx);
  if (refusal) return refusal;
  const p = url.searchParams;
  const parsed = parseAuditFilters(p);
  if (!parsed.ok) return error(400, parsed.message);
  const cursor = parseAuditCursor(p);
  if (!cursor.ok) return error(400, cursor.message);
  const limit = parseAuditLimit(p, AUDIT_PAGE_DEFAULT);
  const filters = parsed.value;
  // Reading the ledger is recorded, one row per reader per window. The key holds
  // nothing the caller varies: the page sends `since = now - range`, so filters
  // differ on every fetch and would buy a row each time.
  const readKey = JSON.stringify(["audit.read", ctx.workspaceId, ctx.alias]);
  if (noteAuditWindow(readKey)) {
    recordAudit(ctx, {
      action: "audit.read",
      targetKind: "workspace",
      targetId: ctx.workspaceId,
      detail: {
        dedup_window_ms: AUDIT_DEDUP_MS,
        // Only the request that opened the window; later reads in it may differ.
        opened_with: {
          actor: filters.actor,
          principal: filters.principal,
          action: filters.action,
          target_kind: filters.targetKind,
          target_id: filters.targetId,
          status: filters.status,
          since: filters.since,
          until: filters.until,
          limit,
          paged: Boolean(cursor.value),
        },
      },
    });
  }
  const events = await listAuditEvents(ctx.sql, {
    workspaceId: ctx.workspaceId,
    ...filters,
    before: cursor.value,
    limit,
  });
  return json({ events, next_before: nextAuditCursor(events, limit) });
}

// The filter menus' vocabulary for a time window. Only the window narrows it: a
// menu narrowed by the filter it feeds could not offer the value that widens it.
// Not recorded, since it belongs to the same page load as `audit.read`.
export async function listAuditFacets({ ctx, url }: WorkspaceCall): Promise<Response> {
  const refusal = await auditReadRefusal(ctx);
  if (refusal) return refusal;
  const parsed = parseAuditFilters(url.searchParams);
  if (!parsed.ok) return error(400, parsed.message);
  const facets = await auditFacets(ctx.sql, {
    workspaceId: ctx.workspaceId,
    since: parsed.value.since,
    until: parsed.value.until,
  });
  const wire = (axis: AuditFacet[]) =>
    axis.map((f) => ({ value: f.value, count: f.count, last_at: auditCursorAt(f.last_at) }));
  return json(
    {
      principals: wire(facets.principals),
      agents: wire(facets.agents),
      actions: wire(facets.actions),
      statuses: wire(facets.statuses),
      // An axis cut short holds its busiest values, not the whole vocabulary.
      truncated: facets.truncated,
    },
  );
}

export async function exportAudit({ ctx, url }: WorkspaceCall): Promise<Response> {
  const refusal = await auditReadRefusal(ctx, "export the audit ledger");
  if (refusal) return refusal;
  const p = url.searchParams;
  const format = p.get("format") === "csv" ? "csv" : "ndjson";
  const parsed = parseAuditFilters(p);
  if (!parsed.ok) return error(400, parsed.message);
  const filters = { workspaceId: ctx.workspaceId, ...parsed.value };
  // An export leaves the node with a copy, so the row records how wide it was.
  recordAudit(ctx, {
    action: "audit.export",
    targetKind: "workspace",
    targetId: ctx.workspaceId,
    detail: {
      format,
      scope: {
        actor: filters.actor ?? null,
        principal: filters.principal ?? null,
        action: filters.action ?? null,
        target_kind: filters.targetKind ?? null,
        target_id: filters.targetId ?? null,
        status: filters.status ?? null,
        since: filters.since ?? null,
        until: filters.until ?? null,
      },
    },
  });
  const encoder = new TextEncoder();
  const cursor = auditEventsCursor(ctx.sql, filters);
  // RFC 4180 CSV ends lines with CRLF.
  const terminator = format === "csv" ? "\r\n" : "\n";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // The BOM makes a spreadsheet read the file as UTF-8.
      if (format === "csv") controller.enqueue(encoder.encode(CSV_BOM + AUDIT_EXPORT_COLUMNS.join(",") + terminator));
    },
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      const lines = value.map((row) =>
        format === "csv"
          ? AUDIT_EXPORT_COLUMNS.map((c) => csvCell(wireCell((row as unknown as Record<string, unknown>)[c]))).join(",")
          : JSON.stringify(row),
      );
      controller.enqueue(encoder.encode(lines.join(terminator) + terminator));
    },
    cancel() {
      void iterator.return?.();
    },
  });
  const iterator = cursor[Symbol.asyncIterator]();
  const stamp = new Date().toISOString().slice(0, 10);
  return download(
    body,
    auditExportFilename(stamp, format),
    format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
  );
}

/** The node's own rows: settings changes, admin grants, and refusals with no workspace. */
export async function listNodeAudit({ ctx, url }: WorkspaceCall): Promise<Response> {
  const p = url.searchParams;
  const cursor = parseAuditCursor(p);
  if (!cursor.ok) return error(400, cursor.message);
  const limit = parseAuditLimit(p, 50);
  const events = await listNodeAuditEvents(ctx.sql, { limit, before: cursor.value });
  return json({ events, next_before: nextAuditCursor(events, limit) });
}
