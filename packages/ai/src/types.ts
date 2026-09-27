/** Usage in the shape the ledger records, and the image types a turn can carry. */
import type { Usage } from "@earendil-works/pi-ai";

/** Token usage; providers without a prompt cache report zero cache tokens. The buckets are disjoint. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

/** Pi's usage in the ledger's shape; its buckets are disjoint too. */
export function usageOf(u: Usage): TokenUsage {
  return { inputTokens: u.input, outputTokens: u.output, cacheReadInputTokens: u.cacheRead, cacheWriteInputTokens: u.cacheWrite };
}

export function addUsage(into: TokenUsage, u: TokenUsage): void {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.cacheReadInputTokens += u.cacheReadInputTokens;
  into.cacheWriteInputTokens += u.cacheWriteInputTokens;
}

/** The image types every provider takes, by the media store's MIME. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The MIME to send for a stored image, or null for a type no model takes. */
export function imageMime(mime: string): string | null {
  const m = mime.toLowerCase();
  return IMAGE_MIMES.has(m) ? m : null;
}
