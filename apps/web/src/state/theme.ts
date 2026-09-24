/**
 * The light/dark theme. "system" is a stored choice of its own, followed live as
 * the OS switches; the painted theme is written to <html data-theme>.
 */
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "../lib/storage";
import { createStore } from "../lib/store";

export type ThemePreference = "system" | "light" | "dark";
/** What is actually painted. */
export type Theme = "light" | "dark";
const KEY = "stuga_theme";
/** Bumped on every change to the preference or, while following the system, to the OS setting. */
const changes = createStore(0);

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getThemePreference(): ThemePreference {
  const saved = readStored("local", KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export function getTheme(): Theme {
  const pref = getThemePreference();
  return pref === "system" ? systemTheme() : pref;
}

export function applyTheme(t: Theme = getTheme()): void {
  document.documentElement.setAttribute("data-theme", t);
}

export function setThemePreference(pref: ThemePreference): void {
  writeStored("local", KEY, pref);
  applyTheme();
  changes.update((n) => n + 1);
}

// Registered once at import, which main.tsx does before first paint.
window
  .matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener?.("change", () => {
    if (getThemePreference() !== "system") return;
    applyTheme();
    changes.update((n) => n + 1);
  });

export function useThemeMode(): Theme {
  return useSyncExternalStore(changes.subscribe, getTheme, getTheme);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(changes.subscribe, getThemePreference, getThemePreference);
}
