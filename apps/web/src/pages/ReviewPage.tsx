/**
 * The workspace's review queue, in three tabs: Needs you (what this person may decide, or should
 * look at), Waiting on others (changes someone else decides) and Done, with a record per agent. The
 * tab is in the address (?tab=), so a link can open Waiting on others or Done. A row opens the run's
 * review card; its menu acts on the whole run through the same routes the document page uses. Rows
 * come from an inbox mirror the actors refresh through the job queue, so an action patches its row
 * from the reply and re-reads shortly after.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading, Text } from "@astryxdesign/core/Text";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Table, proportional, pixel } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../ui/use-toast";
import { ChevronRight, ListChecks } from "lucide-react";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { reviewCardPath } from "@stuga/protocol/domain/runs";
import { changeCardPath } from "@stuga/protocol/domain/changes";
import { clientName } from "../agents/client-configs";
import { AppTopNav } from "../shell/AppTopNav";
import { LoadFailed } from "../ui/LoadFailed";
import { PageColumn } from "../ui/PageColumn";
import { useIsNarrow } from "../ui/narrow";
import { absoluteTime, fmtInt, relativeTime } from "../lib/format";
import { Changes, DatabaseRuns, INBOX_PAGE_LIMIT, Inbox, Runs, type AgentStats, type InboxChange, type InboxFilter, type InboxRun } from "../api";
import { errorMessage } from "../lib/http/client";
import { useRejectNote } from "../review/RejectNoteDialog";
import { summarizeHunk } from "../review/hunk-review";
import { describeProposal } from "../database/op-lines";
import { principalLabel, runAgentLabel, useUserNames } from "../state/identity";
import { t, type MessageKey } from "../i18n/i18n";
import "../styles/review.css";

/** The tabs, each the inbox filter that lists it, as the address names them. */
const TABS: Array<{ tab: string; filter: InboxFilter; label: MessageKey }> = [
  { tab: "needs", filter: "attention", label: "review.inbox.tab.needs" },
  { tab: "waiting", filter: "waiting", label: "review.inbox.tab.waiting" },
  { tab: "done", filter: "done", label: "review.inbox.tab.done" },
];

/** The tab the address names, Needs you when it names none. */
export function tabOf(raw: string | null): (typeof TABS)[number] {
  return TABS.find((x) => x.tab === raw) ?? TABS[0]!;
}

/** Each tab's empty state: a title and a line. */
const EMPTY: Record<InboxFilter, [MessageKey, MessageKey]> = {
  attention: ["review.inbox.caughtUp", "review.inbox.caughtUpNote"],
  waiting: ["review.inbox.waitingEmpty", "review.inbox.waitingEmptyNote"],
  done: ["review.inbox.doneEmpty", "review.inbox.doneEmptyNote"],
  all: ["review.inbox.noMatch", "review.inbox.noMatchNote"],
};

/** Accepting takes seeing the change where it lands, so the list offers no blind Accept all. */
type RunAction = "reject" | "revert" | "dismiss";

