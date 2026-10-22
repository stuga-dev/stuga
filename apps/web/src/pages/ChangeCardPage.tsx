/**
 * /review/change/:changeId: one piece of an agent's work across several pages, as the person who
 * decides it reads it, on a phone first. The agent's summary first, then each page the reader can
 * open: its folders, whether the change made it, its level and who may decide it there (pages may
 * sit at different levels), and each change in its paragraph as the run card shows it. Approve all
 * approves, page by page, what the reader may approve; it is not one step, and the answer says what
 * was approved and what is left. Ask for changes and Decline send the note to every page's agent run.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Item } from "@astryxdesign/core/Item";
import { List } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { ClipboardCheck } from "lucide-react";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { reviewCardPath } from "@stuga/protocol/domain/runs";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import { Changes, DatabaseRuns, Runs, type ChangeCard, type ChangePage, type ChangePageOutcome, type LeftReason } from "../api";
import { LEVEL_LABEL } from "../library/ReviewLevelDialog";
import { absoluteTime, relativeTime } from "../lib/format";
import { errorMessage, getAlias } from "../lib/http/client";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import { clientName } from "../agents/client-configs";
import { cardChanges, type CardChange } from "../review/review-card";
import { AppTopNav } from "../shell/AppTopNav";
import { principalLabel, runAgentLabel, useUserNames } from "../state/identity";
import { LoadFailed } from "../ui/LoadFailed";
import { useToast } from "../ui/use-toast";
import { t, type MessageKey } from "../i18n/i18n";
import { HunkCard, LEVEL_COLOR, NoteDialog, OpsCard, decidersLine } from "./ReviewCardPage";
import "../styles/review.css";
import "../styles/editor.css";
import "../styles/ask.css";

/** A phone's width, and no wider on a laptop, as the run card. */
const CARD_WIDTH = 560;

type AnyRun = AgentRunSummary | DatabaseRunSummary;

/** One run's changes as the card reads them: in their paragraphs for a document, a line each for a database. */
type RunChanges = { kind: "prose"; changes: CardChange[] } | { kind: "database"; run: DatabaseRunSummary } | { kind: "withheld"; pending: number };

interface Loaded {
  card: ChangeCard;
  changes: Map<string, RunChanges>;
}

type Load = { state: "loading" } | { state: "ready"; loaded: Loaded } | { state: "missing" } | { state: "failed"; message: string };

/** The card's data: the change, then each run's changes in full for whoever reads them. */
async function loadChange(changeId: string): Promise<Loaded> {
  const card = await Changes.get(changeId);
  const changes = new Map<string, RunChanges>();
  await Promise.all(
    card.pages.flatMap((page) =>
      page.runs.map(async (run) => {
        if ("ops" in run) {
          if (run.ops_withheld) return changes.set(run.id, { kind: "withheld", pending: run.ops_pending ?? 0 });
          const d = await DatabaseRuns.detail(page.doc_id, run.id, { full: true }).catch(() => ({ run }));
          return changes.set(run.id, { kind: "database", run: d.run });
        }
        if (run.hunks_withheld) return changes.set(run.id, { kind: "withheld", pending: run.hunks_pending ?? 0 });
        const d = await Runs.detail(page.doc_id, run.id, { full: true }).catch(() => null);
        const hunks = d?.hunks ?? d?.run.hunks ?? run.hunks;
        return changes.set(run.id, { kind: "prose", changes: cardChanges(d?.baseline_markdown ?? null, hunks, d?.citations ?? []) });
      }),
    ),
  );
  return { card, changes };
}

/** How many of a run's changes wait, the withheld ones included. */
function pendingOf(run: AnyRun): number {
  const items: ReadonlyArray<{ status: string }> = "hunks" in run ? run.hunks : run.ops;
  const shown = items.filter((i) => i.status === "pending").length;
  return shown + (("hunks" in run ? run.hunks_pending : run.ops_pending) ?? 0);
}

/** A run that still waits for a decision. */
const waits = (run: AnyRun) => run.status === "open" && pendingOf(run) > 0;

/** What the reader may do with a page's waiting changes: approve any now, decline any. */
function standingOf(page: ChangePage): { accept: boolean; reject: boolean; waiting: number } {
  const open = page.runs.filter(waits);
  const held = page.state === "held" && open.length === 0 ? page.page_you : undefined;
  return {
    accept: (open.some((r) => r.you?.accept) || held?.accept === true) && !page.locked,
    reject: open.some((r) => r.you?.reject) || held?.reject === true,
    waiting: open.reduce((n, r) => n + pendingOf(r), 0) + (held ? 1 : 0),
  };
}

