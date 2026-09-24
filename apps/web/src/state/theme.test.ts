// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

/** A controllable `prefers-color-scheme`, installed before theme.ts imports. */
const media = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { dark: false };
  return {
    state,
    flip(dark: boolean) {
      state.dark = dark;
      listeners.forEach((fn) => fn());
    },
    install() {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
          matches: query.includes("dark") && state.dark,
          media: query,
          addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
          removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
        }),
      });
    },
  };
});

media.install();

const { getTheme, getThemePreference, setThemePreference, applyTheme } = await import("./theme");

const painted = () => document.documentElement.getAttribute("data-theme");

beforeEach(() => {
  localStorage.clear();
  media.state.dark = false;
});

describe("theme preference", () => {
  it("defaults to following the system", () => {
    expect(getThemePreference()).toBe("system");
    media.state.dark = true;
    expect(getTheme()).toBe("dark");
    media.state.dark = false;
    expect(getTheme()).toBe("light");
  });

  it("repaints when the OS flips and the preference is system", () => {
    applyTheme();
    expect(painted()).toBe("light");
    media.flip(true);
    expect(painted()).toBe("dark");
  });

  it("ignores the OS once a theme is pinned, and can go back to system", () => {
    setThemePreference("light");
    media.flip(true);
    expect(painted()).toBe("light");
    expect(getThemePreference()).toBe("light");

    setThemePreference("system");
    expect(painted()).toBe("dark");
    expect(getTheme()).toBe("dark");
  });
});
