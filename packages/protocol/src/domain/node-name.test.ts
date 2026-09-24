import { describe, expect, it } from "vitest";
import { hasVisibleText, hostLabel, MCP_BUNDLE_FILENAME, MCP_SERVER_KEY, MCP_SERVER_TITLE, UNSAFE_TEXT } from "./node-name";

describe("hostLabel", () => {
  it.each([
    ["http://livs-air.local:8787", "livs-air"],
    ["http://Livs-Air.LOCAL:8787", "livs-air"],
    ["https://docs.example.com", "docs.example.com"],
    ["https://nd-7f3k2q.example.net:8443", "nd-7f3k2q.example.net"],
    ["http://localhost:8787", "localhost"],
    ["http://192.168.1.50:8787", "192.168.1.50"],
    ["http://[::1]:8787", "[::1]"],
  ])("%s → %s", (origin, label) => {
    expect(hostLabel(origin)).toBe(label);
  });

  it("keeps a host that is nothing but the mDNS suffix, and hands back what is not a URL", () => {
    expect(hostLabel("http://local:8787")).toBe("local");
    expect(hostLabel("not a url")).toBe("not a url");
  });
});

describe("UNSAFE_TEXT", () => {
  it("lets through the format characters ordinary names use", () => {
    for (const name of ["🏳\ufe0f\u200d🌈 Home", "Liv’s 👩\u200d💻 Studio", "می\u200cخواهم", "co\u00adop"]) {
      expect(UNSAFE_TEXT.test(name)).toBe(false);
    }
  });

  it("refuses control characters, the line and paragraph separators, and the marks that reorder text", () => {
    for (const name of ["a\nb", "a\u0000b", "a\u0085b", "a\u202eb", "a\u2066b", "a\u200fb", "a\ufeffb", "a\u2028b", "a\u2029b"]) {
      expect(UNSAFE_TEXT.test(name), JSON.stringify(name)).toBe(true);
    }
  });
});

describe("hasVisibleText", () => {
  it("finds something to show in ordinary names", () => {
    for (const name of ["Liv’s Mac", "家", "🏳\ufe0f\u200d🌈", "می\u200cخواهم", " x ", "e\u0301"]) {
      expect(hasVisibleText(name), JSON.stringify(name)).toBe(true);
    }
  });

  it("finds nothing in a name made only of invisible characters", () => {
    for (const name of ["", "   ", "\u200b", "\u200d\u200c", "\u00ad", "\u3164", "\u115f", "\u2800", "\u00a0\u3000", "\ufe0f", "\u0301"]) {
      expect(hasVisibleText(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("the one name a client stores this connection under", () => {
  it("is the product, with no node name, host or id in it", () => {
    expect(MCP_SERVER_KEY).toBe("stuga");
    expect(MCP_SERVER_TITLE).toBe("Stuga");
    expect(MCP_BUNDLE_FILENAME).toBe("stuga.mcpb");
  });
});
