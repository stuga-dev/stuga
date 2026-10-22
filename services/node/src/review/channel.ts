/**
 * A review channel: a Slack incoming webhook that hears of each run waiting for a colleague's
 * approval, once, with the item's title, who asked, the level and a link to the run's review card,
 * never the change's text. Only Slack's incoming-webhook host is accepted, so the address cannot
 * be pointed anywhere else. A post is written in the language of the person who set the channel up:
 * a channel has many readers.
 */
import { WEBHOOK_HOSTS, type WebhookKind } from "@stuga/protocol/domain/webhooks";
import { renderReviewOpen, renderReviewPost, type ReviewPostWords } from "@stuga/protocol/notify/render";
import { vetOutboundUrl } from "../net/outbound.js";

/** Why an address is refused for a Slack review channel. */
export const SLACK_HOST_ONLY = "a Slack review channel posts to https://hooks.slack.com/ only";

/**
 * Whether `raw` may be a hook of `kind`. A generic hook takes any absolute http(s) URL that does not
 * resolve into the operator's network; a Slack one only https to Slack's incoming-webhook host, with
 * no user name, password or port of its own.
 */
export async function vetWebhookUrl(kind: WebhookKind, raw: string, vet = vetOutboundUrl): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const hosts = WEBHOOK_HOSTS[kind];
  if (!hosts) {
    const verdict = await vet(raw);
    return verdict.ok ? { ok: true, url: verdict.url.toString() } : { ok: false, reason: verdict.reason };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: SLACK_HOST_ONLY };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: SLACK_HOST_ONLY };
  }
  return { ok: true, url: url.toString() };
}

/** Slack reads `<`, `>` and `&` as markup: a title holding them is escaped, so it cannot mention a channel or forge a link. */
export function slackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The body a Slack review channel is sent: one line in `language` and a link to the card. Slack is
 * told not to unfurl the link, which would only fetch the sign-in page.
 */
export function slackPostBody(post: ReviewPostWords, cardUrl: string, language: string): string {
  const line = slackText(renderReviewPost(post, language));
  const open = slackText(renderReviewOpen(language));
  return JSON.stringify({ text: `${line} · <${cardUrl}|${open}>`, unfurl_links: false, unfurl_media: false });
}
