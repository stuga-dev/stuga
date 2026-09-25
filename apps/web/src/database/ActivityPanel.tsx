/**
 * The database's ops ledger, newest first: people's edits and agents' writes
 * alike, with Revert on ops that carry an inverse. Reverts skip rows that
 * changed since, so the confirmation promises "where possible".
 */
import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Databases } from "../api";
import type { DatabaseOpSummary } from "@stuga/protocol/databases/types";
import { authorLabel, nameLoading, useUserNames } from "../state/identity";
import { AI_COAUTHOR_LABEL, absoluteTime, principalHuman, relativeTime } from "../lib/format";
import { errorMessage } from "../lib/http/client";

interface ActivityPanelProps {
  docId: string;
  /** Bumped by the page after schema or data changes. */
  refreshKey: number;
  readOnly: boolean;
  /** A revert changed table data; the page refetches. */
  onReverted: () => void;
  /** A revert was refused with 403; the page turns read-only. */
  onWriteDenied: () => void;
}

/**
 * The ledger stores bare aliases, so `is_agent` (recorded on the op) decides how an actor is named.
 * Null while a person's name loads, so no raw alias shows.
 */
function actorLabel(op: DatabaseOpSummary): string | null {
  if (op.is_agent && principalHuman(op.actor) !== null) return AI_COAUTHOR_LABEL;
  if (op.is_agent) return op.actor.replace(/^agent:/, "");
  return nameLoading(`user:${op.actor}`) ? null : authorLabel(op.actor);
}

/** `ts` is epoch milliseconds. */
function opIso(ts: number): string {
  return new Date(ts).toISOString();
}

const PAGE = 50;

/** Newest first, without duplicates: a refresh and a late older page can overlap. */
function mergeOps(cur: DatabaseOpSummary[], more: DatabaseOpSummary[]): DatabaseOpSummary[] {
  const seen = new Set(cur.map((o) => o.op_id));
  return [...cur, ...more.filter((o) => !seen.has(o.op_id))].sort((a, b) => b.seq - a.seq);
}

export function ActivityPanel({ docId, refreshKey, readOnly, onReverted, onWriteDenied }: ActivityPanelProps) {
  const toast = useToast();
  const [ops, setOps] = useState<DatabaseOpSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [reverting, setReverting] = useState<DatabaseOpSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // A refresh re-reads only the first page and merges it, so older pages already shown stay.
  useEffect(() => {
    let live = true;
    setError(false);
    Databases.ops(docId, { limit: PAGE })
      .then((r) => {
        if (!live) return;
        setOps((cur) => mergeOps(cur ?? [], r.ops));
        setHasMore((more) => more || r.ops.length >= PAGE);
      })
      .catch(() => {
        if (!live) return;
        setOps((cur) => cur ?? []);
        setError(true);
      });
    return () => {
      live = false;
    };
  }, [docId, refreshKey, reloadKey]);

  async function loadOlder() {
    if (!ops || ops.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const oldest = ops[ops.length - 1]!.seq;
      const r = await Databases.ops(docId, { limit: PAGE, before_seq: oldest });
      setOps((cur) => mergeOps(cur ?? [], r.ops));
      setHasMore(r.ops.length >= PAGE);
    } catch {
      toast({ body: "Couldn't load older activity.", type: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  // Agent aliases are not directory principals, so only people are looked up.
  useUserNames(
    (ops ?? []).flatMap((o) => [
      ...(o.is_agent ? [] : [`user:${o.actor}`]),
      ...(o.on_behalf_of ? [`user:${o.on_behalf_of}`] : []),
    ]),
  );

  async function doRevert() {
    if (!reverting) return;
    setBusy(true);
    try {
      const r = await Databases.revertOp(docId, reverting.op_id);
      setReverting(null);
      toast({
        body:
          r.missing > 0
            ? `Reverted — ${r.restored} restored, ${r.missing} couldn't be (changed since).`
            : "Reverted.",
        type: "info",
      });
      setReloadKey((k) => k + 1);
      onReverted();
    } catch (e) {
      if ((e as { status?: number }).status === 403) onWriteDenied();
      toast({ body: errorMessage(e, "Couldn't revert that change."), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dock-panel">
      <div className="side-body">
        {ops === null ? (
          <div className="db-grid-center">
            <Spinner label="Loading activity…" />
          </div>
        ) : error && ops.length === 0 ? (
          <Text type="supporting" color="secondary">
            Couldn’t load the activity feed.
          </Text>
        ) : ops.length === 0 ? (
          <Text type="supporting" color="secondary">
            Changes to this database will appear here.
          </Text>
        ) : (
          <ul className="db-ops">
            {ops.map((op) => (
              <li key={op.op_id} className="db-op">
                <div className="db-op__head">
                  <span className="db-op__actor">
                    {op.is_agent && <Badge variant="purple" label="agent" />}
                    {/* A blank keeps the row's height until the name arrives. */}
                    <strong title={op.actor}>{actorLabel(op) ?? "\u00a0"}</strong>
                  </span>
                  <span className="db-op__time" title={absoluteTime(opIso(op.ts))}>
                    {relativeTime(opIso(op.ts))}
                  </span>
                </div>
                <p className="db-op__summary">{op.summary}</p>
                <div className="db-op__foot">
                  {/* A blank keeps Revert in place until the name arrives. */}
                  {op.on_behalf_of && (
                    <span className="db-op__for">
                      {nameLoading(`user:${op.on_behalf_of}`) ? "\u00a0" : `for ${authorLabel(op.on_behalf_of)}`}
                    </span>
                  )}
                  {op.reverted_by ? (
                    <Badge variant="neutral" label="Reverted" />
                  ) : (
                    op.revertible &&
                    !readOnly && (
                      <Button label="Revert" variant="ghost" size="sm" onClick={() => setReverting(op)} />
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {ops !== null && ops.length > 0 && hasMore && (
          <div className="db-ops-more">
            <Button label="Show older" variant="ghost" size="sm" isLoading={loadingMore} onClick={() => void loadOlder()} />
          </div>
        )}
      </div>
      <AlertDialog
        isOpen={reverting !== null}
        onOpenChange={(o) => !o && !busy && setReverting(null)}
        title="Revert this change?"
        description={`Undoes “${reverting?.summary ?? ""}” where possible. Rows edited since keep their newer values.`}
        actionLabel="Revert"
        isActionLoading={busy}
        onAction={doRevert}
      />
    </div>
  );
}
