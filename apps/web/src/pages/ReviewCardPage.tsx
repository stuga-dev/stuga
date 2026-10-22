/**
 * /review/:docId/:runId: one AI change, as the person who decides it reads it, on a phone first.
 * Which page and section, who asked through which AI and when, the review level and who may decide,
 * each change as its paragraph before and after with the sources it cites, then Approve, Ask for
 * changes… (a rejection with a note the agent revises from) and Decline… in a footer that stays on
 * screen. Whoever may not approve sees why beside the button. The same card serves a database's runs,
 * each change said in a line. A notification, a review channel's post and the inbox open it; it
 * links to the item, where each change can be decided on its own.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Item } from "@astryxdesign/core/Item";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token, type TokenColor } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { ClipboardCheck } from "lucide-react";
import { blockDiffMarkdown } from "@stuga/crdt-ops";
import type { DatabaseRunOp, DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { RUN_FEEDBACK_NOTE_MAX_CHARS } from "@stuga/protocol/domain/limits";
import type { RunStanding } from "@stuga/protocol/domain/runs";
import { changeCardPath } from "@stuga/protocol/domain/changes";
import type { AgentRunSummary, RunHunkStatus } from "@stuga/protocol/wire/doc-socket";
import { DatabaseRuns, Docs, Folders, Runs, groupName, type DocSummary, type RunDeciders } from "../api";
import { describeProposal } from "../database/op-lines";
import { LEVEL_LABEL } from "../library/ReviewLevelDialog";
import { absoluteTime, orList, relativeTime } from "../lib/format";
import { errorMessage, getAlias } from "../lib/http/client";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import { clientName } from "../agents/client-configs";
import { NoAccessCard } from "../document/NoAccessCard";
import { renderCardMarkdown } from "../review/card-markdown";
import { approveBlock, cardChanges, type ApproveBlock, type CardChange, type CardSource } from "../review/review-card";
import { AppTopNav } from "../shell/AppTopNav";
import { principalLabel, runAgentLabel, useUserNames } from "../state/identity";
import { LoadFailed } from "../ui/LoadFailed";
import { useToast } from "../ui/use-toast";
import { t, type MessageKey } from "../i18n/i18n";
import "../styles/review.css";
import "../styles/editor.css";
import "../styles/ask.css";

/** A phone's width, and no wider on a laptop, so the card reads the same on both. */
const CARD_WIDTH = 560;

type Loaded =
  | { kind: "prose"; doc: DocSummary; path: string[]; run: AgentRunSummary; changes: CardChange[]; deciders: RunDeciders | null }
  | { kind: "database"; doc: DocSummary; path: string[]; run: DatabaseRunSummary; deciders: RunDeciders | null };

type Load = { state: "loading" } | { state: "ready"; card: Loaded } | { state: "no-access" } | { state: "failed"; message: string };

/** The folders above an item, readable ones by title. */
async function folderPath(parentId: string | null): Promise<string[]> {
  if (!parentId) return [];
  const { ancestors } = await Folders.ancestors(parentId).catch(() => ({ ancestors: [] }));
  return ancestors.flatMap((f) => (f.title ? [f.title] : []));
}

/** The item could not be opened: one refusal for 403 and 404, as the item's own page gives, so its existence never shows. */
class NoAccess extends Error {}

async function loadCard(docId: string, runId: string): Promise<Loaded> {
  const doc = await Docs.get(docId).catch((e: unknown) => {
    const status = (e as { status?: number }).status;
    throw status === 403 || status === 404 ? new NoAccess() : e;
  });
  const path = await folderPath(doc.parent_id);
  if (doc.doc_type === "database") {
    const d = await DatabaseRuns.detail(docId, runId, { full: true });
    return { kind: "database", doc, path, run: d.run, deciders: d.deciders ?? null };
  }
  const d = await Runs.detail(docId, runId, { full: true });
  const hunks = d.hunks ?? d.run.hunks;
  return { kind: "prose", doc, path, run: d.run, changes: cardChanges(d.baseline_markdown ?? null, hunks, d.citations ?? []), deciders: d.deciders ?? null };
}

