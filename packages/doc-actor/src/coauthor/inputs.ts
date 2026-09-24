/**
 * Bounding what one AI_REQUEST frame may hand the model. The payload is client
 * JSON, so nothing in it is trusted to match `AiRequest`.
 */
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import type { AiAttachment, AiHistoryItem, AiRequest } from "@stuga/protocol/wire/doc-socket";
import type { InternalApi } from "@stuga/runtime";

const MAX_ATTACHMENTS = 8;

/**
 * Attachments whose pixels reach the model, and their size. Chat providers cap
 * one image well below the media store's ceiling; past four, base64 dominates
 * the request. The rest keep their url and name in the prompt.
 */
const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 3_500_000;

/** Transcript caps match `/api/ask` and the tables' `/ai`; the prompt is wider because it may carry pasted text. */
export const MAX_AI_PROMPT_CHARS = 16_000;
export const MAX_AI_HISTORY_TURNS = 6;
export const MAX_AI_HISTORY_CHARS = 4_000;

/** Base64 in fixed-size chunks: spreading a multi-megabyte array into fromCharCode overflows the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/**
 * Keep only attachments naming a media path on this node. The url is
 * client-chosen and lands in the model's context as "use this verbatim", so the
 * co-author only ever emits paths this server serves.
 */
export function sanitizeAttachments(list: AiAttachment[] | undefined): Array<{ url: string; name: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ url: string; name: string }> = [];
  for (const a of list) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!a || typeof a.url !== "string" || !MEDIA_GET_PATH.test(a.url)) continue;
    const name = typeof a.name === "string" ? a.name.slice(0, 120) : "";
    out.push({ url: a.url, name: name || "image" });
  }
  return out;
}

function isHistoryItem(h: unknown): h is AiHistoryItem {
  if (typeof h !== "object" || h === null) return false;
  const { role, content } = h as Partial<AiHistoryItem>;
  return (role === "user" || role === "assistant") && typeof content === "string";
}

export function clampAiRequest(raw: AiRequest): AiRequest {
  const prompt = typeof raw.prompt === "string" ? raw.prompt.slice(0, MAX_AI_PROMPT_CHARS) : "";
  const history = (Array.isArray(raw.history) ? (raw.history as unknown[]) : [])
    .filter(isHistoryItem)
    .slice(-MAX_AI_HISTORY_TURNS)
    .map((h) => ({ role: h.role, content: h.content.slice(0, MAX_AI_HISTORY_CHARS) }));
  return {
    ...raw,
    prompt,
    history,
    selected_text: typeof raw.selected_text === "string" ? raw.selected_text : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : "auto",
    collection_id: typeof raw.collection_id === "string" && raw.collection_id ? raw.collection_id : null,
  };
}

/**
 * Load attachment pixels through the node's media route (which needs the
 * tenant, taken from the session, never the attachment). Every failure keeps the
 * attachment as url and name only; the turn still runs.
 */
export async function loadAttachmentPixels(
  internal: InternalApi,
  list: Array<{ url: string; name: string }>,
  workspaceId: string,
): Promise<Array<{ url: string; name: string; bytes?: string; mime?: string }>> {
  const out: Array<{ url: string; name: string; bytes?: string; mime?: string }> = [];
  let shown = 0;
  for (const a of list) {
    if (shown >= MAX_VISION_IMAGES) {
      out.push(a);
      continue;
    }
    try {
      const res = await internal.fetch(a.url, { headers: { "x-stuga-workspace": workspaceId } });
      if (!res.ok) {
        out.push(a);
        continue;
      }
      const mime = res.headers.get("content-type") ?? "";
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_VISION_IMAGE_BYTES) {
        out.push(a);
        continue;
      }
      out.push({ ...a, bytes: toBase64(buf), mime });
      shown += 1;
    } catch {
      out.push(a);
    }
  }
  return out;
}
