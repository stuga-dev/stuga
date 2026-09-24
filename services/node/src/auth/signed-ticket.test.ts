import { describe, expect, it } from "vitest";
import { b64urlDecodeText, b64urlEncodeText, signTicket } from "./signed-ticket.js";

const SECRET = "node-internal-secret";

describe("signTicket", () => {
  it("separates the kinds: one payload, one secret, two labels, two signatures", () => {
    const payload = "abc.def.1700000000";
    expect(signTicket(SECRET, "stuga/media-ticket/v1", payload)).not.toBe(signTicket(SECRET, "stuga/ws-ticket/v1", payload));
  });

  it("is a function of the secret, so another node's ticket does not verify here", () => {
    const payload = "ws1.abc.def.ghi.w.1700000000";
    expect(signTicket(SECRET, "stuga/ws-ticket/v1", payload)).not.toBe(
      signTicket("a-different-secret", "stuga/ws-ticket/v1", payload),
    );
  });

  it("is HMAC-SHA256 under HMAC-SHA256(secret, domain), as unpadded base64url", async () => {
    const enc = new TextEncoder();
    const hmac = async (key: BufferSource, data: string) =>
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
          enc.encode(data),
        ),
      );
    const derived = await hmac(enc.encode(SECRET), "stuga/ws-ticket/v1");
    const expected = Buffer.from(await hmac(derived, "payload")).toString("base64url");
    expect(signTicket(SECRET, "stuga/ws-ticket/v1", "payload")).toBe(expected);
  });
});

describe("the text codec", () => {
  it("round-trips non-ASCII, which an alias may be", () => {
    expect(b64urlDecodeText(b64urlEncodeText("用户 alice+β"))).toBe("用户 alice+β");
  });

  it("answers null for input that is not base64url rather than throwing", () => {
    expect(b64urlDecodeText("!!!not base64!!!")).toBeNull();
    expect(b64urlDecodeText("abcde")).toBeNull();
  });
});
