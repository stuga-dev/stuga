/**
 * A notification's text in the reader's language, written from its event type and params
 * (./events.ts) when it is read: in the tray by the web app, outside the app by the node, which
 * takes the recipient's chosen language, else the one their browser asked for, else English. The
 * page a node shows while it does not serve is written here too, in the language the browser asks
 * for.
 */
import IntlMessageFormat from "intl-messageformat";
import { isUiLanguage, matchUiLanguage, type UiLanguage } from "../domain/ui-languages";
import { TIME_PARAMS, type ActorParam, type ChannelParams, type DatabaseChange } from "./events";
import de from "./messages/de.json" with { type: "json" };
import en from "./messages/en.json" with { type: "json" };
import es from "./messages/es.json" with { type: "json" };
import fr from "./messages/fr.json" with { type: "json" };
import ja from "./messages/ja.json" with { type: "json" };
import ko from "./messages/ko.json" with { type: "json" };
import ptBR from "./messages/pt-BR.json" with { type: "json" };
import zhHans from "./messages/zh-Hans.json" with { type: "json" };
import zhHant from "./messages/zh-Hant.json" with { type: "json" };

export type NotifyMessageKey = keyof typeof en;

export const NOTIFY_CATALOGS: Record<UiLanguage, Record<string, string>> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ja,
  ko,
  de,
  fr,
  es,
  "pt-BR": ptBR,
};

/** A reader's language as one the catalogs are written in: a regional tag reads its language, anything unknown English. */
export function notifyLanguage(language: string | null | undefined): UiLanguage {
  if (!language) return "en";
  if (isUiLanguage(language)) return language;
  return matchUiLanguage(language) ?? "en";
}

/** What the node writes outside the app in: the person's choice, else what their browser asked for at sign-in, else English. */
export function recipientLanguage(saved: { chosen: string | null; detected: string | null } | null | undefined): UiLanguage {
  const pick = (tag: string | null | undefined) => (tag && isUiLanguage(tag) ? tag : null);
  return pick(saved?.chosen) ?? pick(saved?.detected) ?? "en";
}

type Values = Record<string, string | number>;

const formatters = new Map<string, IntlMessageFormat>();

function format(language: UiLanguage, key: string, values: Values = {}): string {
  for (const lang of language === "en" ? (["en"] as const) : ([language, "en"] as const)) {
    const message = NOTIFY_CATALOGS[lang][key];
    if (message === undefined) continue;
    const cacheKey = `${lang}\u0000${key}`;
    let f = formatters.get(cacheKey);
    try {
      if (!f) {
        f = new IntlMessageFormat(message, lang, undefined, { ignoreTag: true });
        formatters.set(cacheKey, f);
      }
      return String(f.format(values));
    } catch {
      // A translation that cannot be written falls back to English.
    }
  }
  return key;
}

/**
 * An instant as a notification states it, in UTC, which a message sent outside the app shares with
 * the tray: `2026-09-30 14:02 UTC` in English, the language's own date and time otherwise.
 */
