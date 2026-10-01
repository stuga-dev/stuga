import { describe, expect, it } from "vitest";
import {
  clearMediaCookieHeader,
  mediaCookieHeader,
  mediaCookieName,
  mediaCorp,
  mintMediaTicket,
  readCookie,
  readMediaCookie,
  verifyMediaTicket,
} from "./media-auth.js";

const SECRET = "internal-secret-value";
const NOW = 1_760_000_000_000;
const WS = "ws-AbC123xyz789";

/** A person's ticket minted on the node's own network. */
const lan = (alias: string, workspaceId: string) => ({ alias, workspaceId, sid: "sess-1", arrival: "local" as const });

describe("media ticket", () => {
  it("round-trips the alias and workspace it was minted for", async () => {
    const { value, expiresAt } = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW);
    const ticket = await verifyMediaTicket(SECRET, value, "local", NOW);
    expect(ticket?.alias).toBe("user-abc");
    expect(ticket?.workspaceId).toBe(WS);
    expect(ticket?.expiresAt).toBe(expiresAt);
  });

  it("refuses a ticket whose signed workspace was edited", async () => {
    const { value } = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW);
    const [alias, , sid, exp, sig] = value.split(".");
    const other = btoa("ws-otherTenant").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyMediaTicket(SECRET, `${alias}.${other}.${sid}.${exp}.${sig}`, "local", NOW)).toBeNull();
  });

  it("rejects a workspace id that could escape its media prefix", async () => {
    const { value } = await mintMediaTicket(SECRET, lan("user-abc", "../trash"), NOW);
    expect(await verifyMediaTicket(SECRET, value, "local", NOW)).toBeNull();
  });

  it("survives an alias that is not URL-safe", async () => {
    const alias = "user+/=?ü";
    const { value } = await mintMediaTicket(SECRET, lan(alias, WS), NOW);
    expect(value).not.toContain("+");
    expect((await verifyMediaTicket(SECRET, value, "local", NOW))?.alias).toBe(alias);
  });

  it("rejects a ticket signed with a different secret", async () => {
    const { value } = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW);
    expect(await verifyMediaTicket("some-other-secret", value, "local", NOW)).toBeNull();
  });

  it("rejects a tampered alias or expiry", async () => {
    const { value } = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW);
    const [alias, ws, sid, exp, sig] = value.split(".");
    expect(await verifyMediaTicket(SECRET, `${alias}.${ws}.${sid}.${Number(exp) + 86_400}.${sig}`, "local", NOW)).toBeNull();
    expect(await verifyMediaTicket(SECRET, `${alias}X.${ws}.${sid}.${exp}.${sig}`, "local", NOW)).toBeNull();
    // Nor the session it was minted for.
    expect(await verifyMediaTicket(SECRET, `${alias}.${ws}.${btoa("sess-2").replace(/=+$/, "")}.${exp}.${sig}`, "local", NOW)).toBeNull();
  });

  it("expires", async () => {
    const { value, expiresAt } = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW, 60);
    expect(await verifyMediaTicket(SECRET, value, "local", expiresAt * 1000 - 1_000)).not.toBeNull();
    expect(await verifyMediaTicket(SECRET, value, "local", expiresAt * 1000 + 1_000)).toBeNull();
  });

  it("carries the session it was minted for, or none for an agent's key", async () => {
    const person = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW);
    expect((await verifyMediaTicket(SECRET, person.value, "local", NOW))?.sid).toBe("sess-1");
    const agent = await mintMediaTicket(SECRET, { alias: "agent-1", workspaceId: WS, sid: null, arrival: "local" }, NOW);
    expect((await verifyMediaTicket(SECRET, agent.value, "local", NOW))?.sid).toBeNull();
  });

  it("reads media only at the listener that minted it", async () => {
    const local = await mintMediaTicket(SECRET, lan("user-abc", WS), NOW);
    const remote = await mintMediaTicket(SECRET, { ...lan("user-abc", WS), arrival: "remote" }, NOW);
    expect(await verifyMediaTicket(SECRET, local.value, "remote", NOW)).toBeNull();
    expect(await verifyMediaTicket(SECRET, remote.value, "local", NOW)).toBeNull();
    expect((await verifyMediaTicket(SECRET, remote.value, "remote", NOW))?.workspaceId).toBe(WS);
  });

  it("rejects junk without throwing", async () => {
    for (const junk of ["", "abc", "a.b", "a.b.1.c.d", "a.b.notanumber.c", "...", null, undefined]) {
      expect(await verifyMediaTicket(SECRET, junk, "local", NOW)).toBeNull();
    }
  });
});

