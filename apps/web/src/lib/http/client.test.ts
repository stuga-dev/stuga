// @vitest-environment jsdom
/** Where a refused response sends the page, and what it leaves for the page it lands on. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdForEnding, observeResponse } from "./client";
import { membershipEnded, sessionEnded } from "../session/endings";
import { peekLoginReturn } from "../session/return-path";
import { getActiveWorkspace, rememberWorkspaceName, setActiveWorkspace } from "../session/workspace-pointer";

/** The page's address, and where the code sent it. */
let sentTo: string | null;

function at(path: string): void {
  sentTo = null;
  const url = new URL(path, "http://localhost:3101");
  vi.stubGlobal("location", {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    get href() {
      return url.href;
    },
    set href(to: string) {
      sentTo = to;
    },
  });
}

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const WORKSPACE_REQUIRED = headers({ "x-stuga-workspace-required": "1" });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a 401", () => {
  it("goes to sign in, saying why, and comes back to this page after", () => {
    at("/doc/d_1?row=r1");
    observeResponse(401, headers({}));
    expect(sentTo).toBe("/login");
    expect(sessionEnded()).toBe(true);
    expect(peekLoginReturn()).toBe("/doc/d_1?row=r1");
  });
});

describe("the no-membership marker", () => {
  it("goes to onboarding, naming the workspace that was left", () => {
    setActiveWorkspace("ws_1");
    rememberWorkspaceName("ws_1", "Bakery");
    at("/doc/d_1");
    observeResponse(409, WORKSPACE_REQUIRED);
    expect(sentTo).toBe("/onboarding");
    expect(membershipEnded()).toBe("Bakery");
    expect(getActiveWorkspace()).toBeNull();
  });

  it("waits while a page shows the ending itself, with text still to copy", () => {
    at("/doc/d_1");
    holdForEnding(true);
    try {
      observeResponse(409, WORKSPACE_REQUIRED);
    } finally {
      holdForEnding(false);
    }
    expect(sentTo).toBeNull();
  });

  it("leaves an invite or share link page where it is, so the link can be redeemed", () => {
    for (const page of ["/s/shl_abc", "/join/inv_abc"]) {
      at(page);
      observeResponse(409, WORKSPACE_REQUIRED);
      expect(sentTo, page).toBeNull();
    }
    expect(membershipEnded()).toBeNull();
  });
});

describe("a request that never reached the node", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  });

  it("says the person is offline when the browser has no network", async () => {
    const { networkFailure } = await import("./client");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    expect(networkFailure().message).toBe("You’re offline. Try again when you’re back online.");
  });

  it("says the node could not be reached otherwise", async () => {
    const { networkFailure } = await import("./client");
    expect(networkFailure().message).toBe("Couldn’t reach the node. Check your connection and try again.");
    expect(networkFailure().code).toBe("network");
  });
});
