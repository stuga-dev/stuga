import { describe, expect, it } from "vitest";
import { extractToken } from "./verify.js";

describe("extractToken", () => {
  it("accepts the bearer scheme case-insensitively", () => {
    const req = new Request("https://api.example.test", {
      headers: { authorization: "bEaReR token-value" },
    });
    expect(extractToken(req)).toBe("token-value");
  });

  it("does not treat cookies as authentication", () => {
    const req = new Request("https://api.example.test", {
      headers: { cookie: "stuga_token=cookie-secret" },
    });
    expect(extractToken(req)).toBeNull();
  });

  it("ignores an access_token query parameter, even on a WebSocket upgrade", () => {
    const url = "https://api.example.test/ws/doc?access_token=query-secret";
    expect(extractToken(new Request(url))).toBeNull();
    expect(extractToken(new Request(url, { headers: { upgrade: "websocket" } }))).toBeNull();
  });

  it("rejects malformed and empty bearer values", () => {
    expect(extractToken(new Request("https://api.example.test", { headers: { authorization: "Bearer" } }))).toBeNull();
    expect(
      extractToken(new Request("https://api.example.test", { headers: { authorization: "Bearer token extra" } })),
    ).toBeNull();
  });
});
