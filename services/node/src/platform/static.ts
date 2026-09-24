/** Serves the built app bundle; an unknown extensionless path gets index.html, for client-side routing. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { RequestHandler } from "./http-server.js";

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
};

/** Files under this prefix carry content hashes, so they may be cached forever. */
const IMMUTABLE_PREFIX = "/assets/";

export function serveStatic(dir: string): RequestHandler {
  const root = resolve(dir);

  const fileResponse = async (path: string, urlPath: string, head: boolean): Promise<Response | null> => {
    let st;
    try {
      st = await stat(path);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const headers = new Headers({
      "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": urlPath.startsWith(IMMUTABLE_PREFIX) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    const body = head ? null : (Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>);
    return new Response(body, { status: 200, headers });
  };

  return async (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return textResponse(405, "method not allowed");
    const head = method === "HEAD";
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return textResponse(400, "bad path");
    }
    const relative = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const target = resolve(root, "." + relative);
    if (target !== root && !target.startsWith(root + sep)) return textResponse(403, "forbidden");

    const direct = await fileResponse(urlPath.endsWith("/") ? join(target, "index.html") : target, urlPath, head);
    if (direct) return direct;
    if (!extname(urlPath)) {
      const index = await fileResponse(join(root, "index.html"), "/index.html", head);
      if (index) return index;
    }
    return textResponse(404, "not found");
  };
}
