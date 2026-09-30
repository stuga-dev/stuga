// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { nodeLink, setAuthConfigForTest } from "./auth-config";

afterEach(() => setAuthConfigForTest(null));

describe("nodeLink", () => {
  it("names the node's own address, not the loopback one this browser used", () => {
    setAuthConfigForTest({ origin: "http://livs-air.local:8787" });
    expect(nodeLink("/d/abc?row=1#h")).toBe("http://livs-air.local:8787/d/abc?row=1#h");
  });

  it("falls back to this page's address when the node's is unknown", () => {
    setAuthConfigForTest(null);
    expect(nodeLink("/d/abc")).toBe(`${window.location.origin}/d/abc`);
  });
});
