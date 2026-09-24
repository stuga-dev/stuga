/** HTTP plumbing shared by the provider clients. */

/**
 * A model-endpoint failure. `retryable` is true for 429, 5xx and network faults;
 * other 4xx fail the same way on retry.
 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number, // 0 = network/no-response
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Time to response headers. Not a whole-request timeout, which would cut long
 * streamed answers; it bounds an endpoint that accepts the connection and never
 * answers, which would otherwise hold the caller's turn lock forever.
 */
const RESPONSE_START_TIMEOUT_MS = 60_000;

interface FetchRetryOptions {
  /** Attempts in total, the first included. */
  attempts?: number;
  /**
   * Cuts the headers wait, the body or a backoff sleep, and stops retrying. The
   * abort reason is rethrown unwrapped; callers check `signal.aborted`.
   */
  signal?: AbortSignal;
}

/**
 * Fetch with exponential backoff and jitter, retrying only 429, 5xx and network
 * faults. A final non-2xx becomes an AiError carrying the status and body.
 */
export async function fetchWithRetry(
  label: string,
  doFetch: (signal: AbortSignal) => Promise<Response>,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const caller = opts.signal;
  let lastErr: AiError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (caller?.aborted) throw caller.reason;
    let res: Response;
    const start = new AbortController();
    // The start timeout is disarmed once headers arrive; the caller's signal stays wired over the body.
    const signal = caller ? AbortSignal.any([caller, start.signal]) : start.signal;
    const timer = setTimeout(() => start.abort(new Error(`no response after ${RESPONSE_START_TIMEOUT_MS}ms`)), RESPONSE_START_TIMEOUT_MS);
    try {
      res = await doFetch(signal);
    } catch (e) {
      if (caller?.aborted) throw caller.reason;
      lastErr = new AiError(`${label} network error: ${(e as Error).message}`, 0, true);
      if (attempt < attempts - 1) {
        await backoff(attempt, caller);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    const status = res.status;
    const retryable = isRetryableStatus(status);
    const body = await res.text();
    lastErr = new AiError(`${label} ${status}: ${body}`, status, retryable);
    if (retryable && attempt < attempts - 1) {
      await backoff(attempt, caller);
      continue;
    }
    throw lastErr;
  }
  throw lastErr ?? new AiError(`${label} failed`, 0, true);
}

/** ~250ms, 500ms, 1s, 2s (capped 4s) with jitter; ends early when `signal` aborts. */
async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = Math.min(250 * 2 ** attempt, 4000);
  const delay = base / 2 + Math.floor(Math.random() * (base / 2));
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delay);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** JSON headers plus an optional bearer token (OpenAI-compatible and Ollama). */
export function jsonHeaders(apiKey: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Yield the body line by line, without terminators; a final unterminated line is yielded at close. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf.replace(/\r$/, "");
}

/** The JSON payload of every SSE `data:` line; event names are ignored and non-JSON lines skipped. */
export async function* readSseJson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let parsed: T;
    try {
      parsed = JSON.parse(data) as T;
    } catch {
      continue;
    }
    yield parsed;
  }
}

/** Yield every non-blank line of a newline-delimited JSON stream, parsed. */
export async function* readNdjson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    const t = line.trim();
    if (!t) continue;
    let parsed: T;
    try {
      parsed = JSON.parse(t) as T;
    } catch {
      continue;
    }
    yield parsed;
  }
}
