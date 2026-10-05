/**
 * What answers while the node is not serving: from the moment it holds its
 * database until it is ready, and while it pauses to back itself up. A browser
 * gets a page that says what is happening and reloads itself, instead of a
 * refused connection; `/ready` answers 503, so supervisors keep waiting; every
 * other request gets a 503 it can retry.
 *
 * A node that refused its database (boot/data-version.ts) stays here until it
 * is stopped: `/ready` says `refused` with nothing to retry, and the page says
 * which version to start or which backup to restore.
 *
 * Once open, requests go to the live handlers, and the gate counts the ones
 * still being answered, so a pause can wait for them to finish. A response
 * whose body is still being written counts until that is done, when its
 * handler says so (answeredUntil).
 */
import type { FrontDoor, RequestHandler } from "../platform/http-server.js";
import { applyRemoteHeaders, applySecurityHeaders } from "./security-headers.js";

/** Why the node does not serve for now. */
type Waiting = "starting" | "backing_up" | "upgrading" | "maintenance";
export type Pause = Waiting | "refused";

/** What a person reads while the node does not serve. */
const SAY: Record<Waiting, string> = {
  starting: "Stuga is starting.",
  backing_up: "Stuga is backing up before an upgrade.",
  upgrading: "Stuga is upgrading.",
  maintenance: "Stuga is making a backup.",
};

const RETRY_SECONDS = 5;
/** A refusal lasts until someone acts on the machine; the page only looks again now and then. */
const REFUSED_RELOAD_SECONDS = 30;

/** Why the node refused its database, for the page that says so. */
export interface Refusal {
  title: string;
  body: string;
  /** What to run on the machine; null when the packaging names no way to run it. */
  command: string | null;
}

export interface Live {
  handler: RequestHandler;
  upgrade: RequestHandler;
}

export interface ServingGate {
  /** The listener's handler for ordinary requests. */
  handler: RequestHandler;
  /** The listener's handler for WebSocket upgrades. */
  upgrade: RequestHandler;
  /** What the node is doing; null while it serves. */
  state(): Pause | null;
  /** Stop serving and say why. Requests already being answered finish. */
  pause(why: Waiting): void;
  /** Serve through `live`, or through the handlers already given when there is none. */
  open(live?: Live): void;
  /** Stop for good: the node refused its database. Nothing serves, pauses or opens again until it stops. */
  refuse(text: Refusal): void;
  /** Wait until no request that reached the live handlers is being answered; false when `timeoutMs` passes first. */
  drain(timeoutMs: number): Promise<boolean>;
}

/** Responses whose body is written after their handler returns, with what settles once it is. */
const writing = new WeakMap<Response, Promise<unknown>>();

/**
 * Count `response` as being answered until `done` settles rather than until its handler returns:
 * for a body written as the client reads it, from the actors a pause for a backup closes.
 * `done` must settle however the body ends, the client going away included.
 */
export function answeredUntil(response: Response, done: Promise<unknown>): Response {
  writing.set(response, done);
  return response;
}

export function createServingGate(): ServingGate {
  let live: Live | null = null;
  let paused: Waiting | null = "starting";
  let refusal: Refusal | null = null;
  let inFlight = 0;
  let idle: (() => void)[] = [];

  const settle = () => {
    inFlight -= 1;
    if (inFlight === 0) {
      for (const wake of idle) wake();
      idle = [];
    }
  };

  const through = (pick: (l: Live) => RequestHandler): RequestHandler => {
    return async (req) => {
      if (refusal) return refused(req, refusal);
      if (paused || !live) return notServing(req, paused ?? "starting");
      inFlight += 1;
      let res: Response;
      try {
        res = await pick(live)(req);
      } catch (err) {
        settle();
        throw err;
      }
      const done = writing.get(res);
      if (done) void done.then(settle, settle);
      else settle();
      return res;
    };
  };

  return {
    handler: through((l) => l.handler),
    upgrade: through((l) => l.upgrade),
    state: () => (refusal ? "refused" : paused),
    pause(why) {
      if (refusal) throw new Error("the node refused its database");
      paused = why;
    },
    open(next) {
      if (refusal) throw new Error("the node refused its database");
      if (next) live = next;
      if (!live) throw new Error("the serving gate has nothing to serve through");
      paused = null;
    },
    refuse(text) {
      refusal = text;
    },
    drain(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          idle = idle.filter((w) => w !== wake);
          resolve(false);
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
        idle.push(wake);
      });
    },
  };
}

function notServing(req: Request, why: Waiting): Response {
  const headers = { "retry-after": String(RETRY_SECONDS), "cache-control": "no-store" };
  const path = new URL(req.url).pathname;
  if (path === "/ready") return Response.json({ ok: false, status: why }, { status: 503, headers });
  const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsPage) {
    return new Response(page(`<p>${SAY[why]}</p>`, RETRY_SECONDS), {
      status: 503,
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  }
  return Response.json({ error: "unavailable", status: why, message: SAY[why] }, { status: 503, headers });
}

/** No retry-after: waiting does not end a refusal. */
function refused(req: Request, text: Refusal): Response {
  const headers = { "cache-control": "no-store" };
  const path = new URL(req.url).pathname;
  if (path === "/ready") return Response.json({ ok: false, status: "refused" }, { status: 503, headers });
  const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsPage) {
    const command = text.command === null ? "" : `\n<pre><code>${escapeHtml(text.command)}</code></pre>`;
    const body = `<p><strong>${escapeHtml(text.title)}</strong></p>\n<p>${escapeHtml(text.body)}</p>${command}`;
    return new Response(page(body, REFUSED_RELOAD_SECONDS), {
      status: 503,
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  }
  return Response.json({ error: "refused", status: "refused", message: text.title }, { status: 503, headers });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(content: string, reloadSeconds: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${reloadSeconds}">
<title>Stuga</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { text-align: center; padding: 16px; max-width: 40em; }
  p { margin: 0 0 8px; }
  pre { text-align: left; white-space: pre-wrap; word-break: break-all; padding: 8px 12px; border: 1px solid currentColor; border-radius: 6px; }
  .quiet { opacity: 0.6; font-size: 0.9em; }
</style>
</head>
<body>
<main>
${content}
<p class="quiet">This page reloads by itself.</p>
</main>
</body>
</html>
`;
}

/**
 * The front door as the remote listener asks it: while the node is paused the gate answers, and nothing
 * is looked up; a refusal goes out with the headers every answer there carries.
 */
export function behindGate(gate: Pick<ServingGate, "state" | "handler">, frontDoor: FrontDoor): FrontDoor {
  return async (head) => {
    const admitted = gate.state() !== null ? await gate.handler(head) : await frontDoor(head);
    return admitted instanceof Response ? applyRemoteHeaders(applySecurityHeaders(head, admitted)) : admitted;
  };
}
