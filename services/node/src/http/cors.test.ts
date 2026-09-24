import { describe, expect, it } from "vitest";
import { allowedCorsOrigin, withCors } from "./cors.js";
import { json } from "./respond.js";
import { REQUEST_HOST_HEADER } from "../platform/http-server.js";

describe("CORS", () => {
  const env = { publicOrigin: "https://public.example.test", extraOrigins: [] };
  const ask = (origin: string, e: { publicOrigin: string; extraOrigins: readonly string[] } = env) =>
    allowedCorsOrigin(new Request("https://public.example.test/api/docs", { headers: { origin } }), e);

  it("allows the public origin", () => {
    expect(ask("https://public.example.test")).toBe("https://public.example.test");
  });

  it("refuses any other origin, including the host the request names", () => {
    expect(ask("https://attacker.example.test")).toBeNull();
    const req = new Request("https://api.example.test/api/docs", { headers: { origin: "https://api.example.test" } });
    expect(allowedCorsOrigin(req, env)).toBeNull();
  });

  it("answers null when no Origin was sent", () => {
    expect(allowedCorsOrigin(new Request("https://public.example.test/api/docs"), env)).toBeNull();
  });

  describe("extraOrigins", () => {
    const withExtra = { ...env, extraOrigins: ["http://localhost:8787"] };

    it("allows a listed origin, and still allows the public one", () => {
      expect(ask("http://localhost:8787", withExtra)).toBe("http://localhost:8787");
      expect(ask("https://public.example.test", withExtra)).toBe("https://public.example.test");
    });

    it("matches exactly: no suffix, port or scheme is implied", () => {
      expect(ask("http://localhost:8788", withExtra)).toBeNull();
      expect(ask("https://localhost:8787", withExtra)).toBeNull();
      expect(ask("http://evil.localhost:8787", withExtra)).toBeNull();
      expect(ask("http://localhost:8787.evil.test", withExtra)).toBeNull();
    });

    it("changes nothing when absent", () => {
      expect(ask("http://localhost:8787")).toBeNull();
    });
  });

  describe("the address the request went to, on a local network", () => {
    const lan = { publicOrigin: "http://livs-air.local:8787", extraOrigins: [] };
    const sent = (origin: string, host: string) =>
      allowedCorsOrigin(
        new Request("http://livs-air.local:8787/api/docs", { headers: { origin, [REQUEST_HOST_HEADER]: host } }),
        lan,
      );

    it("allows a page served at the node's IP address, or a local name, calling that same address", () => {
      expect(sent("http://192.168.1.50:8787", "192.168.1.50:8787")).toBe("http://192.168.1.50:8787");
      expect(sent("http://[fd00::5]:8787", "[fd00::5]:8787")).toBe("http://[fd00::5]:8787");
      expect(sent("http://studio.local:8787", "Studio.local:8787")).toBe("http://studio.local:8787");
      expect(sent("http://localhost:8787", "localhost:8787")).toBe("http://localhost:8787");
      expect(sent("http://nas.home.arpa", "nas.home.arpa")).toBe("http://nas.home.arpa");
    });

    it("refuses a public name, which could be a stranger's pointed at this node", () => {
      expect(sent("http://evil.example:8787", "evil.example:8787")).toBeNull();
    });

    it("refuses a page from any other address, port or scheme than the one the request went to", () => {
      expect(sent("http://192.168.1.66:8787", "192.168.1.50:8787")).toBeNull();
      expect(sent("http://192.168.1.50:9999", "192.168.1.50:8787")).toBeNull();
      expect(sent("https://192.168.1.50:8787", "192.168.1.50:8787")).toBeNull();
      expect(sent("null", "192.168.1.50:8787")).toBeNull();
    });

    it("refuses without the Host the server stamped", () => {
      const req = new Request("http://livs-air.local:8787/api/docs", { headers: { origin: "http://192.168.1.50:8787" } });
      expect(allowedCorsOrigin(req, lan)).toBeNull();
    });
  });

  it("emits CORS only for an allowed exact origin", () => {
    const response = withCors(json({ ok: true }), "https://public.example.test");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://public.example.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toBe("Origin");

    const sameOrigin = withCors(json({ ok: true }), null);
    expect(sameOrigin.headers.has("access-control-allow-origin")).toBe(false);
    expect(sameOrigin.headers.has("access-control-allow-credentials")).toBe(false);
    expect(sameOrigin.headers.get("vary")).toBe("Origin");
    expect(withCors(new Response(null, { status: 204 }), null).headers.has("access-control-allow-origin")).toBe(false);
  });
});
