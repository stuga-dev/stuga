/**
 * The workspace's review queue: runs still waiting on a person, across documents,
 * with a record per agent. Actions call the same routes the document page does.
 * Rows come from an inbox mirror the actors refresh through the job queue, so an
 * action patches its row from the reply and re-reads shortly after.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { AppShell, useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, proportional, pixel } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "@astryxdesign/core/Toast";
import { ListChecks } from "lucide-react";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { AppTopNav } from "../shell/AppTopNav";
import { LoadFailed } from "../ui/LoadFailed";
import { PageColumn } from "../ui/PageColumn";
import { absoluteTime, fmtInt, relativeTime } from "../lib/format";
import { DatabaseRuns, INBOX_PAGE_LIMIT, Inbox, Runs, type AgentStats, type InboxFilter, type InboxRun } from "../api";
import { errorMessage } from "../lib/http/client";
import { useRejectNote } from "../review/RejectNoteDialog";
import { runAgentLabel } from "../state/identity";
import { t, type MessageKey } from "../i18n/i18n";

const FILTERS: Array<{ value: InboxFilter; label: MessageKey }> = [
  { value: "attention", label: "review.inbox.filter.attention" },
  { value: "open", label: "review.inbox.filter.open" },
  { value: "closed", label: "review.inbox.filter.closed" },
  { value: "all", label: "review.inbox.filter.all" },
];

type RunAction = "accept" | "reject" | "revert" | "dismiss";

/** The toast after a whole-run action. */
const DONE: Record<RunAction, MessageKey> = {
  accept: "review.inbox.done.accept",
  reject: "review.inbox.done.reject",
  revert: "review.inbox.done.revert",
  dismiss: "review.inbox.done.dismiss",
};

/** How long to wait for the mirror after an action before re-reading. */
const MIRROR_SETTLE_MS = 1500;

/** Fold a run summary the node just returned into the inbox row shape. */
function rowFromSummary(row: InboxRun, run: AgentRunSummary | DatabaseRunSummary): InboxRun {
  const items = "hunks" in run ? run.hunks : run.ops;
  const count = (s: string) => items.filter((h) => h.status === s).length;
  return {
    ...row,
    status: run.status,
    auto_applied: run.auto_applied,
    reverted: run.reverted === true,
    acknowledged: run.acknowledged,
    pending: count("pending"),
    accepted: count("accepted"),
    rejected: count("rejected"),
    conflicts: count("conflict"),
    applied: count("auto_applied"),
    updated_at: new Date(run.updated_at).toISOString(),
  };
}

/**
 * Where a run stands. A revert is the only thing that marks a run `expired`, and
 * an `auto` session stays `open` after it is acknowledged, until the agent's next session.
 */
type RunState = "reverted" | "waiting" | "unchecked" | "settled";

function runState(run: InboxRun): RunState {
  if (run.reverted) return "reverted";
  if (run.status === "open" && run.pending > 0) return "waiting";
  if (run.auto_applied && !run.acknowledged) return "unchecked";
  return "settled";
}

/** The server's `attention` filter, so a row an action settles leaves the list as a re-read would drop it. */
export function needsAttention(run: InboxRun): boolean {
  const state = runState(run);
  return state === "waiting" || state === "unchecked";
}

/** The whole-run actions a row offers. */
export function runActions(run: InboxRun): { decide: boolean; revert: boolean; dismiss: boolean } {
  const state = runState(run);
  return {
    decide: state === "waiting",
    // Only landed changes unwind; a document refuses a run with none.
    revert: state !== "reverted" && run.accepted + run.applied > 0,
    dismiss: state === "unchecked",
  };
}

/** What became of a run's changes, from its counts. */
function outcomeOf(run: InboxRun): string {
  const parts: string[] = [];
  if (run.accepted > 0) parts.push(t("review.inbox.outcome.kept", { count: run.accepted }));
  if (run.rejected > 0) parts.push(t("review.inbox.outcome.skipped", { count: run.rejected }));
  if (run.applied > 0) parts.push(t("review.inbox.outcome.applied", { count: run.applied }));
  if (run.conflicts > 0) parts.push(t("review.inbox.outcome.conflicts", { count: run.conflicts }));
  return parts.join(" · ");
}