/** Why what is left on a page is left, in words. */
const LEFT_REASON: Record<LeftReason, MessageKey> = {
  own: "review.change.why.own",
  colleague: "review.change.why.colleague",
  group: "review.change.why.group",
  reviewer: "review.change.why.reviewer",
  nobody: "review.change.why.nobody",
  queued: "review.change.why.queued",
  locked: "review.change.why.locked",
  view_only: "review.change.why.viewOnly",
  refused: "review.change.why.refused",
  gone: "review.change.why.refused",
};

/** Why the reader may not approve a page's waiting changes, from where they stand on its runs; null when they may. */
export function pageBlock(page: ChangePage, me: string | null, askedBy: string): LeftReason | null {
  const open = page.runs.filter(waits);
  if (open.length === 0) {
    // A new page holding no change of its own yet is approved as a page.
    const you = page.state === "held" ? page.page_you : undefined;
    if (!you) return null;
    if (you.accept) return page.locked ? "locked" : null;
    if (me !== askedBy) return "colleague";
    return you.waits_for === "nobody" ? "nobody" : you.waits_for === "group" ? "group" : "own";
  }
  if (open.some((r) => r.you?.accept)) return page.locked ? "locked" : null;
  if (open.some((r) => r.you?.queued)) return "queued";
  const first = open[0]!;
  if (first.you?.level === "colleague") {
    if (first.reviewer === me) return first.you.waits_for === "nobody" ? "nobody" : first.you.waits_for === "group" ? "group" : "own";
    return first.approver_group ? "group" : "colleague";
  }
  return "reviewer";
}

/** What Approve all, Ask for changes or Decline did to one page, in a line. */
export function outcomeOf(o: ChangePageOutcome): string {
  const title = o.title.trim() || t("common.untitled");
  const parts: string[] = [];
  if (o.state === "released") parts.push(t("review.change.outcome.released"));
  else if (o.state === "removed") parts.push(t("review.change.outcome.removed"));
  if (o.approved > 0) parts.push(t("review.change.outcome.approved", { count: o.approved }));
  if (o.declined > 0) parts.push(t("review.change.outcome.declined", { count: o.declined }));
  if (o.conflicts > 0) parts.push(t("review.change.outcome.conflicts", { count: o.conflicts }));
  if (o.left > 0) parts.push(t("review.change.outcome.left", { count: o.left }));
  const why = o.left > 0 ? [...new Set(o.reasons.map((r) => t(LEFT_REASON[r])))].join(" ") : "";
  const line = parts.length > 0 ? t("review.change.outcome.line", { title, outcome: parts.join(" · ") }) : t("review.change.outcome.nothing", { title });
  return why ? `${line} ${why}` : line;
}

