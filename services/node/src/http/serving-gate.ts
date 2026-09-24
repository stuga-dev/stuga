/**
 * What answers while the node is not serving: from the moment it holds its
 * database until it is ready, and while it pauses to back itself up. A browser
 * gets a page that says what is happening and reloads itself, instead of a
 * refused connection; `/ready` answers 503, so supervisors keep waiting; every
 * other request gets a 503 it can retry.
 *
 * Once open, requests go to the live handlers, and the gate counts the ones
 * still being answered, so a pause can wait for them to finish.
 */
import type { RequestHandler } from "../platform/http-server.js";

export type Pause = "starting" | "backing_up" | "upgrading" | "maintenance";

/** What a person reads while the node does not serve. */
const SAY: Record<Pause, string> = {
  starting: "Stuga is starting.",
  backing_up: "Stuga is backing up before an upgrade.",
  upgrading: "Stuga is upgrading.",
  maintenance: "Stuga is making a backup.",
};

const RETRY_SECONDS = 5;

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
  pause(why: Pause): void;
  /** Serve through `live`, or through the handlers already given when there is none. */
  open(live?: Live): void;
  /** Wait until no request that reached the live handlers is being answered; false when `timeoutMs` passes first. */
  drain(timeoutMs: number): Promise<boolean>;
}

export function createServingGate(): ServingGate {
  let live: Live | null = null;
  let paused: Pause | null = "starting";
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
      if (paused || !live) return notServing(req, paused ?? "starting");
      inFlight += 1;
      try {
        return await pick(live)(req);
      } finally {
        settle();
      }
    };
  };

  return {
    handler: through((l) => l.handler),
    upgrade: through((l) => l.upgrade),
    state: () => paused,
    pause(why) {
      paused = why;
    },
    open(next) {
      if (next) live = next;
      if (!live) throw new Error("the serving gate has nothing to serve through");
      paused = null;
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

function notServing(req: Request, why: Pause): Response {
  const headers = { "retry-after": String(RETRY_SECONDS), "cache-control": "no-store" };
  const path = new URL(req.url).pathname;
  if (path === "/ready") return Response.json({ ok: false, status: why }, { status: 503, headers });
  const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsPage) {
    return new Response(page(SAY[why]), { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }
  return Response.json({ error: "unavailable", status: why, message: SAY[why] }, { status: 503, headers });
}

function page(say: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_SECONDS}">
<title>Stuga</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { text-align: center; padding: 16px; }
  p { margin: 0 0 8px; }
  .quiet { opacity: 0.6; font-size: 0.9em; }
</style>
</head>
<body>
<main>
<p>${say}</p>
<p class="quiet">This page reloads by itself.</p>
</main>
</body>
</html>
`;
}