describe("cookie transport", () => {
  const httpsReq = new Request("https://api.example.com/api/media/ticket");
  const httpReq = new Request("http://localhost:8787/api/media/ticket");

  it("is __Host- on https, where the browser holds it to this very origin, and plain on http", () => {
    expect(mediaCookieName(httpsReq)).toBe("__Host-stuga_media");
    expect(mediaCookieName(httpReq)).toBe("stuga_media");
    // What __Host- requires: Secure, Path=/, no Domain.
    const header = mediaCookieHeader(httpsReq, { mediaCookieSameSite: "Lax" }, "tok", 7200);
    expect(header).toMatch(/^__Host-stuga_media=tok; Path=\/;/);
    expect(header).not.toMatch(/domain=/i);
    expect(mediaCookieHeader(httpReq, { mediaCookieSameSite: "Lax" }, "tok", 7200)).toMatch(/^stuga_media=tok;/);
  });

  it("is read back under the name the request's scheme gives it, and no other", () => {
    const both = "stuga_media=plain; __Host-stuga_media=hosted";
    expect(readMediaCookie(new Request("https://api.example.com/", { headers: { cookie: both } }))).toBe("hosted");
    expect(readMediaCookie(new Request("http://localhost:8787/", { headers: { cookie: both } }))).toBe("plain");
    expect(readMediaCookie(new Request("https://api.example.com/", { headers: { cookie: "stuga_media=plain" } }))).toBeNull();
  });

  it("is HttpOnly and Secure over https", () => {
    const header = mediaCookieHeader(httpsReq, { mediaCookieSameSite: "Lax" }, "tok", 7200);
    expect(header).toContain("__Host-stuga_media=tok");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=7200");
  });

  it("keeps CORP same-origin for a Lax or Strict cookie", () => {
    expect(mediaCorp({ mediaCookieSameSite: "Lax" })).toBe("same-origin");
    expect(mediaCorp({ mediaCookieSameSite: "Strict" })).toBe("same-origin");
  });

  it("honours an operator's SameSite=None and loosens CORP to match", () => {
    expect(mediaCookieHeader(httpsReq, { mediaCookieSameSite: "None" }, "tok", 7200)).toContain("SameSite=None");
    expect(mediaCorp({ mediaCookieSameSite: "None" })).toBe("cross-origin");
  });

  it("drops Secure (and None, which requires it) on plain http for local dev", () => {
    const header = mediaCookieHeader(httpReq, { mediaCookieSameSite: "None" }, "tok", 7200);
    expect(header).not.toContain("Secure");
    expect(header).toContain("SameSite=Lax");
  });

  it("clears with a zero max-age", () => {
    expect(clearMediaCookieHeader(httpsReq, { mediaCookieSameSite: "Lax" })).toContain("Max-Age=0");
  });

  it("reads one cookie out of a crowded header", () => {
    const req = new Request("https://api.example.com/", {
      headers: { cookie: "theme=dark; __Host-stuga_media=abc.def; other=1" },
    });
    expect(readCookie(req, "__Host-stuga_media")).toBe("abc.def");
    expect(readCookie(req, "missing")).toBeNull();
    expect(readCookie(new Request("https://api.example.com/"), "__Host-stuga_media")).toBeNull();
  });
});
