import { describe, expect, it } from "vitest";
import {
  MEDIA_COOKIE,
  clearMediaCookieHeader,
  mediaCookieHeader,
  mediaCorp,
  mintMediaTicket,
  readCookie,
  verifyMediaTicket,
} from "./media-auth.js";

const SECRET = "internal-secret-value";
const NOW = 1_760_000_000_000;
const WS = "ws-AbC123xyz789";

describe("media ticket", () => {
  it("round-trips the alias and workspace it was minted for", async () => {
    const { value, expiresAt } = await mintMediaTicket(SECRET, "user-abc", WS, NOW);
    const ticket = await verifyMediaTicket(SECRET, value, NOW);
    expect(ticket?.alias).toBe("user-abc");
    expect(ticket?.workspaceId).toBe(WS);
    expect(ticket?.expiresAt).toBe(expiresAt);
  });

  it("refuses a ticket whose signed workspace was edited", async () => {
    const { value } = await mintMediaTicket(SECRET, "user-abc", WS, NOW);
    const [alias, , exp, sig] = value.split(".");
    const other = btoa("ws-otherTenant").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyMediaTicket(SECRET, `${alias}.${other}.${exp}.${sig}`, NOW)).toBeNull();
  });

  it("rejects a workspace id that could escape its media prefix", async () => {
    const { value } = await mintMediaTicket(SECRET, "user-abc", "../trash", NOW);
    expect(await verifyMediaTicket(SECRET, value, NOW)).toBeNull();
  });

  it("survives an alias that is not URL-safe", async () => {
    const alias = "user+/=?ü";
    const { value } = await mintMediaTicket(SECRET, alias, WS, NOW);
    expect(value).not.toContain("+");
    expect((await verifyMediaTicket(SECRET, value, NOW))?.alias).toBe(alias);
  });

  it("rejects a ticket signed with a different secret", async () => {
    const { value } = await mintMediaTicket(SECRET, "user-abc", WS, NOW);
    expect(await verifyMediaTicket("some-other-secret", value, NOW)).toBeNull();
  });

  it("rejects a tampered alias or expiry", async () => {
    const { value } = await mintMediaTicket(SECRET, "user-abc", WS, NOW);
    const [alias, ws, exp, sig] = value.split(".");
    expect(await verifyMediaTicket(SECRET, `${alias}.${ws}.${Number(exp) + 86_400}.${sig}`, NOW)).toBeNull();
    expect(await verifyMediaTicket(SECRET, `${alias}X.${ws}.${exp}.${sig}`, NOW)).toBeNull();
  });

  it("expires", async () => {
    const { value, expiresAt } = await mintMediaTicket(SECRET, "user-abc", WS, NOW, 60);
    expect(await verifyMediaTicket(SECRET, value, expiresAt * 1000 - 1_000)).not.toBeNull();
    expect(await verifyMediaTicket(SECRET, value, expiresAt * 1000 + 1_000)).toBeNull();
  });

  it("rejects junk without throwing", async () => {
    for (const junk of ["", "abc", "a.b", "a.b.1.c.d", "a.b.notanumber.c", "...", null, undefined]) {
      expect(await verifyMediaTicket(SECRET, junk, NOW)).toBeNull();
    }
  });
});

describe("cookie transport", () => {
  const httpsReq = new Request("https://api.example.com/api/media/ticket");
  const httpReq = new Request("http://localhost:8787/api/media/ticket");

  it("is HttpOnly and Secure over https", () => {
    const header = mediaCookieHeader(httpsReq, { mediaCookieSameSite: "Lax" }, "tok", 7200);
    expect(header).toContain(`${MEDIA_COOKIE}=tok`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=7200");
  });

  it("keeps CORP same-site for a Lax or Strict cookie", () => {
    expect(mediaCorp({ mediaCookieSameSite: "Lax" })).toBe("same-site");
    expect(mediaCorp({ mediaCookieSameSite: "Strict" })).toBe("same-site");
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
      headers: { cookie: `theme=dark; ${MEDIA_COOKIE}=abc.def; other=1` },
    });
    expect(readCookie(req, MEDIA_COOKIE)).toBe("abc.def");
    expect(readCookie(req, "missing")).toBeNull();
    expect(readCookie(new Request("https://api.example.com/"), MEDIA_COOKIE)).toBeNull();
  });
});
