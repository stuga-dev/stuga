/**
 * Passkeys end to end in a real browser: Chromium, with its virtual authenticator, against the
 * identity routes served as the remote listener serves them, at `http://k7f3q2.localhost:<port>`
 * (Chromium counts any *.localhost as a secure context, so it needs no certificate). The page drives
 * the ceremonies with @simplewebauthn/browser, the library the web app uses; the node checks them with
 * @simplewebauthn/server. Skipped where Playwright's Chromium is not installed
 * (`pnpm --filter @stuga/node exec playwright-core install chromium`), except in CI, which installs it
 * and fails without it.
 *
 * Only the test serves it this way: no setting turns a plain http listener into the remote address.
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { hashPassword } from "@stuga/auth";
import { ARRIVAL_HEADER, PEER_ADDRESS_HEADER } from "../platform/http-server.js";
import { harness, type Harness } from "./testing/harness.js";

const PASSWORD = "trumpet walnut ceiling";
const HOST = "k7f3q2.localhost";
const browserInstalled = existsSync(chromium.executablePath());

/** The browser library's ES modules, served to the page as they are. */
const LIB = join(dirname(dirname(createRequire(import.meta.url).resolve("@simplewebauthn/browser"))), "esm");

/** The page: the four ceremonies, against this address, as the web app makes them. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>passkeys</title>
<input autocomplete="username webauthn">
<script type="module">
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "/lib/index.js";
const post = async (path, body, token) => {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
window.e2e = {
  supported: () => browserSupportsWebAuthn() && window.isSecureContext,
  password: (username, password) => post("/auth/login", { username, password }),
  add: async (token) => {
    const opts = await post("/auth/passkey/options", { purpose: "add" }, token);
    if (opts.status !== 200) return opts;
    const credential = await startRegistration({ optionsJSON: opts.body.publicKey });
    return post("/auth/passkey/add", { credential }, token);
  },
  signIn: async () => {
    const opts = await post("/auth/passkey/options", { purpose: "sign-in" });
    const credential = await startAuthentication({ optionsJSON: opts.body.publicKey });
    return post("/auth/passkey/sign-in", { credential });
  },
  confirm: async (token) => {
    const opts = await post("/auth/passkey/options", { purpose: "reauth" }, token);
    if (opts.status !== 200) return opts;
    const credential = await startAuthentication({ optionsJSON: opts.body.publicKey });
    return post("/auth/passkey/sign-in", { credential }, token);
  },
};
document.title = "ready";
</script>`;

/** The identity routes behind a listener that stamps every request as the remote listener does. */
function serve(h: Harness): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
        return;
      }
      if (url.pathname.startsWith("/lib/")) {
        const file = normalize(join(LIB, url.pathname.slice("/lib/".length)));
        if (!file.startsWith(LIB) || !existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(readFileSync(file));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      headers.set(ARRIVAL_HEADER, "remote");
      headers.set(PEER_ADDRESS_HEADER, "203.0.113.7");
      const answer = await h.router.handle(
        new Request(url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }),
      );
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ origin: `http://${HOST}:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

type Answer<T = Record<string, unknown>> = { status: number; body: T };

// CI installs Chromium (.github/workflows/ci.yml): there, a missing one is a failure, not a skip.
it.runIf(process.env.CI === "true")("has Chromium to run in, in CI", () => {
  expect(browserInstalled, `no Chromium at ${chromium.executablePath()}`).toBe(true);
});

describe.skipIf(!browserInstalled)("passkeys in Chromium, with a virtual authenticator", () => {
  let h: Harness;
  let site: Awaited<ReturnType<typeof serve>>;
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;
  let authenticatorId: string;

  beforeAll(async () => {
    h = await harness();
    await h.account("liv", await hashPassword(PASSWORD));
    await h.account("bo", await hashPassword(PASSWORD));
    site = await serve(h);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    }));
    await page.goto(`${site.origin}/`);
    await page.waitForFunction(() => document.title === "ready");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    h?.close();
  });

  type Ceremonies = Record<string, (...a: unknown[]) => Promise<unknown>>;
  /** One of the page's ceremonies (window.e2e), run in the browser. */
  const run = <T,>(fn: string, ...args: unknown[]): Promise<Answer<T>> =>
    page.evaluate(
      ([name, rest]) => (window as unknown as { e2e: Ceremonies }).e2e[name]!(...rest),
      [fn, args] as [string, unknown[]],
    ) as Promise<Answer<T>>;

  it("is a secure context at a *.localhost address, with WebAuthn", async () => {
    expect(await page.evaluate(() => (window as unknown as { e2e: { supported(): boolean } }).e2e.supported())).toBe(true);
  });

  it("adds a passkey after a password sign-in, signs in with it alone, and confirms a session with it", async () => {
    const signedIn = await run<{ access_token: string; passkey_offer?: boolean }>("password", "bo", PASSWORD);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.passkey_offer).toBe(true);

    const added = await run<{ id: string; name: string; synced: boolean }>("add", signedIn.body.access_token);
    expect(added.status).toBe(201);
    const row = h.mem.passkeys.get(added.body.id)!;
    expect(row).toMatchObject({ alias: "u_bo", rp_id: HOST });
    // The authenticator holds a discoverable credential for this host, for Bo's account.
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: HOST });
    expect(Buffer.from(credentials[0]!.userHandle!, "base64").toString()).toBe("u_bo");

    // Signs in with no username: a session the passkey made.
    const withPasskey = await run<{ access_token: string; passkey_offer?: boolean }>("signIn");
    expect(withPasskey.status).toBe(200);
    expect(withPasskey.body.passkey_offer).toBeUndefined();
    const session = [...h.mem.sessions.values()].find((r) => r.passkey_id === added.body.id);
    expect(session).toMatchObject({ alias: "u_bo", signed_in_with: "passkey", arrival: "remote" });

    // An older session confirms it's Bo with the passkey.
    h.age(6);
    expect((await run("add", withPasskey.body.access_token)).status).toBe(401);
    expect((await run("confirm", withPasskey.body.access_token)).status).toBe(204);

    // Once the passkey is removed, it signs in nobody, and its session is over.
    h.mem.removePasskey(added.body.id);
    expect((await run<{ error: string }>("signIn")).body.error).toBe("passkey_invalid");
    expect((await run("confirm", withPasskey.body.access_token)).status).toBe(401);
  }, 60_000);
});
