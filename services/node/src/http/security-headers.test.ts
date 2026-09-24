import { describe, expect, it } from "vitest";
import { applySecurityHeaders, withSecurityHeaders } from "./security-headers.js";
import { CONSENT_PATH } from "../mcp/oauth.js";

const at = (path: string, init?: RequestInit) => new Request(`https://node.example.test${path}`, init);

describe("applySecurityHeaders", () => {
  it("stamps the frame, referrer and sniffing policy on a response that sets none", () => {
    const res = applySecurityHeaders(at("/docs/abc"), new Response("<!doctype html>"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves a policy the handler chose exactly as it found it", () => {
    const media = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
    const res = applySecurityHeaders(at(`/api/docs/d1/media/${"a".repeat(64)}`), media);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers with the same response object, so an upgrade keeps its socket", () => {
    const original = new Response(null, { status: 200 });
    expect(applySecurityHeaders(at("/ws/doc1"), original)).toBe(original);
  });

  describe("the consent screen", () => {
    it("denies framing even when the handler asked for something looser", () => {
      const handlerSaid = new Response("<!doctype html>", {
        headers: {
          "x-frame-options": "SAMEORIGIN",
          "content-security-policy": "frame-ancestors https://agent.example.test",
        },
      });
      const res = applySecurityHeaders(at(`${CONSENT_PATH}?client_id=abc`), handlerSaid);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp.split(",").map((policy) => policy.trim())).toContain("frame-ancestors 'none'");
      expect(csp).toContain("frame-ancestors https://agent.example.test");
    });

    it("holds on the POST the app submits as well as the page a person opens", () => {
      for (const method of ["GET", "POST"]) {
        const res = applySecurityHeaders(
          at(CONSENT_PATH, { method }),
          new Response(null, { headers: { "x-frame-options": "SAMEORIGIN" } }),
        );
        expect(res.headers.get("x-frame-options")).toBe("DENY");
      }
    });
  });
});

describe("withSecurityHeaders", () => {
  it("stamps whatever the wrapped handler answers, refusals included", async () => {
    const handler = withSecurityHeaders(async () => new Response("not found", { status: 404 }));
    const res = await handler(at("/nope"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });
});
