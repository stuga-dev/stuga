/** Response helpers. CORS and the security headers are stamped by the dispatcher. */

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/**
 * A file download, buffered or streamed. The name goes into a quoted header, so
 * anything outside a plain filename alphabet is refused rather than escaped.
 * `no-store` because a download may carry a credential minted for it alone.
 */
export function download(
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
  filename: string,
  contentType: string,
): Response {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error(`unsafe download filename: ${filename}`);
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (body instanceof Uint8Array) headers.set("content-length", String(body.byteLength));
  return new Response(body, { headers });
}

/**
 * A Server-Sent Events response. The stream closes when `producer` settles, and
 * a throw becomes a final `error` event so the client never hangs. The signal
 * fires when the client goes away, so a long producer can stop spending.
 */
export function sse(producer: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        // After a disconnect the controller is closed and enqueueing would throw.
        if (abort.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await producer(send, abort.signal);
      } catch (e) {
        console.error("SSE producer failed", { error: e instanceof Error ? e.message : String(e) });
        send("error", { message: "stream failed" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
