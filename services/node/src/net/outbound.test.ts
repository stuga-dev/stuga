import { describe, expect, it } from "vitest";
import { vetOutboundUrl } from "./outbound.js";

describe("vetOutboundUrl", () => {
  it.each(["http://[::1]:8787/x", "http://127.0.0.1/", "http://[::ffff:c0a8:101]/", "https://printer.local/", "http://nas.home.arpa/"])(
    "refuses %s without resolving anything",
    async (raw) => {
      expect(await vetOutboundUrl(raw)).toEqual({ ok: false, reason: "refusing to reach a private or loopback address" });
    },
  );

  it("allows a public address literal", async () => {
    const verdict = await vetOutboundUrl("https://8.8.8.8/image.png");
    expect(verdict.ok).toBe(true);
  });

  it("refuses a scheme other than http(s) and a relative URL", async () => {
    expect((await vetOutboundUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await vetOutboundUrl("/relative")).ok).toBe(false);
  });
});