export const STATUS_LABEL: Record<RunHunkStatus, MessageKey> = {
  pending: "review.card.status.pending",
  accepted: "review.card.status.accepted",
  rejected: "review.card.status.rejected",
  conflict: "review.card.status.conflict",
  auto_applied: "review.card.status.applied",
};

export const STATUS_COLOR: Record<RunHunkStatus, TokenColor> = {
  pending: "default",
  accepted: "green",
  rejected: "gray",
  conflict: "orange",
  auto_applied: "green",
};

export const LEVEL_COLOR: Record<ReviewMode, TokenColor> = { auto: "green", review: "default", colleague: "blue" };

/** Who decides below `colleague` besides whoever asked, as the lines name them. */
type Others = "owner" | "admin" | "both";

const YOU_AND: Record<Others, MessageKey> = {
  owner: "review.card.deciders.youAndOwner",
  admin: "review.card.deciders.youAndAdmin",
  both: "review.card.deciders.youAndOwnerOrAdmin",
};

const ASKER_AND: Record<Others, MessageKey> = {
  owner: "review.card.deciders.askerOrOwner",
  admin: "review.card.deciders.askerOrAdmin",
  both: "review.card.deciders.askerOwnerOrAdmin",
};

/**
 * Who may decide it, in a line, for whoever reads its waiting text; null when it is not known. The
 * reader is named apart from the others, so no language has to fit "you" into a list. Below
 * `colleague` the owner and admins are named by role, the reader among them when they are one.
 */
export function decidersLine(level: ReviewMode, deciders: RunDeciders | null, me: string | null, noun: "document" | "database"): string | null {
  if (!deciders) return null;
  if (level !== "colleague") {
    const asker = deciders.aliases[0];
    if (!asker) return null;
    const { owner, admin } = deciders.also;
    const others: Others | null = owner && admin ? "both" : owner ? "owner" : admin ? "admin" : null;
    if (asker === me) return others ? t(YOU_AND[others], { noun }) : t("review.card.deciders.onlyYou");
    const name = principalLabel(`user:${asker}`);
    return others ? t(ASKER_AND[others], { name, noun }) : t("review.card.deciders.colleague", { names: name });
  }
  if (deciders.aliases.length === 0) {
    return deciders.cause === "group" ? t("review.card.deciders.nobodyGroup") : t("review.card.deciders.nobody");
  }
  const others = deciders.aliases.filter((a) => a !== me).map((a) => principalLabel(`user:${a}`));
  const mine = others.length < deciders.aliases.length;
  if (mine && others.length === 0) return t("review.card.deciders.onlyYou");
  const names = orList(others);
  if (mine) return t("review.card.deciders.youAnd", { names });
  return deciders.stand_in ? t("review.card.deciders.standIn", { names }) : t("review.card.deciders.colleague", { names });
}

/** Why Approve is off, in words, beside it. */
export function blockLine(block: ApproveBlock, reviewer: string, noun: "document" | "database"): string {
  switch (block.kind) {
    case "locked":
      return t("review.card.reason.locked");
    case "own":
      return block.waitsFor === "nobody"
        ? t("review.card.reason.ownNobody")
        : block.waitsFor === "group"
          ? t("review.card.reason.ownGroup")
          : t("review.card.reason.own");
    case "colleague":
      return block.group
        ? t("review.card.reason.group", { name: principalLabel(`user:${reviewer}`), group: groupName(block.group) })
        : t("review.card.reason.colleague", { name: principalLabel(`user:${reviewer}`) });
    case "reviewer":
      return t("review.card.reason.reviewer", { name: principalLabel(`user:${reviewer}`), noun });
    case "queued":
      return t("review.card.reason.queued");
  }
}

