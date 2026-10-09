/**
 * The words for what the AI panels' turns report as data: what a turn is doing, why it ended
 * early, why it failed. The node sends codes and values; each panel words them here.
 */
import type {
  AskActivity,
  AskNotice,
  CoauthorActivity,
  CoauthorError,
  CoauthorNotice,
  CrossDocError,
  ModelFailureKind,
  TableAiActivity,
  TableAiNotice,
} from "@stuga/protocol/api/ai-turn";
import { t, uiLanguage, type MessageKey } from "../i18n/i18n";
import { presentServerMessage } from "../lib/http/server-messages";

/** Languages whose sentences follow one another with no space between them. */
const UNSPACED = new Set(["zh-Hans", "zh-Hant", "ja"]);

/** Whole sentences, one after another, as the interface language runs them on. */
export function sentences(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p).join(UNSPACED.has(uiLanguage()) ? "" : " ");
}

const FAILURE: Partial<Record<ModelFailureKind, MessageKey>> = {
  quota: "ai.failure.quota",
  auth: "ai.failure.auth",
  rate_limit: "ai.failure.rateLimit",
  unavailable: "ai.failure.unavailable",
};

/** What failed, when there is more to say than that it failed. */
export function failureText(kind: ModelFailureKind | null | undefined): string | null {
  const key = kind ? FAILURE[kind] : undefined;
  return key ? t(key) : null;
}

export function askActivityText(a: AskActivity): string {
  switch (a.kind) {
    case "searching":
      return t("ai.activity.searchingQuoted", { query: a.query });
    case "reading":
      return a.title ? t("ai.activity.readingTitled", { title: a.title }) : t("ai.activity.readingUntitled");
    case "listing":
      return t("ai.activity.listing");
    case "querying":
      return t("ai.activity.queryingDatabase");
    default:
      return t("ai.status.thinking");
  }
}

export function askNoticeText(n: AskNotice): string {
  switch (n.code) {
    case "max_rounds":
      return t("ai.notice.askMaxRounds");
    case "budget":
      return t("ai.notice.askBudget");
    case "aborted":
      return t("ai.notice.stopped");
    case "error":
      return failureText(n.failure) ?? t("ai.notice.askFailed");
    case "degraded":
      return t("ai.notice.askDegraded");
  }
}

export function tableActivityText(a: TableAiActivity): string {
  switch (a.kind) {
    case "reading":
      return t("ai.activity.readingSchema");
    case "querying":
      return t("ai.activity.queryingTable");
    case "searching":
      return t("ai.activity.searchingFor", { query: a.query });
    case "proposing":
      return t("ai.activity.proposing");
    default:
      return t("ai.status.thinking");
  }
}

export function tableNoticeText(n: TableAiNotice): string {
  if (n.code === "max_rounds") return t("ai.notice.maxRounds", { count: n.rounds });
  return sentences([
    n.kept === "staged" ? t("ai.notice.endedEarlyStaged") : t("ai.notice.endedEarlyApplied"),
    failureText(n.failure),
  ]);
}

export function coauthorActivityText(a: CoauthorActivity): string {
  switch (a.kind) {
    case "reading":
      return t("ai.activity.readingDocument");
    case "searching":
      return a.query ? t("ai.activity.searchingFor", { query: a.query }) : t("ai.activity.searchingKnowledgeBase");
    case "editing":
      return t("ai.activity.editing");
    case "proposing":
      return t("ai.activity.proposing");
    case "applying":
      return t("ai.activity.applying");
    default:
      return t("ai.status.thinking");
  }
}

function coauthorNoticeText(n: CoauthorNotice): string | null {
  switch (n.code) {
    case "max_rounds":
      return t("ai.notice.maxRounds", { count: n.rounds });
    case "ended_early":
      return sentences([t("ai.notice.endedEarly"), failureText(n.failure)]);
    case "stopped":
      return n.kept === "staged" ? t("ai.notice.stoppedStaged") : n.kept === "applied" ? t("ai.notice.stoppedApplied") : t("ai.notice.stopped");
    case "image_not_downloaded":
      // The reason is the node's own sentence, worded by the catalog when it has it, and set in brackets.
      return t("ai.notice.imageLeftLinked", { url: n.url, reason: presentServerMessage(n.reason).replace(/[.。．]\s*$/u, "") });
    case "images_truncated":
      return t("ai.notice.imagesTruncated", { count: n.count });
    default:
      return null;
  }
}

/** A co-author turn's notices, in order, as one passage; null when there are none. */
export function coauthorNoticesText(notices: readonly CoauthorNotice[] | undefined): string | null {
  return sentences((notices ?? []).map(coauthorNoticeText)) || null;
}

const COAUTHOR_ERROR: Record<Exclude<CoauthorError["code"], "failed" | "propose_failed" | "review_backlog">, MessageKey> = {
  locked: "ai.error.locked",
  view_only: "ai.error.viewOnly",
  rate_limited: "ai.error.rateLimited",
  unreadable: "ai.error.unreadable",
  empty_prompt: "ai.error.emptyPrompt",
  agent: "ai.error.agent",
  ai_disabled: "errors.server.aiChatDisabledNode",
  propose_locked: "ai.error.proposeLocked",
  too_large: "ai.error.tooLarge",
  ledger_unavailable: "ai.error.ledgerUnavailable",
  stale: "ai.error.stale",
  dropped: "ui.sync.turnDropped",
};

export function coauthorErrorText(e: CoauthorError): string {
  switch (e.code) {
    case "failed":
      return failureText(e.failure) ?? (e.detail ? presentServerMessage(e.detail) : t("errors.server.aiTurnFailed"));
    case "propose_failed":
      return e.detail ? presentServerMessage(e.detail) : t("ai.error.proposeFailed");
    case "review_backlog":
      return t("ai.error.reviewBacklog", { count: e.count });
    default:
      return t(COAUTHOR_ERROR[e.code]);
  }
}

const CROSS_DOC_ERROR: Record<CrossDocError["code"], MessageKey> = {
  locked: "ai.transcript.crossDocLocked",
  no_access: "ai.transcript.crossDocNoAccess",
  not_found: "ai.transcript.crossDocNotFound",
  too_large: "ai.transcript.crossDocTooLarge",
  stale: "ai.transcript.crossDocStale",
  ledger_unavailable: "ai.transcript.crossDocLedgerUnavailable",
  unreachable: "ai.transcript.crossDocUnreachable",
  refused: "ai.transcript.crossDocError",
};

/** Why a turn's edits to another document were not proposed there; `title` is that document's, worded already. */
export function crossDocErrorText(error: CrossDocError | undefined, title: string): string {
  return t(CROSS_DOC_ERROR[error?.code ?? "refused"], { title });
}
