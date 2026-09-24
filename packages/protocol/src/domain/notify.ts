/** Where a node delivers its notifications. */
export const NOTIFY_SINKS = ["slack", "teams", "discord", "email", "webhook", "none"] as const;

type NotifySink = (typeof NOTIFY_SINKS)[number];

/** Sinks that post to a URL; `email` needs an SMTP URL and From address instead. */
const WEBHOOK_SINKS: readonly NotifySink[] = ["slack", "teams", "discord", "webhook"];

/** Takes a plain string: both callers hold unvalidated input. */
export function isWebhookSink(sink: string): boolean {
  return (WEBHOOK_SINKS as readonly string[]).includes(sink);
}
