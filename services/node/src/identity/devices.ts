/**
 * The browsers a person has signed in from (docs/privacy.md). Each signed-in browser holds a cookie of
 * 32 random bytes, kept for 400 days, of which the node stores only the sha-256, per account and per
 * listener: `__Host-stuga-device` at the remote address (HttpOnly, Secure, SameSite=Strict, Path=/),
 * and `stuga-device-local` on the node's own network, which is plain http, so it can be neither
 * Secure nor `__Host-`. A browser an account signed in from before keeps its own count of wrong
 * passwords, so guesses made elsewhere never pause it (./sign-in-limits.ts); one new to an account
 * at the remote address is reported (./alerts.ts). The cookie is used for nothing else.
 */
import { randomBase64url, sha256Hex } from "@stuga/auth";
import type { CredentialArrival } from "@stuga/db";
import { readCookies } from "./http.js";

export const REMOTE_DEVICE_COOKIE = "__Host-stuga-device";
export const LOCAL_DEVICE_COOKIE = "stuga-device-local";
/** As long as a browser keeps a cookie at most; a device not seen for as long is forgotten. */
export const DEVICE_COOKIE_DAYS = 400;

/** 32 random bytes, base64url. */
const DEVICE_VALUE = /^[A-Za-z0-9_-]{43}$/;

export function deviceCookieName(arrival: CredentialArrival): string {
  return arrival === "remote" ? REMOTE_DEVICE_COOKIE : LOCAL_DEVICE_COOKIE;
}

/**
 * The device cookie this browser presents at `arrival`, or null when it has none, a malformed one, or
 * more than one: a second cookie of the name was planted, and which one is its own cannot be told.
 */
export function readDeviceCookie(req: Request, arrival: CredentialArrival): string | null {
  const values = readCookies(req, deviceCookieName(arrival));
  return values.length === 1 && DEVICE_VALUE.test(values[0]!) ? values[0]! : null;
}

/** A new browser's cookie value. */
export function newDeviceValue(): string {
  return randomBase64url(32);
}

/** What the node keeps of a cookie value. */
export function deviceHash(value: string): string {
  return sha256Hex(value);
}

/** The Set-Cookie for a browser's device cookie at `arrival`. */
export function deviceCookie(arrival: CredentialArrival, value: string): string {
  const attrs = [`${deviceCookieName(arrival)}=${value}`, "Path=/", `Max-Age=${DEVICE_COOKIE_DAYS * 24 * 60 * 60}`, "HttpOnly", "SameSite=Strict"];
  if (arrival === "remote") attrs.push("Secure");
  return attrs.join("; ");
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\b(?:Macintosh|Mac OS X)\b/, "Mac"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

/** The browser and the system a User-Agent names, each null when it names none this knows. */
export function browserAndSystem(userAgent: string | null): { browser: string | null; system: string | null } {
  const ua = userAgent ?? "";
  return {
    browser: BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null,
    system: SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null,
  };
}

/** A browser as a person would name it, from its User-Agent: "Safari on iPhone". At most 64 characters. */
export function deviceLabel(userAgent: string | null): string {
  const { browser, system } = browserAndSystem(userAgent);
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `A browser on ${system}`;
  return "Unknown browser";
}

const APPLE = new Set(["iPhone", "iPad", "Mac"]);

/**
 * What the node calls a passkey it just added, from the authenticator and the browser (T21): a synced
 * one by where it lives ("iCloud Keychain", "Google Password Manager", else "Synced · Firefox"), so
 * someone who lost a phone does not remove a passkey their laptop shares; a device-bound one by the
 * device ("iPhone", "Windows · Edge"), or "Security key" when only USB or NFC reach it.
 */
export function passkeyName(input: { backupEligible: boolean; transports: readonly string[]; userAgent: string | null }): string {
  const { browser, system } = browserAndSystem(input.userAgent);
  if (input.backupEligible) {
    if (system && APPLE.has(system) && (browser === "Safari" || system !== "Mac")) return "iCloud Keychain";
    if (system === "Android") return "Google Password Manager";
    return browser ? `Synced · ${browser}` : "Synced passkey";
  }
  const reach = new Set(input.transports);
  if (reach.size > 0 && [...reach].every((t) => t === "usb" || t === "nfc")) return "Security key";
  if (system === "iPhone" || system === "iPad") return system;
  if (system && browser) return `${system} · ${browser}`;
  return system ?? browser ?? "Passkey";
}
