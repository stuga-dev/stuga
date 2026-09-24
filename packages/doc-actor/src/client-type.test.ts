import { describe, it, expect } from "vitest";
import { bucketClientType, CLIENT_TYPES, type ClientType } from "./client-type.js";

describe("bucketClientType", () => {
  it("maps a missing/empty agent to browser (a human tab)", () => {
    expect(bucketClientType(undefined)).toBe("browser");
    expect(bucketClientType(null)).toBe("browser");
    expect(bucketClientType("")).toBe("browser");
  });

  it("maps known agent families case-insensitively, as substrings", () => {
    expect(bucketClientType("claude-code")).toBe("claude");
    expect(bucketClientType("Claude Desktop")).toBe("claude");
    expect(bucketClientType("Cursor 0.42")).toBe("cursor");
    expect(bucketClientType("github-copilot")).toBe("copilot");
    expect(bucketClientType("Kiro")).toBe("kiro");
    expect(bucketClientType("mcp-agent")).toBe("mcp");
  });

  it("collapses an arbitrary/unknown label to a single 'other' bucket (no cardinality bomb)", () => {
    expect(bucketClientType("totally-made-up-1234")).toBe("other");
    expect(bucketClientType("😈 injected label")).toBe("other");
    // Two different unknown labels land in the SAME bucket.
    expect(bucketClientType("attacker-a")).toBe(bucketClientType("attacker-b"));
  });

  it("only ever returns a value in the fixed allowlist", () => {
    const set = new Set<ClientType>(CLIENT_TYPES);
    for (const label of [undefined, "", "claude", "x", "MCP thing", "cursor", "copilot", "kiro", "weird"]) {
      expect(set.has(bucketClientType(label as string | undefined))).toBe(true);
    }
  });
});