export function formatInstant(iso: string, language: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const lang = notifyLanguage(language);
  if (lang === "en") return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return new Intl.DateTimeFormat(lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(d);
}

const SERVICES: Record<string, string> = { slack: "Slack", teams: "Teams", discord: "Discord" };

/** A channel as an alert names it, with which webhook or sender, never the secret itself. */
export function renderChannel(c: ChannelParams, language: string): string {
  const lang = notifyLanguage(language);
  if (c.sink === "email") {
    if (c.another) return c.from ? format(lang, "channel.emailFromAnotherServer", { from: c.from }) : format(lang, "channel.emailAnotherServer");
    return c.from ? format(lang, "channel.emailFrom", { from: c.from }) : format(lang, "channel.email");
  }
  const service = SERVICES[c.sink];
  if (!service && c.sink !== "webhook") return format(lang, "channel.none");
  if (c.another) {
    if (service) return format(lang, c.host ? "channel.anotherServiceWebhookAt" : "channel.anotherServiceWebhook", { service, host: c.host ?? "" });
    return format(lang, c.host ? "channel.anotherWebhookAt" : "channel.anotherWebhook", { host: c.host ?? "" });
  }
  if (service) return c.host ? format(lang, "channel.serviceAt", { service, host: c.host }) : service;
  return format(lang, c.host ? "channel.webhookAt" : "channel.webhook", { host: c.host ?? "" });
}

/** One database change, as a sentence. */
export function renderDatabaseChange(change: DatabaseChange, language: string): string {
  const lang = notifyLanguage(language);
  const values: Values = {};
  if ("count" in change) values.count = change.count;
  if ("table" in change) values.table = change.table;
  return format(lang, `databaseChange.${change.kind}`, values);
}

/** Who caused a notification, in the reader's language: a person by name, an agent or an AI co-author by the person it acts for. */
export function renderActor(actor: ActorParam, language: string): string {
  if (typeof actor === "string") return actor;
  const lang = notifyLanguage(language);
  if ("agent_of" in actor) return format(lang, "actor.agentOf", { person: actor.agent_of });
  return format(lang, "actor.coauthorOf", { person: actor.coauthor_of });
}

export function isActor(v: unknown): v is Exclude<ActorParam, string> {
  if (typeof v !== "object" || v === null) return false;
  const a = v as { agent_of?: unknown; coauthor_of?: unknown };
  return typeof a.agent_of === "string" || typeof a.coauthor_of === "string";
}

function isChannel(v: unknown): v is ChannelParams {
  return typeof v === "object" && v !== null && typeof (v as ChannelParams).sink === "string";
}

function isDatabaseChange(v: unknown): v is DatabaseChange {
  return typeof v === "object" && v !== null && typeof (v as DatabaseChange).kind === "string";
}

/**
 * The ICU arguments for a notification's params: instants formatted, an empty document title read
 * as Untitled, an agent named by its person, a channel or a change put in words, and beside every
 * param `<name>Known`, `yes` or `no`, which a message selects on where a param may be absent.
 */
function argumentsOf(params: Record<string, unknown>, lang: UiLanguage): Values {
  const out: Values = {};
  for (const [name, value] of Object.entries(params)) {
    out[`${name}Known`] = value === null || value === undefined || value === "" ? "no" : "yes";
    if (value === null || value === undefined) out[name] = "";
    else if (typeof value === "string") out[name] = TIME_PARAMS.includes(name) ? formatInstant(value, lang) : value;
    else if (typeof value === "number") out[name] = value;
    else if (typeof value === "boolean") out[name] = value ? "yes" : "no";
    else if (isActor(value)) out[name] = renderActor(value, lang);
    else if (isChannel(value)) out[name] = renderChannel(value, lang);
    else if (isDatabaseChange(value)) out[name] = renderDatabaseChange(value, lang);
  }
  if (out.doc === "") out.doc = format(lang, "untitled");
  if (out.change === "") out.change = format(lang, "untitled");
  return out;
}

/** Whether the catalogs have text for this event type. */
export function isRenderableEvent(eventType: string): boolean {
  return `${eventType}.title` in en;
}

/**
 * A notification's title and body in `language` (any BCP 47 tag; one without a catalog reads
 * English); null for an event type the catalogs do not know.
 */
export function renderNotification(eventType: string, params: unknown, language: string): { title: string; body: string } | null {
  if (!isRenderableEvent(eventType)) return null;
  const lang = notifyLanguage(language);
  const values = argumentsOf(typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}, lang);
  return { title: format(lang, `${eventType}.title`, values), body: format(lang, `${eventType}.body`, values) };
}

/** The label of the link a message sent outside the app carries. */
export function renderOpenAction(language: string): string {
  return format(notifyLanguage(language), "action.open");
}

/** What a review channel says of a run waiting for a decision: names, a count and the level, never the change's text. */
export interface ReviewPostWords {
  /** The item's title; empty reads as Untitled. */
  doc: string;
  /** The person who asked the AI. */
  author: string;
  agent: string;
  count: number;
  level: "auto" | "review" | "colleague";
}

/** A review channel's post, in `language`: the channel's creator's, since a channel has many readers. */
export function renderReviewPost(post: ReviewPostWords, language: string): string {
  const lang = notifyLanguage(language);
  return format(lang, "review.post", { ...post, doc: post.doc || format(lang, "untitled") });
}

/** What a review channel says of a change waiting for a decision: its title, who asked and which AI, never a page's title or text. */
export interface ChangePostWords {
  /** The change's title; empty reads as Untitled. */
  change: string;
  author: string;
  agent: string;
  level: "auto" | "review" | "colleague";
}

/** A review channel's post about a change, in `language`. */
export function renderChangePost(post: ChangePostWords, language: string): string {
  const lang = notifyLanguage(language);
  return format(lang, "review.postChange", { ...post, change: post.change || format(lang, "untitled") });
}

/** The label of the link a review channel's post carries to the run's review card. */
export function renderReviewOpen(language: string): string {
  return format(notifyLanguage(language), "review.open");
}

/** Why a node does not serve for now. */
export type GateWaiting = "starting" | "backing_up" | "upgrading" | "maintenance";

/**
 * Why a node refused its database: the release that served it last when that may be the newer one,
 * else null for a newer Stuga it cannot name; `version` is this build's.
 */
export interface GateRefusal {
  servedBy: string | null;
  version: string;
}

/** The page a node shows while it does not serve: what is happening, and the line saying the page reloads. */
export function renderGatePage(why: GateWaiting | GateRefusal, language: string): { title: string; body: string | null; reloads: string } {
  const lang = notifyLanguage(language);
  const reloads = format(lang, "gate.reloads");
  if (typeof why === "string") return { title: format(lang, `gate.${why}`), body: null, reloads };
  if (why.servedBy === null) return { title: format(lang, "gate.newerTitle"), body: format(lang, "gate.newerBody"), reloads };
  const values = { servedBy: why.servedBy, version: why.version };
  return { title: format(lang, "gate.servedByTitle", values), body: format(lang, "gate.servedByBody", values), reloads };
}
