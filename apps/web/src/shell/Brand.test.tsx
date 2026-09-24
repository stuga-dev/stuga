// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setAuthConfigForTest } from "../lib/session/auth-config";
import { Brand, nodeLabel, nodeName } from "./Brand";

function configure(node: { name?: string | null; label?: string | null }) {
  setAuthConfigForTest({
    nodeName: node.name ?? null,
    nodeLabel: node.label ?? node.name ?? null,
    branding: { accentColor: null },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Brand />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setAuthConfigForTest(null);
});

describe("nodeName", () => {
  it("is the name an administrator gave the node", () => {
    configure({ name: "Acme" });
    expect(nodeName()).toBe("Acme");
  });

  it("is the product's own name until the node has one, never the host it is reached at", () => {
    configure({ name: null, label: "livs-air" });
    expect(nodeName()).toBe("Stuga");
  });
});

describe("nodeLabel", () => {
  it("tells nodes apart: the name, else the host the node reports", () => {
    configure({ name: "Acme" });
    expect(nodeLabel()).toBe("Acme");
    configure({ name: null, label: "livs-air" });
    expect(nodeLabel()).toBe("livs-air");
  });

  it("falls back to what the brand slot shows when the node's config could not be fetched", () => {
    setAuthConfigForTest(null);
    expect(nodeLabel()).toBe("Stuga");
  });
});

describe("<Brand />", () => {
  it("is Stuga's mark in the square, decorative, whatever the node is called", () => {
    for (const name of [null, "Acme"]) {
      configure({ name });
      const el = render().querySelector("span.brand__mark")!;
      // The wordmark beside it names the node.
      expect(el.textContent).toBe("");
      expect(el.querySelector("svg.brand__glyph")!.getAttribute("aria-hidden")).toBe("true");
      act(() => root!.unmount());
      host!.remove();
      root = null;
      host = null;
    }
  });
});