export default function ChangeCardPage() {
  const { changeId = "" } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState<null | "ask" | "decline">(null);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [result, setResult] = useState<{ decision: "accept" | "reject"; pages: ChangePageOutcome[] } | null>(null);
  const me = getAlias();

  // A link from outside the app names the change's workspace: open it there.
  const wanted = params.get("workspace");
  useEffect(() => {
    if (!wanted) return;
    if (wanted !== getActiveWorkspace()) {
      setActiveWorkspace(wanted);
      window.location.replace(location.pathname);
      return;
    }
    nav(location.pathname, { replace: true });
  }, [wanted, location.pathname, nav]);

  useEffect(() => {
    if (wanted && wanted !== getActiveWorkspace()) return;
    let live = true;
    loadChange(changeId).then(
      (loaded) => live && setLoad({ state: "ready", loaded }),
      (e: unknown) => {
        if (!live) return;
        const status = (e as { status?: number }).status;
        setLoad(status === 404 || status === 403 ? { state: "missing" } : { state: "failed", message: errorMessage(e, t("review.change.loadFailed")) });
      },
    );
    return () => {
      live = false;
    };
  }, [changeId, attempt, wanted]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const card = load.state === "ready" ? load.loaded.card : null;
  useUserNames(
    useMemo(
      () => (card ? [`user:${card.change.asked_by}`, ...card.pages.flatMap((p) => (p.deciders?.aliases ?? []).map((a) => `user:${a}`))] : []),
      [card],
    ),
  );

  const shell = (content: React.ReactNode, footer?: React.ReactNode, title?: string) => (
    <AppShell
      topNav={<AppTopNav title={t("common.reviewAiEdits")} pageTitle={title} back={{ to: "/review", label: t("common.reviewAiEdits") }} />}
      contentPadding={0}
    >
      <Layout height="fill" contentWidth={CARD_WIDTH} content={<LayoutContent>{content}</LayoutContent>} footer={footer} />
    </AppShell>
  );

  if (load.state === "missing") {
    return shell(
      <VStack gap={4}>
        <EmptyState icon={<ClipboardCheck size={28} />} title={t("review.change.missing")} description={t("review.change.missingNote")} />
      </VStack>,
    );
  }
  if (load.state === "failed") {
    return shell(
      <VStack gap={4}>
        <LoadFailed icon={<ClipboardCheck size={24} />} title={t("review.change.loadFailed")} description={load.message} onRetry={reload} />
      </VStack>,
    );
  }
  if (!card || load.state !== "ready") {
    return shell(
      <VStack gap={2} hAlign="center" padding={6}>
        <Spinner label={t("review.change.loading")} />
      </VStack>,
    );
  }

  const { change, pages } = card;
  const agent = runAgentLabel({ agent: change.agent, agent_alias: change.agent_alias, agent_name: change.agent_name });
  const mine = change.asked_by === me;
  const asked = principalLabel(`user:${change.asked_by}`);
  const via = change.client ? clientName(change.client) : null;
  const title = change.title?.trim() || (mine ? t("review.change.untitledYours", { agent }) : t("review.change.untitled", { name: asked, agent }));
  const standing = pages.map(standingOf);
  const waiting = standing.reduce((n, s) => n + s.waiting, 0);
  const canApprove = standing.some((s) => s.accept);
  const canReject = standing.some((s) => s.reject);
  const reasons = [...new Set(pages.filter((_, i) => standing[i]!.waiting > 0).flatMap((p) => pageBlock(p, me, change.asked_by) ?? []))];

  async function decide(decision: "accept" | "reject", note?: string): Promise<boolean> {
    setBusy(decision === "accept" ? "approve" : "reject");
    try {
      const r = await Changes.decide(changeId, decision, note);
      setResult({ decision, pages: r.pages });
      const approved = r.pages.reduce((n, p) => n + p.approved, 0);
      const left = r.pages.reduce((n, p) => n + p.left, 0);
      toast({
        body:
          decision === "accept"
            ? left > 0
              ? t("review.change.toast.approvedSome", { count: approved, left })
              : t("review.change.toast.approved", { count: approved })
            : note
              ? t("review.card.toast.asked")
              : t("review.card.toast.declined"),
        type: "info",
      });
      reload();
      return true;
    } catch (e) {
      toast({ body: errorMessage(e, t("review.inbox.actionFailed")), type: "error" });
      reload();
      return false;
    } finally {
      setBusy(null);
    }
  }

  const footer =
    waiting > 0 && (canApprove || canReject || reasons.length > 0) ? (
      <LayoutFooter hasDivider label={t("review.change.footerLabel")}>
        <VStack gap={2}>
          <Text type="supporting" color="secondary">
            {canApprove ? t("review.change.notAtomic") : reasons.map((r) => t(LEFT_REASON[r])).join(" ")}
          </Text>
          {canReject && (
            <HStack gap={2} wrap="wrap" className="review-card-actions">
              <Button label={t("review.card.decline")} isDisabled={busy !== null} onClick={() => setAsking("decline")} />
              <Button label={t("review.card.askChanges")} isDisabled={busy !== null} onClick={() => setAsking("ask")} />
            </HStack>
          )}
          <Button
            label={t("review.change.approveAll")}
            variant="primary"
            size="lg"
            width="100%"
            isLoading={busy === "approve"}
            isDisabled={!canApprove || busy !== null}
            onClick={() => void decide("accept")}
          />
        </VStack>
      </LayoutFooter>
    ) : undefined;

  return shell(
    <VStack gap={5}>
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {t("review.change.eyebrow", { count: pages.length })}
        </Text>
        <Heading level={1}>{title}</Heading>
        <Text color="secondary">{mine ? t("review.change.byYours", { agent }) : t("review.change.by", { name: asked, agent })}</Text>
        <Text type="supporting" color="secondary">
          <time dateTime={change.created_at} title={absoluteTime(change.created_at)}>
            {via ? t("review.card.viaWhen", { app: via, when: relativeTime(change.created_at) }) : relativeTime(change.created_at)}
          </time>
        </Text>
      </VStack>
      {change.summary && <Text>{change.summary}</Text>}
      {result && (
        <Banner
          status={result.pages.some((p) => p.left > 0) ? "info" : "success"}
          title={result.decision === "accept" ? t("review.change.result.approved") : t("review.change.result.declined")}
          description={
            <List density="compact">
              {result.pages.map((o) => (
                <Item as="li" key={o.doc_id} density="compact" label={outcomeOf(o)} labelLines={3} />
              ))}
            </List>
          }
        />
      )}
      {waiting === 0 && !result && <Banner status="info" title={t("review.change.allDecided")} />}
      <VStack gap={6}>
        {pages.map((page) => (
          <PageSection key={page.doc_id} page={page} me={me} askedBy={change.asked_by} changes={load.loaded.changes} onOpen={(path) => nav(path)} />
        ))}
      </VStack>
      <NoteDialog
        asking={waiting > 0 ? asking : null}
        onClose={() => setAsking(null)}
        onSend={async (note) => {
          if (await decide("reject", note)) setAsking(null);
        }}
      />
    </VStack>,
    footer,
    t("review.change.pageTitle", { title }),
  );
}

/** One page of the change: where it is, whether the change made it, who decides it, and its changes. */
function PageSection({
  page,
  me,
  askedBy,
  changes,
  onOpen,
}: {
  page: ChangePage;
  me: string | null;
  askedBy: string;
  changes: Map<string, RunChanges>;
  onOpen: (path: string) => void;
}) {
  const title = page.title.trim() || t("common.untitled");
  const noun = page.doc_kind === "database" ? "database" : "document";
  const open = page.runs.filter(waits);
  const level: ReviewMode = page.level;
  const block = pageBlock(page, me, askedBy);
  const decided = decidersLine(level, page.deciders ?? null, me, noun);
  const firstWaiting = open[0];
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        {page.path.length > 0 && (
          <Text type="label" color="secondary">
            {page.path.join(" › ")}
          </Text>
        )}
        <Heading level={2}>{title}</Heading>
        <HStack gap={2} vAlign="center" wrap="wrap">
          {page.new && <Token size="sm" color="purple" label={t("review.change.newPage")} />}
          <Token size="sm" color={LEVEL_COLOR[level]} label={t(LEVEL_LABEL[level])} />
          {open.length === 0 && page.state !== "held" && page.state !== "removed" && <Token size="sm" color="green" label={t("review.card.decided")} />}
        </HStack>
      </VStack>
      {page.state === "held" && (
        <Text type="supporting" color="secondary">
          {t("review.change.heldNote")}
        </Text>
      )}
      {page.state === "removed" && (
        <Banner status="info" title={t("review.change.removed")} description={page.note ? t("review.card.note", { note: page.note }) : undefined} />
      )}
      {page.queued_behind && (
        <Text type="supporting" color="secondary">
          {page.queued_behind.change_title ? t("review.change.queuedBehind", { title: page.queued_behind.change_title }) : t("review.change.queuedBehindUntitled")}
        </Text>
      )}
      {decided && open.length > 0 && (
        <Text type="supporting" color="secondary">
          {decided}
        </Text>
      )}
      {/* Whoever asked reads above who approves it; anyone else why they do not. */}
      {block && open.length > 0 && block !== "queued" && !(block === "own" && decided) && (
        <Text type="supporting" color="secondary">
          {t(LEFT_REASON[block])}
        </Text>
      )}
      {page.runs.map((run) => {
        const got = changes.get(run.id);
        if (!got) return null;
        if (got.kind === "withheld") {
          return got.pending > 0 ? (
            <Text key={run.id} color="secondary">
              {t("review.change.withheld", { count: got.pending })}
            </Text>
          ) : null;
        }
        if (got.kind === "database") return got.run.ops.length > 0 ? <OpsCard key={run.id} ops={got.run.ops} /> : null;
        return (
          <VStack key={run.id} gap={3}>
            {got.changes.map((change, i) => (
              <HunkCard key={change.hunk.id} change={change} index={i} total={got.changes.length} onOpenSource={(id) => onOpen(`/doc/${id}`)} />
            ))}
          </VStack>
        );
      })}
      {/* One way on from here: the page's own card, where it is decided alone and opened, or the page. */}
      {page.state !== "removed" && (
        <HStack>
          {firstWaiting && (firstWaiting.you?.accept || firstWaiting.you?.reject) ? (
            <Button label={t("review.change.decideAlone")} variant="secondary" size="sm" onClick={() => onOpen(reviewCardPath(page.doc_id, firstWaiting.id))} />
          ) : (
            <Button
              label={page.doc_kind === "database" ? t("review.card.openDatabase") : t("review.card.openDocument")}
              variant="secondary"
              size="sm"
              onClick={() => onOpen(`/doc/${page.doc_id}`)}
            />
          )}
        </HStack>
      )}
    </VStack>
  );
}
