/**
 * An app-wide notice while the node cannot do its job, from polling /ready,
 * which runs a database query. The decisions live in state/node-health; this
 * owns the fetch, the timer and the banner.
 */
import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import {
  PROBE_TIMEOUT_MS,
  newNodeHealth,
  notice,
  observe,
  pollDelay,
  type NodeNotice,
  type Probe,
} from "../state/node-health";

/** Once per page load, not per poll. */
let warnedOpaque = false;
function warnOpaqueOnce(): void {
  if (warnedOpaque) return;
  warnedOpaque = true;
  console.warn(
    "GET /ready answered 200 without the node's {ok:true} body — something in front of this node is " +
      "resolving it (an SPA index.html fallback is the usual cause). The server-health notice is disabled " +
      "until /ready reaches the node.",
  );
}

/** One unauthenticated probe of /ready. */
async function probeReady(): Promise<Probe> {
  // A fetch that fails with no network says nothing about the server. `onLine === false` is never a false positive.
  if (navigator.onLine === false) return "offline";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("/ready", { cache: "no-store", signal: abort.signal });
    if (res.ok) {
      // A proxy's SPA fallback answers /ready 200 with HTML, so only the node's own body counts.
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (body?.ok === true) return "ok";
      warnOpaqueOnce();
      return "opaque";
    }
    // 503 is the node saying its database is unreachable; any other status came from something in front of it.
    return res.status === 503 ? "unready" : "unreachable";
  } catch {
    // A network error, or the timeout that keeps a hung probe from stalling the loop.
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export function NodeHealthBanner() {
  const [current, setCurrent] = useState<NodeNotice | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probing = false;
    // Not state: the loop reads it synchronously, and only a changed notice should render.
    let health = newNodeHealth();

    const tick = async (): Promise<void> => {
      if (probing) return;
      probing = true;
      let result: Probe;
      try {
        result = await probeReady();
      } finally {
        probing = false;
      }
      if (stopped) return;
      health = observe(health, result);
      // `notice()` returns a fresh object, so compare by title.
      setCurrent((prev) => {
        const next = notice(health);
        return prev?.title === next?.title ? prev : next;
      });
      timer = setTimeout(() => void tick(), pollDelay(health));
    };

    const probeNow = (): void => {
      clearTimeout(timer);
      void tick();
    };

    // A background tab's timers are throttled, so its verdict may be minutes old.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") probeNow();
    };

    void tick();
    addEventListener("online", probeNow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      removeEventListener("online", probeNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!current) return null;
  return (
    <Banner
      className="node-health"
      container="card"
      elevation="high"
      status={current.status}
      title={current.title}
      description={current.description}
    />
  );
}
