/** How the ACME client reaches its CA: global fetch in production, or node:https trusting a test CA's root. */
import https from "node:https";

export interface AcmeResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface AcmeTransport {
  request(
    url: string,
    /** `signal` gives up on the request, as when the issuance it belongs to is abandoned. */
    init: { method: "GET" | "HEAD" | "POST"; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<AcmeResponse>;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** What any CA would answer with; a certificate chain is a few KiB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function fetchTransport(): AcmeTransport {
  return {
    async request(url, init) {
      const res = await fetch(url, {
        method: init.method,
        ...(init.body !== undefined ? { body: init.body } : {}),
        headers: { "user-agent": "stuga-node", ...init.headers },
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])]),
        redirect: "error",
      });
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > MAX_RESPONSE_BYTES) throw new Error(`${url} answered more than ${MAX_RESPONSE_BYTES} bytes`);
      return { status: res.status, headers: res.headers, body };
    },
  };
}

/** Over node:https with `ca` as the only trusted root: for a CA a test runs, such as Pebble. */
export function httpsTransport(opts: { ca: string }): AcmeTransport {
  return {
    request(url, init) {
      return new Promise((resolve, reject) => {
        const req = https.request(
          url,
          {
            method: init.method,
            ca: opts.ca,
            headers: { "user-agent": "stuga-node", ...init.headers },
            timeout: REQUEST_TIMEOUT_MS,
            ...(init.signal ? { signal: init.signal } : {}),
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_RESPONSE_BYTES) req.destroy(new Error(`${url} answered more than ${MAX_RESPONSE_BYTES} bytes`));
              else chunks.push(chunk);
            });
            res.on("end", () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(res.headers)) {
                if (value === undefined) continue;
                for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
              }
              resolve({ status: res.statusCode ?? 0, headers, body: new Uint8Array(Buffer.concat(chunks)) });
            });
            res.on("error", reject);
          },
        );
        req.on("timeout", () => req.destroy(new Error(`${url} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`)));
        req.on("error", reject);
        req.end(init.body);
      });
    },
  };
}
