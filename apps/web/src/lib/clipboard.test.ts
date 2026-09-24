// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, installClipboardFallback } from "./clipboard";

function setClipboard(value: { writeText: (t: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

describe("copyText", () => {
  afterEach(() => {
    setClipboard(undefined);
    // jsdom has no execCommand of its own.
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("uses the Clipboard API where it exists", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a selection copy on an insecure origin, and leaves nothing behind", async () => {
    setClipboard(undefined);
    let selected = "";
    document.execCommand = vi.fn(() => {
      selected = (document.activeElement as HTMLTextAreaElement | null)?.value ?? "";
      return true;
    });
    expect(await copyText("http://livs-air.local:8787/join/inv_x")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(selected).toBe("http://livs-air.local:8787/join/inv_x");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("selects inside an open dialog, since a modal one makes the rest of the page inert", async () => {
    setClipboard(undefined);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    let host: Element | null = null;
    document.execCommand = vi.fn(() => {
      host = document.activeElement?.parentElement ?? null;
      return true;
    });
    try {
      expect(await copyText("x")).toBe(true);
      expect(host).toBe(dialog);
      expect(dialog.querySelector("textarea")).toBeNull();
    } finally {
      dialog.remove();
    }
  });

  it("falls back when the Clipboard API rejects, and reports a copy nothing could make", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    document.execCommand = vi.fn(() => false);
    expect(await copyText("x")).toBe(false);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});

describe("installClipboardFallback", () => {
  it("stands in for the Clipboard API a plain-http origin does not get", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);

    installClipboardFallback();

    // Astryx's own copy buttons reach for this directly, so it has to exist.
    expect(typeof navigator.clipboard.writeText).toBe("function");
    await expect(navigator.clipboard.writeText("hello")).resolves.toBeUndefined();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("rejects when even the selection copy fails, so a caller still sees the failure", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);

    installClipboardFallback();

    await expect(navigator.clipboard.writeText("hello")).rejects.toThrow();
  });

  it("leaves a real Clipboard API alone", () => {
    const real = { writeText: vi.fn(async () => {}) };
    setClipboard(real);

    installClipboardFallback();

    expect(navigator.clipboard).toBe(real);
  });
});
