/**
 * What a workspace webhook is: `generic` sends the event feed as signed JSON to any public URL;
 * `slack` is a review channel, posting one link-only message per run that waits for a colleague to
 * a Slack incoming webhook, and nothing else.
 */
export const WEBHOOK_KINDS = ["generic", "slack"] as const;

export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export function isWebhookKind(v: unknown): v is WebhookKind {
  return typeof v === "string" && (WEBHOOK_KINDS as readonly string[]).includes(v);
}

/** The only hosts a kind posts to; null for any public address. */
export const WEBHOOK_HOSTS: Record<WebhookKind, readonly string[] | null> = {
  generic: null,
  slack: ["hooks.slack.com"],
};