/**
 * The row's status line. Nothing on the wire says an agent is still at work, so
 * an open run with nothing waiting reads as what it has done so far.
 */
export function runStatus(run: InboxRun): string {
  switch (runState(run)) {
    case "reverted":
      return t("review.inbox.status.reverted");
    case "waiting":
      return t("review.inbox.status.waiting", { count: run.pending });
    case "unchecked":
      return t("review.inbox.status.unchecked", { outcome: outcomeOf(run) });
    case "settled":
      return outcomeOf(run) || t("review.inbox.status.nothingWaiting");
  }
}

/** Who made a run: its agent, plus the client label when the name does not already say it. */
export function madeBy(run: InboxRun): string {
  const name = runAgentLabel(run);
  // The co-author's name already says how it was made.
  const via = run.source === "panel" ? null : run.client;
  const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return via && !key(name).includes(key(via)) ? `${name} · ${via}` : name;
}

/** The top bar names the page, except below AppShell's breakpoint, where its title sits in the menu drawer. */
function PhoneTitle({ children }: { children: string }) {
  const { isMobile } = useAppShellMobile();
  return isMobile ? <Heading level={1}>{children}</Heading> : null;
}

export function ReviewPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { ask: askNote, dialog: noteDialog } = useRejectNote();
  const [filter, setFilter] = useState<InboxFilter>("attention");
  const [agent, setAgent] = useState("");
  const [runs, setRuns] = useState<InboxRun[] | null>(null);
  /** The last load filled a page, so the count is a floor until the next load. */
  const [capped, setCapped] = useState(false);
  const [stats, setStats] = useState<AgentStats[]>([]);
  const [failed, setFailed] = useState(false);
  /** Runs with an action in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  /** The run the revert dialog names, kept after it closes so its text holds while it animates out. */
  const [revertTarget, setRevertTarget] = useState<InboxRun | null>(null);
  const [revertOpen, setRevertOpen] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [inbox, agents] = await Promise.all([Inbox.list(filter, agent || undefined), Inbox.stats()]);
      setRuns(inbox.runs);
      setCapped(inbox.runs.length >= INBOX_PAGE_LIMIT);
      setStats(agents.agents);
    } catch {
      setFailed(true);
      setRuns(null);
    }
  }, [filter, agent]);

  useEffect(() => {
    void load();
  }, [load]);

  const agentOptions = useMemo(
    () => [{ value: "", label: t("review.inbox.allAgents") }, ...stats.map((s) => ({ value: s.agent_alias, label: runAgentLabel(s) }))],
    [stats],
  );

  const shown = runs?.length ?? 0;
  const listHeading = filter === "attention"
    ? capped ? t("review.inbox.headingAttentionCapped", { count: shown }) : t("review.inbox.headingAttention", { count: shown })
    : capped ? t("review.inbox.headingAllCapped", { count: shown }) : t("review.inbox.headingAll", { count: shown });

  function markBusy(runId: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    });
  }

  /** One whole-run action, patched into the row from the reply, then re-read. */
  async function act(
    row: InboxRun,
    what: RunAction,
    note?: string,
  ): Promise<boolean> {
    markBusy(row.run_id, true);
    try {
      let run: AgentRunSummary | DatabaseRunSummary | null = null;
      if (row.doc_kind === "prose") {
        if (what === "accept" || what === "reject") run = (await Runs.decide(row.doc_id, row.run_id, what, undefined, note)).run;
        else if (what === "revert") run = (await Runs.revert(row.doc_id, row.run_id, note)).run;
        else await Runs.ack(row.doc_id, row.run_id);
      } else {
        if (what === "accept" || what === "reject") run = (await DatabaseRuns.decide(row.doc_id, row.run_id, what, undefined, note)).run;
        else if (what === "revert") run = (await DatabaseRuns.revert(row.doc_id, row.run_id, note)).run;
        else run = (await DatabaseRuns.ack(row.doc_id, row.run_id)).run;
      }
      setRuns((prev) => {
        const updated = prev?.map((r) => {
          if (r.run_id !== row.run_id) return r;
          return run ? rowFromSummary(r, run) : { ...r, acknowledged: true };
        });
        return filter === "attention" ? updated?.filter(needsAttention) ?? null : updated ?? null;
      });
      toast({ body: t(DONE[what], { title: row.doc_title || t("common.untitled") }), type: "info" });
      window.setTimeout(() => void load(), MIRROR_SETTLE_MS);
      return true;
    } catch (e) {
      toast({ body: errorMessage(e, t("review.inbox.actionFailed")), type: "error" });
      return false;
    } finally {
      markBusy(row.run_id, false);
    }
  }

  function openRevert(row: InboxRun) {
    setRevertTarget(row);
    setRevertOpen(true);
  }

  const revertBusy = revertTarget !== null && busy.has(revertTarget.run_id);
  // Nothing closes the dialog while its revert is in flight.
  const closeRevert = () => !revertBusy && setRevertOpen(false);

  const statColumns = [
    { key: "agent", header: t("review.inbox.stats.agent"), width: proportional(2), renderCell: (s: AgentStats) => runAgentLabel(s) },
    { key: "runs", header: t("review.inbox.stats.runs"), width: pixel(70), renderCell: (s: AgentStats) => fmtInt(s.runs) },
    { key: "pending", header: t("review.inbox.stats.waiting"), width: pixel(80), renderCell: (s: AgentStats) => fmtInt(s.pending) },
    { key: "accepted", header: t("review.inbox.stats.kept"), width: pixel(80), renderCell: (s: AgentStats) => fmtInt(s.accepted) },
    { key: "rejected", header: t("review.inbox.stats.skipped"), width: pixel(80), renderCell: (s: AgentStats) => fmtInt(s.rejected) },
    { key: "applied", header: t("review.inbox.stats.applied"), width: pixel(150), renderCell: (s: AgentStats) => fmtInt(s.applied) },
    { key: "reverted", header: t("review.inbox.stats.reverted"), width: pixel(90), renderCell: (s: AgentStats) => fmtInt(s.reverted_runs) },
    {
      key: "last",
      header: t("review.inbox.stats.lastActive"),
      width: pixel(110),
      renderCell: (s: AgentStats) => <span title={absoluteTime(s.last_active_at)}>{relativeTime(s.last_active_at)}</span>,
    },
  ];

  return (
    <AppShell topNav={<AppTopNav title={t("common.reviewAiEdits")} hasWorkspaceSwitcher />} contentPadding={0}>
      <PageColumn width={960}>
        <VStack gap={6}>
          <VStack gap={3}>
            <HStack gap={4} vAlign="end" justify="between" wrap="wrap">
              <VStack gap={1}>
                <PhoneTitle>{t("common.reviewAiEdits")}</PhoneTitle>
                <Text color="secondary">{t("review.inbox.intro")}</Text>
              </VStack>
              <HStack gap={2} vAlign="end" wrap="wrap">
                <Selector
                  label={t("review.inbox.show")}
                  size="sm"
                  width={150}
                  presentation="adaptive"
                  value={filter}
                  onChange={(v) => setFilter(v as InboxFilter)}
                  options={FILTERS.map((f) => ({ value: f.value, label: t(f.label) }))}
                />
                <Selector label={t("review.inbox.agent")} size="sm" width={190} presentation="adaptive" value={agent} onChange={setAgent} options={agentOptions} />
              </HStack>
            </HStack>
            {failed ? (
              <LoadFailed icon={<ListChecks size={24} />} title={t("review.inbox.loadFailed")} onRetry={() => void load()} />
            ) : runs === null ? (
              <VStack gap={2} hAlign="center" padding={6}>
                <Spinner label={t("review.inbox.loading")} />
              </VStack>
            ) : runs.length === 0 ? (
              <EmptyState
                icon={<ListChecks size={28} />}
                title={filter === "attention" ? t("review.inbox.caughtUp") : t("review.inbox.noMatch")}
                description={filter === "attention" ? t("review.inbox.caughtUpNote") : t("review.inbox.noMatchNote")}
              />
            ) : (
              <List
                hasDividers
                density={filter === "attention" ? "spacious" : "balanced"}
                header={<Heading level={2}>{listHeading}</Heading>}
              >
                {runs.map((row) => {
                  const actions = runActions(row);
                  const isBusy = busy.has(row.run_id);
                  const attention = needsAttention(row);
                  const status = runStatus(row);
                  const title = row.doc_title || t("common.untitled");
                  const items = [
                    ...(actions.decide ? [
                      { label: t("review.inbox.acceptAll"), onClick: () => void act(row, "accept"), isDisabled: isBusy },
                      { label: t("review.inbox.rejectAll"), onClick: () => void act(row, "reject"), isDisabled: isBusy },
                      {
                        label: t("review.note.rejectAllEllipsis"),
                        onClick: () =>
                          askNote({
                            title: t("review.note.rejectAll"),
                            submitLabel: t("review.note.rejectAll"),
                            onSubmit: (note) => void act(row, "reject", note),
                          }),
                        isDisabled: isBusy,
                      },
                    ] : []),
                    ...(actions.revert ? [
                      { label: t("review.diff.revert"), variant: "destructive" as const, onClick: () => openRevert(row), isDisabled: isBusy },
                      {
                        label: t("review.inbox.revertWithNoteEllipsis"),
                        variant: "destructive" as const,
                        onClick: () =>
                          askNote({
                            title: t("review.inbox.revertWithNote"),
                            submitLabel: t("review.inbox.revertWithNote"),
                            quote: t("review.inbox.revertWithNoteQuote", { title }),
                            onSubmit: (note) => void act(row, "revert", note),
                          }),
                        isDisabled: isBusy,
                      },
                    ] : []),
                    ...(actions.dismiss ? [
                      { label: t("review.inbox.markReviewed"), onClick: () => void act(row, "dismiss"), isDisabled: isBusy },
                    ] : []),
                  ];
                  return (
                    <ListItem
                      key={row.run_id}
                      label={title}
                      startContent={<StatusDot variant={attention ? "warning" : "neutral"} label={attention ? t("review.inbox.needsReview") : t("review.inbox.noActionNeeded")} />}
                      description={
                        <VStack gap={1}>
                          <Text color="secondary">{status}</Text>
                          <Text type="supporting" color="secondary">
                            {row.doc_kind === "database" ? t("common.database") : t("common.document")} · {madeBy(row)} ·{" "}
                            <span title={absoluteTime(row.updated_at)}>{relativeTime(row.updated_at)}</span>
                          </Text>
                        </VStack>
                      }
                      endContent={
                        <HStack gap={1} vAlign="center">
                          <Button
                            label={attention ? t("review.inbox.reviewChanges") : t("common.open")}
                            variant="secondary"
                            size="sm"
                            onClick={() => nav(`/doc/${row.doc_id}`)}
                          />
                          {items.length > 0 && (
                            <MoreMenu
                              label={t("common.actionsFor", { name: title })}
                              variant="ghost"
                              size="sm"
                              alignment="end"
                              presentation="adaptive"
                              isDisabled={isBusy}
                              items={items}
                            />
                          )}
                        </HStack>
                      }
                    />
                  );
                })}
              </List>
            )}
          </VStack>

          {stats.length > 0 && (
            <Collapsible trigger={<Text weight="semibold">{t("review.inbox.stats.title")}</Text>} defaultIsOpen={false}>
              <VStack gap={2}>
                <Text color="secondary">{t("review.inbox.stats.intro")}</Text>
                <Table data={stats} columns={statColumns} dividers="rows" density="compact" />
              </VStack>
            </Collapsible>
          )}
        </VStack>
      </PageColumn>
      <AlertDialog
        isOpen={revertOpen}
        onOpenChange={(open) => !open && closeRevert()}
        title={t("review.inbox.revertDialog.title")}
        description={
          // A document reverts all or nothing; a database undoes what it still can, over later edits.
          revertTarget?.doc_kind === "prose"
            ? t("review.inbox.revertDialog.document", { title: revertTarget.doc_title || t("common.untitled") })
            : t("review.inbox.revertDialog.database", { title: revertTarget?.doc_title || t("common.untitled") })
        }
        actionLabel={t("review.inbox.revertDialog.action")}
        isActionLoading={revertBusy}
        onAction={() => {
          if (!revertTarget || revertBusy) return;
          void act(revertTarget, "revert").then((ok) => {
            if (ok) setRevertOpen(false);
          });
        }}
      />
      {noteDialog}
    </AppShell>
  );
}