/** The toast after a whole-run action. */
const DONE: Record<RunAction, MessageKey> = {
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

/** The whole-run actions a row offers: none on a run someone else decides. */
export function runActions(run: InboxRun): { decide: boolean; revert: boolean; dismiss: boolean } {
  const state = runState(run);
  // Marking a run reviewed changes nothing, so it needs no write access; where a colleague approves
  // what a run proposed, someone other than the person who asked the AI does it (`you.ack`).
  const dismiss = state === "unchecked" && (run.you ? run.you.ack : run.can_decide !== false);
  if (run.can_decide === false) return { decide: false, revert: false, dismiss };
  return {
    decide: state === "waiting",
    // Only landed changes unwind; a document refuses a run with none.
    revert: state !== "reverted" && run.accepted + run.applied > 0,
    dismiss,
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
      if (run.you?.waits_for === "nobody") return t("review.inbox.status.waitingNobody", { count: run.pending });
      if (run.you?.waits_for === "group") return t("review.inbox.status.waitingGroup", { count: run.pending });
      if (run.you?.level === "colleague" && !run.you.accept) return t("review.inbox.status.waitingColleague", { count: run.pending });
      return run.can_decide === false
        ? t("review.inbox.status.waitingFor", { count: run.pending, name: principalLabel(`user:${run.reviewer}`) })
        : t("review.inbox.status.waiting", { count: run.pending });
    case "unchecked":
      return t("review.inbox.status.unchecked", { outcome: outcomeOf(run) });
    case "settled":
      return outcomeOf(run) || t("review.inbox.status.nothingWaiting");
  }
}

/** A change's status line: what of it waits and for whom, or what became of it. */
export function changeStatus(c: InboxChange): string {
  if (c.status !== "open" || c.pending === 0) {
    const parts: string[] = [];
    if (c.accepted > 0) parts.push(t("review.inbox.outcome.kept", { count: c.accepted }));
    if (c.rejected > 0) parts.push(t("review.inbox.outcome.skipped", { count: c.rejected }));
    if (c.applied > 0) parts.push(t("review.inbox.outcome.applied", { count: c.applied }));
    if (c.conflicts > 0) parts.push(t("review.inbox.outcome.conflicts", { count: c.conflicts }));
    return parts.join(" · ") || t("review.inbox.status.nothingWaiting");
  }
  if (c.you.accept) return t("review.inbox.status.waiting", { count: c.pending_yours ?? c.pending });
  if (c.you.queued) return t("review.inbox.status.queued", { count: c.pending });
  if (c.you.waits_for === "nobody") return t("review.inbox.status.waitingNobody", { count: c.pending });
  if (c.you.waits_for === "group") return t("review.inbox.status.waitingGroup", { count: c.pending });
  if (c.level === "colleague") return t("review.inbox.status.waitingColleague", { count: c.pending });
  return t("review.inbox.status.waitingFor", { count: c.pending, name: principalLabel(`user:${c.reviewer}`) });
}

/** One row of the inbox: a run in no change, or a whole change. */
type InboxItem = { kind: "run"; row: InboxRun } | { kind: "change"; row: InboxChange };

/** Runs and changes in one list, the latest activity first. */
export function inboxItems(runs: readonly InboxRun[], changes: readonly InboxChange[]): InboxItem[] {
  const items: InboxItem[] = [...runs.map((row) => ({ kind: "run" as const, row })), ...changes.map((row) => ({ kind: "change" as const, row }))];
  const at = (i: InboxItem) => new Date(i.row.updated_at).getTime();
  return items.sort((a, b) => at(b) - at(a));
}

/** Who made a run: its agent, then the app it came through when the name does not already say it. */
export function madeBy(run: Pick<InboxRun, "source" | "agent" | "agent_alias" | "agent_name" | "client">): string[] {
  const name = runAgentLabel(run);
  // The co-author's name already says how it was made.
  const via = run.source === "panel" || !run.client ? null : clientName(run.client);
  const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return via && !key(name).includes(key(via)) ? [name, via] : [name];
}

/**
 * A row's facts in one line on a wide screen. On a narrow one it breaks only between facts, each kept
 * whole unless it is wider than the line, and a separator ends its line rather than start the next.
 */
function RowFacts({ facts }: { facts: ReactNode[] }) {
  return (
    <Text type="supporting" color="secondary">
      {facts.map((fact, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <Text type="inherit" color="inherit" className="review-row-fact">
            {fact}
            {i < facts.length - 1 && "\u00A0·"}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}

/**
 * What a waiting run would change, in a line: its first change, and how many more. Read once per run
 * version; nothing shows while it loads or when the read fails.
 */
function WaitingPreview({ row }: { row: InboxRun }) {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const read: Promise<string[]> =
      row.doc_kind === "prose"
        ? Runs.detail(row.doc_id, row.run_id).then((d) =>
            d.run.hunks.filter((h) => h.status === "pending").map((h) => summarizeHunk(h).text),
          )
        : DatabaseRuns.detail(row.doc_id, row.run_id, { sample: 0 }).then((d) =>
            d.run.ops.filter((o) => o.status === "pending").map((o) => (o.detail ? describeProposal(o.detail) : o.summary)),
          );
    read.then(
      (changes) => {
        if (!live || changes.length === 0) return;
        const first = changes[0]!;
        setLine(changes.length > 1 ? t("review.inbox.previewMore", { change: first, count: changes.length - 1 }) : first);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [row.doc_id, row.run_id, row.doc_kind, row.updated_at]);
  return line ? (
    <Text color="secondary" maxLines={1}>
      {line}
    </Text>
  ) : null;
}

export function ReviewPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { ask: askNote, dialog: noteDialog } = useRejectNote();
  const [params, setParams] = useSearchParams();
  const { tab, filter } = tabOf(params.get("tab"));
  const narrow = useIsNarrow();
  const [agent, setAgent] = useState("");
  const [runs, setRuns] = useState<InboxRun[] | null>(null);
  const [changes, setChanges] = useState<InboxChange[]>([]);
  /** How many runs need this person, for the badge on Needs you whichever tab is open. */
  const [needsCount, setNeedsCount] = useState<number | null>(null);
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
      // The badge counts every agent's, whichever tab or agent is shown.
      const whole = filter === "attention" && !agent;
      const [inbox, agents, needs] = await Promise.all([
        Inbox.list(filter, agent || undefined),
        Inbox.stats(),
        whole ? null : Inbox.list("attention").catch(() => null),
      ]);
      setRuns(inbox.runs);
      setChanges(inbox.changes ?? []);
      setCapped(inbox.runs.length + (inbox.changes?.length ?? 0) >= INBOX_PAGE_LIMIT);
      setStats(agents.agents);
      const counted = whole ? inbox : needs;
      if (counted) setNeedsCount(counted.runs.length + (counted.changes?.length ?? 0));
    } catch {
      setFailed(true);
      setRuns(null);
    }
  }, [filter, agent]);

  useEffect(() => {
    void load();
  }, [load]);

  // Rows someone else decides name that person.
  useUserNames([...(runs ?? []), ...changes].filter((r) => r.can_decide === false).map((r) => `user:${r.reviewer}`));

  const agentOptions = useMemo(
    () => [{ value: "", label: t("review.inbox.allAgents") }, ...stats.map((s) => ({ value: s.agent_alias, label: runAgentLabel(s) }))],
    [stats],
  );

  const shown = (runs?.length ?? 0) + changes.length;
  const listHeading =
    filter === "attention"
      ? capped ? t("review.inbox.headingAttentionCapped", { count: shown }) : t("review.inbox.headingAttention", { count: shown })
      : filter === "waiting"
        ? capped ? t("review.inbox.headingWaitingCapped", { count: shown }) : t("review.inbox.headingWaiting", { count: shown })
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
        if (what === "reject") run = (await Runs.decide(row.doc_id, row.run_id, what, undefined, note)).run;
        else if (what === "revert") run = (await Runs.revert(row.doc_id, row.run_id, note)).run;
        else await Runs.ack(row.doc_id, row.run_id);
      } else {
        if (what === "reject") run = (await DatabaseRuns.decide(row.doc_id, row.run_id, what, undefined, note)).run;
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
      if (filter === "attention") setNeedsCount((n) => (n === null ? n : Math.max(0, n - 1)));
      toast({ body: t(what === "reject" && note ? "review.inbox.done.asked" : DONE[what], { title: row.doc_title || t("common.untitled") }), type: "info" });
      window.setTimeout(() => void load(), MIRROR_SETTLE_MS);
      return true;
    } catch (e) {
      toast({ body: errorMessage(e, t("review.inbox.actionFailed")), type: "error" });
      return false;
    } finally {
      markBusy(row.run_id, false);
    }
  }

  /** Ask for changes or Decline on a whole change: every run of it the person may decline, each with the note. */
  async function actOnChange(row: InboxChange, note?: string): Promise<boolean> {
    markBusy(row.change_id, true);
    try {
      await Changes.decide(row.change_id, "reject", note);
      setChanges((prev) => prev.filter((c) => c.change_id !== row.change_id || filter !== "attention"));
      toast({ body: t("review.inbox.done.change", { title: row.title || t("common.untitled") }), type: "info" });
      window.setTimeout(() => void load(), MIRROR_SETTLE_MS);
      return true;
    } catch (e) {
      toast({ body: errorMessage(e, t("review.inbox.actionFailed")), type: "error" });
      return false;
    } finally {
      markBusy(row.change_id, false);
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
                <Text color="secondary">{t("review.inbox.intro")}</Text>
              </VStack>
              <Selector label={t("review.inbox.agent")} size="sm" width={190} presentation="adaptive" value={agent} onChange={setAgent} options={agentOptions} />
            </HStack>
            <TabList value={tab} onChange={(next) => setParams(next === "needs" ? {} : { tab: next }, { replace: true })} hasDivider>
              {TABS.map((x) => (
                <Tab
                  key={x.tab}
                  value={x.tab}
                  label={t(x.label)}
                  {...(x.filter === "attention" && needsCount
                    ? { endContent: <Badge label={needsCount >= INBOX_PAGE_LIMIT ? t("review.inbox.countCapped", { count: needsCount }) : fmtInt(needsCount)} variant="info" /> }
                    : {})}
                />
              ))}
            </TabList>
            {failed ? (
              <LoadFailed icon={<ListChecks size={24} />} title={t("review.inbox.loadFailed")} onRetry={() => void load()} />
            ) : runs === null ? (
              <VStack gap={2} hAlign="center" padding={6}>
                <Spinner label={t("review.inbox.loading")} />
              </VStack>
            ) : runs.length + changes.length === 0 ? (
              <EmptyState
                icon={<ListChecks size={28} />}
                title={agent ? t("review.inbox.noMatch") : t(EMPTY[filter][0])}
                description={agent ? t("review.inbox.noMatchNote") : t(EMPTY[filter][1])}
              />
            ) : (
              <List
                hasDividers
                density={filter === "attention" ? "spacious" : "balanced"}
                header={<Heading level={2}>{listHeading}</Heading>}
              >
                {inboxItems(runs, changes).map((item) => {
                  if (item.kind === "change") {
                    const c = item.row;
                    const isBusy = busy.has(c.change_id);
                    const waiting = c.status === "open" && c.pending > 0;
                    const attention = waiting && c.you.accept;
                    const title = c.title || t("review.change.untitled", { name: principalLabel(`user:${c.reviewer}`), agent: runAgentLabel(c) });
                    const menu = waiting && c.you.reject
                      ? [
                          {
                            label: t("review.card.askChanges"),
                            onClick: () =>
                              askNote({
                                title: t("review.card.note.askTitle"),
                                submitLabel: t("review.card.note.askSend"),
                                onSubmit: (note) => void actOnChange(c, note),
                              }),
                            isDisabled: isBusy,
                          },
                          { label: t("review.inbox.decline"), onClick: () => void actOnChange(c), isDisabled: isBusy },
                        ]
                      : [];
                    const open = () => nav(changeCardPath(c.change_id));
                    return (
                      <ListItem
                        key={c.change_id}
                        label={title}
                        startContent={<StatusDot variant={attention ? "warning" : "neutral"} label={attention ? t("review.inbox.needsReview") : t("review.inbox.noActionNeeded")} />}
                        description={
                          <VStack gap={1}>
                            <Text color="secondary">{changeStatus(c)}</Text>
                            <Text color="secondary" maxLines={1}>
                              {c.page_titles.map((p) => p || t("common.untitled")).join(" · ")}
                            </Text>
                            <RowFacts
                              facts={[
                                t("review.inbox.change.pages", { count: c.pages }),
                                ...madeBy(c),
                                <time key="when" dateTime={c.updated_at} title={absoluteTime(c.updated_at)}>
                                  {relativeTime(c.updated_at)}
                                </time>,
                              ]}
                            />
                          </VStack>
                        }
                        endContent={
                          <HStack gap={1} vAlign="center">
                            {narrow ? (
                              <IconButton
                                label={attention ? t("review.inbox.reviewChanges") : t("common.open")}
                                variant="secondary"
                                size="sm"
                                icon={<ChevronRight size={16} />}
                                onClick={open}
                              />
                            ) : (
                              <Button label={attention ? t("review.inbox.reviewChanges") : t("common.open")} variant="secondary" size="sm" onClick={open} />
                            )}
                            {menu.length > 0 && (
                              <MoreMenu
                                label={t("common.actionsFor", { name: title })}
                                variant="ghost"
                                size="sm"
                                alignment="end"
                                presentation="adaptive"
                                isDisabled={isBusy}
                                items={menu}
                              />
                            )}
                          </HStack>
                        }
                      />
                    );
                  }
                  const row = item.row;
                  const actions = runActions(row);
                  const isBusy = busy.has(row.run_id);
                  // Another person's decision is theirs to make, and a colleague's approval theirs: shown, not flagged.
                  const attention =
                    (runState(row) === "waiting" && row.can_decide !== false && !row.you?.waits_for) || actions.dismiss;
                  const status = runStatus(row);
                  const title = row.doc_title || t("common.untitled");
                  const card = reviewCardPath(row.doc_id, row.run_id);
                  const items = [
                    { label: row.doc_kind === "database" ? t("review.card.openDatabase") : t("review.card.openDocument"), onClick: () => nav(`/doc/${row.doc_id}`) },
                    ...(actions.decide ? [
                      {
                        label: t("review.card.askChanges"),
                        onClick: () =>
                          askNote({
                            title: t("review.card.note.askTitle"),
                            submitLabel: t("review.card.note.askSend"),
                            onSubmit: (note) => void act(row, "reject", note),
                          }),
                        isDisabled: isBusy,
                      },
                      { label: t("review.inbox.decline"), onClick: () => void act(row, "reject"), isDisabled: isBusy },
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
                          {row.pending > 0 && row.status === "open" && <WaitingPreview row={row} />}
                          <RowFacts
                            facts={[
                              row.doc_kind === "database" ? t("common.database") : t("common.document"),
                              ...madeBy(row),
                              <time key="when" dateTime={row.updated_at} title={absoluteTime(row.updated_at)}>
                                {relativeTime(row.updated_at)}
                              </time>,
                            ]}
                          />
                        </VStack>
                      }
                      endContent={
                        <HStack gap={1} vAlign="center">
                          {/* On a phone the row's words keep the width, and the card opens from an arrow. */}
                          {narrow ? (
                            <IconButton
                              label={attention ? t("review.inbox.reviewChanges") : t("common.open")}
                              variant="secondary"
                              size="sm"
                              icon={<ChevronRight size={16} />}
                              onClick={() => nav(card)}
                            />
                          ) : (
                            <Button
                              label={attention ? t("review.inbox.reviewChanges") : t("common.open")}
                              variant="secondary"
                              size="sm"
                              onClick={() => nav(card)}
                            />
                          )}
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
