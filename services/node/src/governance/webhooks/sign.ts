/** How a webhook body is signed and the limits a delivery runs under: what a receiver needs to know. */
import { createHmac } from "node:crypto";

/** How long one delivery may take before it counts as a failure. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Consecutive failures after which a hook is switched off until a person re-enables it. */
export const WEBHOOK_MAX_FAILURES = 20;

/** `sha256=<hex>` HMAC over the exact request body, keyed by the hook's secret. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