/** The counts of a run's items by status. */
export function countsOf(items: ReadonlyArray<{ status: string }>): Record<RunHunkStatus, number> {
  const out: Record<RunHunkStatus, number> = { pending: 0, accepted: 0, rejected: 0, conflict: 0, auto_applied: 0 };
  for (const i of items) if (i.status in out) out[i.status as RunHunkStatus] += 1;
  return out;
}

/** What became of the run's items that are decided, as the inbox says it. */
export function outcomeLine(c: Record<RunHunkStatus, number>): string {
  const parts: string[] = [];
  if (c.accepted > 0) parts.push(t("review.inbox.outcome.kept", { count: c.accepted }));
  if (c.rejected > 0) parts.push(t("review.inbox.outcome.skipped", { count: c.rejected }));
  if (c.auto_applied > 0) parts.push(t("review.inbox.outcome.applied", { count: c.auto_applied }));
  if (c.conflict > 0) parts.push(t("review.inbox.outcome.conflicts", { count: c.conflict }));
  return parts.join(" · ");
}

export default function ReviewCardPage() {
  const { docId = "", runId = "" } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState<null | "ask" | "decline">(null);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "ack">(null);
  const me = getAlias();

  // A link from outside the app names the item's workspace: open it there.
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
    loadCard(docId, runId).then(
      (card) => live && setLoad({ state: "ready", card }),
      (e: unknown) => {
        if (!live) return;
        // An item someone cannot open is the item's own refusal; a run that is gone is a failure to say.
        setLoad(e instanceof NoAccess ? { state: "no-access" } : { state: "failed", message: errorMessage(e, t("review.card.loadFailed")) });
      },
    );
    return () => {
      live = false;
    };
  }, [docId, runId, attempt, wanted]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const card = load.state === "ready" ? load.card : null;
  const run = card?.run ?? null;
  useUserNames(useMemo(() => (run ? [`user:${run.reviewer}`, ...(card?.deciders?.aliases ?? []).map((a) => `user:${a}`)] : []), [run, card?.deciders]));

  // The top bar's arrow goes back to the inbox the card belongs to.
  const shell = (content: React.ReactNode, footer?: React.ReactNode, title?: string) => (
    <AppShell
      topNav={<AppTopNav title={t("common.reviewAiEdits")} pageTitle={title} back={{ to: "/review", label: t("common.reviewAiEdits") }} />}
      contentPadding={0}
    >
      <Layout height="fill" contentWidth={CARD_WIDTH} content={<LayoutContent>{content}</LayoutContent>} footer={footer} />
    </AppShell>
  );

  if (load.state === "no-access") return <NoAccessCard docId={docId} onAccess={reload} />;
  if (load.state === "failed") {
    return shell(
      <VStack gap={4}>
        <LoadFailed icon={<ClipboardCheck size={24} />} title={t("review.card.loadFailed")} description={load.message} onRetry={reload} />
      </VStack>,
    );
  }
  if (!card || !run) {
    return shell(
      <VStack gap={4}>
        <VStack gap={2} hAlign="center" padding={6}>
          <Spinner label={t("review.card.loading")} />
        </VStack>
      </VStack>,
    );
  }

  const { doc } = card;
  const title = doc.title.trim() || t("common.untitled");
  const items: ReadonlyArray<{ status: string }> = card.kind === "prose" ? card.run.hunks : card.run.ops;
  const counts = countsOf(items);
  const withheld = card.kind === "prose" ? card.run.hunks_withheld === true : card.run.ops_withheld === true;
  // A reader without the waiting text is told how many wait.
  const pending = counts.pending + ((card.kind === "prose" ? card.run.hunks_pending : card.run.ops_pending) ?? 0);
  const you: RunStanding | undefined = run.you;
  const level: ReviewMode = you?.level ?? run.review_mode;
  const waiting = run.status === "open" && pending > 0;
  const agent = runAgentLabel(run);
  const asked = principalLabel(`user:${run.reviewer}`);
  const block = waiting ? approveBlock({ you, me, reviewer: run.reviewer, level, approverGroup: run.approver_group ?? null, locked: doc.locked, pending }) : null;
  const canAck = !waiting && run.auto_applied && !run.acknowledged && !run.reverted && you?.ack === true;
  const deciding = waiting && you !== undefined && (you.accept || you.reject);
  const count = pending || items.length;
  const mine = run.reviewer === me;
  const via = "client" in run && run.client ? clientName(run.client) : null;
  const noun = card.kind === "database" ? "database" : "document";

  async function decide(decision: "accept" | "reject", note?: string): Promise<boolean> {
    setBusy(decision === "accept" ? "approve" : "reject");
    try {
      const r =
        card!.kind === "prose"
          ? await Runs.decide(docId, runId, decision, undefined, note)
          : await DatabaseRuns.decide(docId, runId, decision, undefined, note);
      if (decision === "accept" && r.conflicts > 0) {
        toast({ body: t(card!.kind === "prose" ? "review.notice.docConflict" : "review.notice.dbConflict", { count: r.conflicts }), type: "error" });
      } else {
        toast({
          body: decision === "accept" ? t("review.card.toast.approved", { count: r.applied }) : note ? t("review.card.toast.asked") : t("review.card.toast.declined"),
          type: "info",
        });
      }
      reload();
      return true;
    } catch (e) {
      toast({ body: errorMessage(e, t("review.inbox.actionFailed")), type: "error" });
      // Someone else may have decided first: the card shows how it stands now.
      reload();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function ack() {
    setBusy("ack");
    try {
      if (card!.kind === "prose") await Runs.ack(docId, runId);
      else await DatabaseRuns.ack(docId, runId);
      toast({ body: t("review.inbox.done.dismiss", { title }), type: "info" });
      reload();
    } catch (e) {
      toast({ body: errorMessage(e, t("review.inbox.actionFailed")), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  const status = (() => {
    if (run.reverted) return <Banner status="info" title={t("review.inbox.status.reverted")} />;
    if (withheld && waiting) return <Banner status="info" title={t("review.card.withheld.title")} description={t("review.card.withheld.body")} />;
    if (!waiting && run.auto_applied) return <Banner status="success" title={t("review.card.applied")} description={outcomeLine(counts) || undefined} />;
    if (!waiting) return <Banner status={counts.accepted > 0 ? "success" : "info"} title={t("review.card.decided")} description={outcomeLine(counts) || undefined} />;
    return null;
  })();

  const footer =
    waiting || canAck ? (
      <LayoutFooter hasDivider label={t("review.card.footerLabel")}>
        <VStack gap={2}>
          {block && (
            <Text type="supporting" color="secondary">
              {blockLine(block, run.reviewer, noun)}
            </Text>
          )}
          {deciding && you?.reject && (
            <HStack gap={2} wrap="wrap" className="review-card-actions">
              <Button label={t("review.card.decline")} isDisabled={busy !== null} onClick={() => setAsking("decline")} />
              <Button label={t("review.card.askChanges")} isDisabled={busy !== null} onClick={() => setAsking("ask")} />
            </HStack>
          )}
          {waiting && (
            <Button
              label={t("review.card.approve")}
              variant="primary"
              size="lg"
              width="100%"
              isLoading={busy === "approve"}
              isDisabled={block !== null || busy !== null}
              onClick={() => void decide("accept")}
            />
          )}
          {canAck && <Button label={t("review.inbox.markReviewed")} variant="primary" width="100%" isLoading={busy === "ack"} onClick={() => void ack()} />}
        </VStack>
      </LayoutFooter>
    ) : undefined;

  // Whoever asked is told whom to give access beside Approve already.
  const decided = block?.kind === "own" && card.deciders?.aliases.length === 0 ? null : decidersLine(level, card.deciders, me, noun);

  return shell(
    <VStack gap={5}>
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {[...card.path, title].join(" › ")}
        </Text>
        <Heading level={1}>
          {mine
            ? count > 0
              ? t("review.card.headlineYours", { agent, count })
              : t("review.card.headlineYoursNoCount", { agent })
            : count > 0
              ? t("review.card.headline", { name: asked, agent, count })
              : t("review.card.headlineNoCount", { name: asked, agent })}
        </Heading>
        <Text type="supporting" color="secondary">
          <time dateTime={new Date(run.created_at).toISOString()} title={absoluteTime(new Date(run.created_at).toISOString())}>
            {via
              ? t("review.card.viaWhen", { app: via, when: relativeTime(new Date(run.created_at).toISOString()) })
              : relativeTime(new Date(run.created_at).toISOString())}
          </time>
        </Text>
      </VStack>
      <VStack gap={1}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Token size="sm" color={LEVEL_COLOR[level]} label={t(LEVEL_LABEL[level])} />
        </HStack>
        {decided && waiting && (
          <Text type="supporting" color="secondary">
            {decided}
          </Text>
        )}
      </VStack>
      {status}
      {card.kind === "prose" ? (
        <VStack gap={3}>
          {card.changes.map((change, i) => (
            <HunkCard key={change.hunk.id} change={change} index={i} total={card.changes.length} onOpenSource={(id) => nav(`/doc/${id}`)} />
          ))}
        </VStack>
      ) : (
        card.run.ops.length > 0 && <OpsCard ops={card.run.ops} />
      )}
      <HStack gap={2} wrap="wrap">
        <Button
          label={card.kind === "database" ? t("review.card.openDatabase") : t("review.card.openDocument")}
          variant="secondary"
          onClick={() => nav(`/doc/${docId}`)}
        />
        {run.change_id && <Button label={t("review.card.openChange")} variant="ghost" onClick={() => nav(changeCardPath(run.change_id!))} />}
      </HStack>
      <NoteDialog
        asking={waiting ? asking : null}
        onClose={() => setAsking(null)}
        onSend={async (note) => {
          if (await decide("reject", note)) setAsking(null);
        }}
      />
    </VStack>,
    footer,
    t("review.card.pageTitle", { title }),
  );
}

/** One change: where it is, its paragraph before (struck) and after, and what it cites. */
export function HunkCard({ change, index, total, onOpenSource }: { change: CardChange; index: number; total: number; onOpenSource: (docId: string) => void }) {
  // A change to an empty page has nothing before it: no struck-out block to show.
  const blocks = useMemo(() => blockDiffMarkdown(change.before, change.after).filter((b) => b.markdown.trim() !== ""), [change.before, change.after]);
  const feedback = change.hunk.feedback?.note;
  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
          <Text type="label" color="secondary">
            {change.section ? t("review.card.section", { section: change.section }) : t("review.card.change", { index: index + 1, total })}
          </Text>
          {change.hunk.status !== "pending" && <Token size="sm" color={STATUS_COLOR[change.hunk.status]} label={t(STATUS_LABEL[change.hunk.status])} />}
        </HStack>
        <VStack gap={1}>
          {blocks.map((b, i) =>
            b.type === "del" ? (
              <VStack key={i} gap={0}>
                <VisuallyHidden>{t("review.diff.removed")}</VisuallyHidden>
                <del className="review-card-block review-card-block--del ai-md" dangerouslySetInnerHTML={{ __html: renderCardMarkdown(b.markdown) }} />
              </VStack>
            ) : b.type === "ins" ? (
              <VStack key={i} gap={0}>
                <VisuallyHidden>{t("review.diff.added")}</VisuallyHidden>
                <ins className="review-card-block review-card-block--ins ai-md" dangerouslySetInnerHTML={{ __html: renderCardMarkdown(b.markdown) }} />
              </VStack>
            ) : (
              <article key={i} className="review-card-block review-card-block--eq ai-md" dangerouslySetInnerHTML={{ __html: renderCardMarkdown(b.markdown) }} />
            ),
          )}
        </VStack>
        {feedback && (
          <Text type="supporting" color="secondary">
            {t("review.card.note", { note: feedback })}
          </Text>
        )}
        {change.sources.length > 0 && <Sources sources={change.sources} onOpen={onOpenSource} />}
      </VStack>
    </Card>
  );
}

function Sources({ sources, onOpen }: { sources: CardSource[]; onOpen: (docId: string) => void }) {
  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        {t("review.card.sources")}
      </Text>
      <List density="compact">
        {sources.map((s) => (
          <Item
            as="li"
            key={s.n}
            align="start"
            density="compact"
            startContent={
              <Text type="label" color="secondary">
                {s.n}
              </Text>
            }
            label={s.title}
            labelLines={2}
            {...(s.excerpt ? { description: s.excerpt, descriptionLines: 3 } : {})}
            {...(s.docId ? { onClick: () => onOpen(s.docId!) } : {})}
          />
        ))}
      </List>
    </VStack>
  );
}

/** A database run's changes, each said in a line. */
export function OpsCard({ ops }: { ops: DatabaseRunOp[] }) {
  return (
    <Card>
      <List hasDividers density="compact">
        {ops.map((op) => (
          <Item
            as="li"
            key={op.id}
            label={op.detail ? describeProposal(op.detail) : op.summary}
            labelLines={3}
            {...(op.feedback?.note ? { description: t("review.card.note", { note: op.feedback.note }) } : {})}
            endContent={op.status !== "pending" ? <Token size="sm" color={STATUS_COLOR[op.status]} label={t(STATUS_LABEL[op.status])} /> : undefined}
          />
        ))}
      </List>
    </Card>
  );
}

/** A note to go with Ask for changes (required: it is what the AI revises from) or Decline (optional). */
export function NoteDialog({ asking, onClose, onSend }: { asking: null | "ask" | "decline"; onClose: () => void; onSend: (note: string | undefined) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog stays mounted: it starts empty each time it opens.
  const [seen, setSeen] = useState(asking);
  if (seen !== asking) {
    setSeen(asking);
    if (asking) {
      setNote("");
      setError(null);
    }
  }
  const ask = asking === "ask";
  const close = () => !busy && onClose();

  async function send() {
    if (!asking) return;
    const text = note.trim();
    if (ask && !text) return setError(t("review.card.note.required"));
    if (text.length > RUN_FEEDBACK_NOTE_MAX_CHARS) return setError(t("review.note.tooLong", { count: RUN_FEEDBACK_NOTE_MAX_CHARS }));
    setBusy(true);
    try {
      await onSend(text || undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog isOpen={asking !== null} onOpenChange={(open) => !open && close()} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title={ask ? t("review.card.note.askTitle") : t("review.card.note.declineTitle")}
            subtitle={ask ? t("review.card.note.askSubtitle") : t("review.card.note.declineSubtitle")}
            onOpenChange={(open) => !open && close()}
          />
        }
        content={
          <LayoutContent>
            <TextArea
              label={ask ? t("review.note.label") : t("review.card.note.why")}
              value={note}
              onChange={(v) => {
                setNote(v);
                setError(null);
              }}
              rows={4}
              hasAutoFocus
              {...(ask ? { isRequired: true } : { isOptional: true })}
              {...(error ? { status: { type: "error" as const, message: error } } : {})}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" isDisabled={busy} onClick={close} />
              <Button
                label={ask ? t("review.card.note.askSend") : t("review.card.note.declineSend")}
                variant={ask ? "primary" : "destructive"}
                isLoading={busy}
                onClick={() => void send()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
