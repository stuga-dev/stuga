/** Server-sent events over POST. Not through `authedFetch`, whose timeout a long turn outlives. */
import { t } from "../../i18n/i18n";
import { authHeaders } from "./client";
import { presentServerMessage } from "./server-messages";

type SseEventHandler = (event: string, data: Record<string, unknown>) => void;

async function readSseFrames(body: ReadableStream<Uint8Array>, onEvent: SseEventHandler): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const ev = /event: (.*)/.exec(frame)?.[1];
      const dataLine = /data: (.*)/.exec(frame)?.[1];
      if (!ev || !dataLine) continue;
      onEvent(ev, JSON.parse(dataLine) as Record<string, unknown>);
    }
  }
}

/** The server's own wording, in the reader's language, for a stream that never opened; else `fallback`. */
async function streamFailureMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return presentServerMessage(body.error);
  } catch {
    /* not the node's JSON */
  }
  return fallback;
}

/**
 * POST `body` and stream the reply's events. A refusal before the stream opens
 * reaches `onError` in the server's own words, anything else in the catalog's.
 * Aborting the controller cancels quietly.
 */
export function openSse(
  path: string,
  body: unknown,
  handlers: { onEvent: SseEventHandler; onError: (message: string) => void },
): AbortController {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(path, {
      method: "POST",
      headers: await authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      handlers.onError(await streamFailureMessage(res, t("errors.client.streamFailed", { status: String(res.status) })));
      return;
    }
    await readSseFrames(res.body, handlers.onEvent);
  })().catch((e) => {
    if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
    // The connection failed or dropped mid-stream; the browser's own words are English.
    if (import.meta.env.DEV) console.warn(`sse ${path}`, e);
    handlers.onError(t("errors.client.offline"));
  });
  return controller;
}
